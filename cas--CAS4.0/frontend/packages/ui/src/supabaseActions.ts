import type { Advisory, Portal, ServiceReport, SMSRecord, Status, WorkOrder } from "./domainTypes.js";
import { getSupabase, profileActor, raiseSupabaseError, type SupabaseProfile } from "./supabase.js";

type ActionOptions = RequestInit;
const PROFILE_COLUMNS = "id,name,email,role,utility,phone_number,address,barangay,purok,district,city,postal_code,profile_image,sms_alerts,notify_maintenance,notify_email_digest,immediate_email_alerts";

function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    value,
  ]));
}

function advisoryFromRow(row: Record<string, unknown>): Advisory {
  const channels = Array.isArray(row.channels)
    ? row.channels.filter((channel): channel is string => typeof channel === "string")
    : [];
  return {
    id: Number(row.id),
    reference: String(row.reference ?? ""),
    title: String(row.title ?? ""),
    utility: String(row.utility ?? ""),
    type: String(row.type ?? ""),
    area: String(row.area ?? ""),
    status: String(row.status ?? "Active") as Status,
    details: String(row.details ?? ""),
    location: String(row.location ?? ""),
    serviceStatus: String(row.service_status ?? "Upcoming Maintenance Interruption"),
    provider: String(row.provider ?? ""),
    createdAt: String(row.created_at ?? ""),
    scheduledAt: row.scheduled_at == null ? null : String(row.scheduled_at),
    priority: typeof row.priority === "string" ? row.priority : undefined,
    serviceStartsAt: row.service_starts_at == null ? null : String(row.service_starts_at),
    estimatedRestorationAt: row.estimated_restoration_at == null ? null : String(row.estimated_restoration_at),
    publicationStatus: typeof row.publication_status === "string" ? row.publication_status as Advisory["publicationStatus"] : undefined,
    channels,
    imageUrl: null,
    imageUrls: [],
  };
}

function storedAnnouncementImages(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) {
    if (!value.every(image => typeof image === "string")) throw new Error("Stored announcement images are invalid.");
    return value;
  }
  if (typeof value !== "string") throw new Error("Stored announcement images are invalid.");
  if (value.startsWith("[")) {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(image => typeof image === "string")) {
      throw new Error("Stored announcement images are invalid.");
    }
    return parsed;
  }
  return [value];
}

export async function loadAdvisoryImages(advisoryId: number): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from("advisories")
    .select("image_data_url")
    .eq("id", advisoryId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return storedAnnouncementImages(data?.image_data_url);
}

export async function supabaseAction<T>(
  portal: Portal,
  path: string,
  options: ActionOptions,
): Promise<T> {
  const supabase = getSupabase();
  const method = options.method ?? "GET";
  const body = options.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
  const utility = portal === "cepalco" ? "CEPALCO" : portal === "water" ? "Water District" : null;
  const profileForPortal = async (): Promise<SupabaseProfile> => {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) throw new Error(error?.message || "Please sign in to continue.");
    const { data, error: profileError } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", user.id).single();
    if (profileError) throw new Error(profileError.message);
    const profile = data as SupabaseProfile;
    if (portal === "resident" ? profile.role !== "resident" : profile.role !== "admin" || profile.utility !== utility) {
      throw new Error("This account is not authorized for this portal.");
    }
    return profile;
  };
  const recordActivity = async (action: string, advisoryId: number, summary: string) => {
    if (!utility) return;
    try {
      const actor = await profileForPortal();
      const { error } = await supabase.from("activity_logs").insert({
        utility,
        actor_id: actor.id,
        advisory_id: advisoryId,
        action,
        summary,
      });
      if (error) throw new Error(error.message);
    } catch (error) {
      // Audit logging is secondary to dispatch. A pending migration must not
      // leave an advisory saved but prevent its providers from being called.
      console.error("Could not record advisory activity. Apply the activity_logs migration.", error);
    }
  };

  if (path === "/activity" && method === "GET") {
    await profileForPortal();
    const { data, error } = await supabase.from("activity_logs").select("id,utility,advisory_id,action,summary,created_at")
      .eq("utility", utility).order("id", { ascending: false }).limit(40);
    raiseSupabaseError(error);
    return (data ?? []).map(row => toCamel(row as Record<string, unknown>)) as T;
  }

  if (path === "/auth/login" && method === "POST") {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: String(body.email ?? "").trim(),
      password: String(body.password ?? ""),
    });
    if (error || !data.user || !data.session) throw new Error(error?.message || "Sign in failed.");
    const { data: profile, error: profileError } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", data.user.id).single();
    if (profileError) throw new Error(profileError.message);
    const actor = profileActor(profile as SupabaseProfile);
    if (portal === "resident" ? actor.role !== "resident" : actor.role !== "admin" || actor.utility !== utility) {
      await supabase.auth.signOut();
      throw new Error("This account is not authorized for this portal.");
    }
    return { token: data.session.access_token, actor } as T;
  }

  if (path === "/auth/register" && method === "POST") {
    const { data, error } = await supabase.auth.signUp({
      email: String(body.email ?? "").trim().toLowerCase(),
      password: String(body.password ?? ""),
      options: { data: { name: String(body.name ?? "").trim() } },
    });
    if (error) throw new Error(error.message);
    if (!data.user || !data.session) {
      throw new Error("Check your email to confirm your account, then sign in. If confirmation is disabled, check the Supabase Auth settings.");
    }
    const { error: profileError } = await supabase.from("profiles").update({
      name: String(body.name ?? "").trim(),
      phone_number: String(body.phoneNumber ?? ""),
      address: String(body.address ?? ""),
      barangay: String(body.barangay ?? ""),
      purok: String(body.purok ?? "") || null,
      district: String(body.district ?? ""),
      city: String(body.city ?? ""),
      postal_code: String(body.postalCode ?? ""),
      sms_alerts: body.smsAlerts !== false,
      immediate_email_alerts: body.immediateEmailAlerts === true,
      terms_accepted_at: new Date().toISOString(),
    }).eq("id", data.user.id);
    raiseSupabaseError(profileError);
    const { data: profile, error: readError } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", data.user.id).single();
    if (readError) throw new Error(readError.message);
    return { token: data.session.access_token, actor: profileActor(profile as SupabaseProfile) } as T;
  }

  if (path === "/auth/me") return { actor: profileActor(await profileForPortal()) } as T;

  if (path === "/auth/profile" && method === "PATCH") {
    const profile = await profileForPortal();
    if (typeof body.email === "string" && body.email.trim().toLowerCase() !== profile.email.toLowerCase()) {
      throw new Error("Changing your email is not supported from this profile form. Keep the email connected to your Supabase Auth account.");
    }
    const { error } = await supabase.from("profiles").update({
      name: body.name,
      phone_number: body.phoneNumber,
      address: body.address,
      barangay: body.barangay,
      purok: body.purok || null,
      district: body.district,
      city: body.city,
      postal_code: body.postalCode,
      profile_image: body.profileImage,
      sms_alerts: body.smsAlerts,
      notify_maintenance: body.maintenanceAlerts,
      notify_email_digest: body.emailDigest,
      immediate_email_alerts: body.immediateEmailAlerts,
    }).eq("id", profile.id);
    raiseSupabaseError(error);
    const { data, error: readError } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", profile.id).single();
    if (readError) throw new Error(readError.message);
    return { actor: profileActor(data as SupabaseProfile) } as T;
  }

  if (path === "/auth/password" && method === "POST") {
    const profile = await profileForPortal();
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: profile.email,
      password: String(body.currentPassword ?? ""),
    });
    if (verifyError) throw new Error("Current password is incorrect.");
    const { error } = await supabase.auth.updateUser({ password: String(body.newPassword ?? "") });
    raiseSupabaseError(error);
    return { ok: true } as T;
  }

  if (path === "/advisories" && method === "GET") {
    const links = new Map<number, Record<string, string>>();
    const advisories: Record<string, unknown>[] = [];
    const pageSize = 100;
    for (let from = 0; ; from += pageSize) {
      let query = supabase.from("advisories")
        .select("id,reference,title,utility,type,area,status,details,location,service_status,provider,priority,service_starts_at,estimated_restoration_at,created_at,latitude,longitude,scheduled_at,publication_status,channels")
        .order("id", { ascending: false })
        .range(from, from + pageSize - 1);
      if (utility) query = query.eq("utility", utility);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Record<string, unknown>[];
      advisories.push(...rows);
      const ids = rows.map(row => Number(row.id));
      if (ids.length) {
        const { data: posts, error: postError } = await supabase.from("social_posts")
          .select("advisory_id,platform,permalink_url")
          .in("advisory_id", ids);
        if (postError) throw new Error(postError.message);
        for (const post of posts ?? []) {
          const existing = links.get(post.advisory_id) ?? {};
          existing[post.platform] = post.permalink_url ?? "";
          links.set(post.advisory_id, existing);
        }
      }
      if (rows.length < pageSize) break;
    }
    return advisories.map(row => ({
      ...advisoryFromRow(row),
      facebookUrl: links.get(Number(row.id))?.facebook || null,
      instagramUrl: links.get(Number(row.id))?.instagram || null,
    })) as Advisory[] as T;
  }

  if (path === "/advisories" && method === "POST") {
    await profileForPortal();
    const scheduledAt = String(body.scheduledAt ?? "") || null;
    const { data, error } = await supabase.from("advisories").insert({
      reference: `${portal === "water" ? "WD" : "CE"}-${Date.now().toString(36).toUpperCase()}`,
      title: body.title,
      utility,
      type: body.type ?? "Service disruption",
      area: body.area,
      details: body.details,
      location: body.location ?? "",
      service_status: body.serviceStatus ?? "Upcoming Maintenance Interruption",
      provider: body.provider ?? "",
      status: scheduledAt ? "Scheduled" : "Active",
      priority: body.priority ?? "Normal",
      service_starts_at: body.serviceStartsAt || null,
      estimated_restoration_at: body.estimatedRestorationAt || null,
      image_data_url: Array.isArray(body.imageDataUrls)
        ? body.imageDataUrls.length === 1 ? body.imageDataUrls[0] : JSON.stringify(body.imageDataUrls)
        : body.imageDataUrl || null,
      latitude: body.latitude || null,
      longitude: body.longitude || null,
      scheduled_at: scheduledAt,
      publication_status: scheduledAt ? "scheduled" : "published",
      channels: body.channels ?? [],
    }).select("id,reference,title,utility,type,area,status,details,location,service_status,provider,priority,service_starts_at,estimated_restoration_at,created_at,latitude,longitude,scheduled_at,publication_status,channels").single();
    if (error) throw new Error(error.message);
    await recordActivity(scheduledAt ? "Advisory scheduled" : "Advisory prepared", Number(data.id), `${String(body.title)} — ${String(body.area)}; channels: ${(body.channels as string[] | undefined)?.join(", ") ?? "none"}.`);
    let delivery: Record<string, unknown> | null = null;
    {
      const apiBaseUrl = ({
        resident: import.meta.env.VITE_RESIDENT_API_URL || "http://localhost:4101",
        cepalco: import.meta.env.VITE_CEPALCO_API_URL || "http://localhost:4102",
        water: import.meta.env.VITE_WATER_API_URL || "http://localhost:4103",
      })[portal].replace(/\/+$/, "");
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Your Supabase session expired after the advisory was saved. Sign in again to send it.");
      const response = await fetch(`${apiBaseUrl}/advisories/${data.id}/deliver`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const deliveryResult: unknown = await response.json();
      if (!response.ok) {
        const message = deliveryResult && typeof deliveryResult === "object" && "error" in deliveryResult
          ? String(deliveryResult.error)
          : `Provider delivery failed with status ${response.status}.`;
        throw new Error(`Advisory was saved in Supabase, but provider delivery failed: ${message}`);
      }
      delivery = deliveryResult as Record<string, unknown>;
      await recordActivity("Notification dispatch results", Number(data.id), JSON.stringify({
        email: delivery.emailDelivery ?? null,
        social: delivery.socialDelivery ?? null,
        simulatedSmsRecords: delivery.smsQueued ?? 0,
      }));
    }
    return {
      ...toCamel(data),
      channels: data.channels,
      emailDelivery: delivery?.emailDelivery ?? null,
      socialDelivery: delivery?.socialDelivery ?? null,
      socialLinks: delivery?.socialLinks ?? [],
      smsQueued: delivery?.smsQueued ?? 0,
    } as T;
  }

  const advisoryStatus = path.match(/^\/advisories\/(\d+)\/status$/);
  if (advisoryStatus && method === "PATCH") {
    await profileForPortal();
    const { error, count } = await supabase.from("advisories").update({ status: body.status }, { count: "exact" })
      .eq("id", Number(advisoryStatus[1])).eq("utility", utility);
    if (error) throw new Error(error.message);
    if (!count) throw new Error("Advisory not found or access denied.");
    await recordActivity("Advisory status updated", Number(advisoryStatus[1]), `Status changed to ${String(body.status)}.`);
    return { ok: true } as T;
  }

  if (path === "/work-orders" && method === "GET") {
    let query = supabase.from("work_orders").select("id,reference,title,utility,area,description,status,starts_at,ends_at,created_at").order("starts_at");
    if (utility) query = query.eq("utility", utility);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []).map(toCamel) as WorkOrder[] as T;
  }

  if (path === "/work-orders" && method === "POST") {
    await profileForPortal();
    const { data, error } = await supabase.from("work_orders").insert({
      reference: `${portal === "water" ? "WD" : "CE"}-WO-${Date.now().toString(36).toUpperCase()}`,
      title: body.title,
      utility,
      area: body.area,
      description: body.description ?? "",
      starts_at: body.startsAt,
      ends_at: body.endsAt,
    }).select("id,reference,title,utility,area,description,status,starts_at,ends_at,created_at").single();
    if (error) throw new Error(error.message);
    return toCamel(data) as T;
  }

  if (path === "/reports" && method === "POST") {
    const profile = await profileForPortal();
    const { data, error } = await supabase.from("reports").insert({
      reference: `CAS-R-${Date.now().toString(36).toUpperCase()}`,
      user_id: profile.id,
      title: body.issue,
      utility: body.utility,
      area: body.area,
      details: body.details ?? "",
    }).select("id,reference,user_id,title,utility,area,details,status,created_at").single();
    if (error) throw new Error(error.message);
    return toCamel(data) as T;
  }

  if (path === "/reports" && method === "GET") {
    await profileForPortal();
    const { data, error } = await supabase.from("reports").select("id,reference,user_id,title,utility,area,details,status,created_at").order("id", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map(toCamel) as ServiceReport[] as T;
  }

  const reportStatus = path.match(/^\/reports\/(\d+)\/status$/);
  if (reportStatus && method === "PATCH") {
    await profileForPortal();
    const { error, count } = await supabase.from("reports").update({ status: body.status }, { count: "exact" })
      .eq("id", Number(reportStatus[1])).eq("utility", utility);
    if (error) throw new Error(error.message);
    if (!count) throw new Error("Report not found or access denied.");
    return { ok: true } as T;
  }

  if (path === "/network" && method === "GET") {
    await profileForPortal();
    const { data, error } = await supabase.from("network_readings").select("id,utility,district,area,pressure_psi,reservoir_percent,recorded_at").eq("utility", utility).order("id");
    if (error) throw new Error(error.message);
    return (data ?? []).map(toCamel) as T;
  }

  if (path === "/inbox" && method === "GET") {
    if (portal !== "resident") throw new Error("The simulated SMS inbox is available only to residents.");
    const profile = await profileForPortal();
    const { data, error } = await supabase.from("sms_deliveries")
      .select("id,resident_id,read_at,created_at,advisories(id,reference,title,utility,area)")
      .eq("resident_id", profile.id).order("id", { ascending: false });
    if (error) throw new Error(error.message);
    const advisoryIds = [...new Set((data ?? []).flatMap(message => {
      const advisory = message.advisories as unknown as { id: number } | null;
      return advisory ? [advisory.id] : [];
    }))];
    const { data: posts, error: postsError } = advisoryIds.length
      ? await supabase.from("social_posts").select("advisory_id,platform,permalink_url").in("advisory_id", advisoryIds)
      : { data: [], error: null };
    if (postsError) throw new Error(postsError.message);
    const socialLinks = new Map<number, string[]>();
    for (const post of posts ?? []) {
      if (!post.permalink_url || !["facebook", "instagram"].includes(post.platform)) continue;
      const links = socialLinks.get(post.advisory_id) ?? [];
      links.push(`${post.platform === "facebook" ? "Facebook" : "Instagram"}: ${post.permalink_url}`);
      socialLinks.set(post.advisory_id, links);
    }
    return (data ?? []).map(message => {
      const advisory = message.advisories as unknown as { id: number; reference: string; title: string; utility: string; area: string };
      const links = socialLinks.get(advisory.id) ?? [];
      return {
        id: message.id,
        recipientId: message.resident_id,
        recipient: profile.name,
        phoneNumber: profile.phone_number ?? "",
        utility: advisory.utility,
        reference: advisory.reference,
        body: `${advisory.utility} advisory for ${advisory.area}: ${advisory.title}${links.length ? `\n\n${links.join("\n")}` : ""}`,
        createdAt: message.created_at,
        status: "Simulated",
        read: message.read_at !== null,
      };
    }) as SMSRecord[] as T;
  }

  const inboxRead = path.match(/^\/inbox\/(\d+)\/read$/);
  if (inboxRead && method === "PATCH") {
    if (portal !== "resident") throw new Error("The simulated SMS inbox is available only to residents.");
    const profile = await profileForPortal();
    const { error, count } = await supabase.from("sms_deliveries").update({ read_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", Number(inboxRead[1])).eq("resident_id", profile.id);
    if (error) throw new Error(error.message);
    if (!count) throw new Error("Inbox message not found or access denied.");
    return { ok: true } as T;
  }

  throw new Error(`Unsupported Supabase action: ${method} ${path}`);
}
