import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { database, findActorForToken, hashPassword, issueSession, seedDemoAccounts, verifyPassword, type Actor } from "./database.js";
import { portalSettings } from "./portalSettings.js";
import {
  type GmailConnectionFailure,
  assertGmailTokenEncryptionConfigured,
  configuredGmailSender,
  createGmailAuthorizationUrl,
  decryptRefreshToken,
  encryptRefreshToken,
  exchangeGmailAuthorizationCode,
  gmailConnectionFailure,
  parseGmailImageAttachment,
  safeGmailError,
  sendGmailMessage,
} from "./gmail.js";
import { publishAnnouncementToSocial, resolveInstagramPermalink, socialConfiguration, type SocialDeliverySummary, type SocialPlatform } from "./social.js";

type Portal = "resident" | "cepalco" | "water";
type Locals = { actor?: Actor };
type Row = Record<string, unknown>;
type ResidentProfile = {
  id: string;
  name: string;
  email: string;
  role: "resident";
  utility: null;
  phone_number: string | null;
  sms_alerts: boolean;
};
type EmailRecipient = Pick<ResidentProfile, "name" | "email">;
const utilities: Record<Exclude<Portal, "resident">, string> = { cepalco: "CEPALCO", water: "Water District" };
const notificationChannels = ["facebook", "instagram", "gmail", "sms"] as const;
type NotificationChannel = typeof notificationChannels[number];
const MAX_ANNOUNCEMENT_IMAGES = 10;

function parseAnnouncementImages(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > MAX_ANNOUNCEMENT_IMAGES) {
    throw new Error(`Choose no more than ${MAX_ANNOUNCEMENT_IMAGES} announcement images.`);
  }
  return values.map((image, index) => {
    const parsed = parseGmailImageAttachment(image);
    if (!parsed) throw new Error(`Announcement image ${index + 1} is empty.`);
    return `data:${parsed.mimeType};base64,${parsed.content.toString("base64")}`;
  });
}

function readStoredAnnouncementImages(value: string | null): string[] {
  if (!value) return [];
  if (value.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Stored announcement images are invalid.");
    }
    return parseAnnouncementImages(parsed);
  }
  return parseAnnouncementImages(value);
}

function serializeAnnouncementImages(images: string[]): string | null {
  if (images.length === 0) return null;
  return images.length === 1 ? images[0] : JSON.stringify(images);
}

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the API server environment.");
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

async function syncResidentProfiles(supabase: ReturnType<typeof supabaseAdmin>) {
  const residents = await residentProfilesFromSupabase(supabase);

  for (const resident of residents ?? []) {
    const existing = database.prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND role = 'resident' LIMIT 1")
      .get(resident.email) as { id: number } | undefined;
    if (existing) {
      database.prepare(`
        UPDATE users SET name=?,email=?,phone_number=?,sms_alerts=? WHERE id=?
      `).run(resident.name, resident.email, resident.phone_number, Number(resident.sms_alerts), existing.id);
    } else {
      database.prepare(`
        INSERT INTO users (name,email,password_hash,role,utility,phone_number,sms_alerts)
        VALUES (?,?,?,'resident',NULL,?,?)
      `).run(
        resident.name, resident.email, hashPassword(randomBytes(32).toString("hex")),
        resident.phone_number, Number(resident.sms_alerts),
      );
    }
  }
  return residents ?? [];
}

async function residentProfilesFromSupabase(supabase: ReturnType<typeof supabaseAdmin>): Promise<ResidentProfile[]> {
  const residents: ResidentProfile[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from("profiles")
      .select("id,name,email,role,utility,phone_number,sms_alerts")
      .eq("role", "resident")
      .order("id")
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    residents.push(...(data ?? []));
    if ((data ?? []).length < pageSize) break;
  }
  return residents;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value.trim();
}

function parseAnnouncementChannels(value: unknown): NotificationChannel[] {
  const channels = value === undefined ? [] : value;
  if (!Array.isArray(channels) ||
      channels.some(channel => typeof channel !== "string" || !notificationChannels.includes(channel as NotificationChannel))) {
    throw new Error("Select valid announcement channels.");
  }
  const selectedChannels = [...new Set(channels as NotificationChannel[])];
  if (selectedChannels.length === 0) throw new Error("Select at least one announcement channel.");
  return selectedChannels;
}

function parseScheduledAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("Choose a valid announcement date and time.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    throw new Error("Scheduled announcement time must be in the future.");
  }
  return date.toISOString();
}

function parseOptionalDateTime(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name} must be a valid date and time.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid date and time.`);
  return date.toISOString();
}

function parseOptionalInformationUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 2048) {
    throw new Error("Information link must be 2048 characters or fewer.");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid HTTPS information link.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Information link must use HTTPS and cannot contain credentials.");
  }
  return url.toString();
}

const residentBarangays = portalSettings.resident.barangays ?? [];
const pilotPuroks = new Set(Array.from({ length: 10 }, (_, index) => String(index + 1)));

function parseAnnouncementArea(value: unknown): string {
  const area = required(value, "Affected service area");
  if (area.length > 2000) throw new Error("Affected service area must be 2000 characters or fewer.");
  return area;
}

function parseAnnouncementAreas(value: unknown, fallbackArea: unknown): string[] {
  if (value === undefined) return [parseAnnouncementArea(fallbackArea)];
  if (!Array.isArray(value) || value.length === 0 || value.length > residentBarangays.length) {
    throw new Error("Select at least one valid affected service area.");
  }
  const areas = value.map(area => {
    const submitted = required(area, "Affected service area");
    const purokMatch = submitted.match(/^(.+?)\s+·\s+Purok\s+(10|[1-9])$/i);
    if (purokMatch) {
      const barangay = residentBarangays.find(item => item.toLocaleLowerCase() === purokMatch[1].toLocaleLowerCase());
      if (!barangay || !pilotPuroks.has(purokMatch[2])) {
        throw new Error("Choose a valid barangay and Purok/Zone.");
      }
      return `${barangay} · Purok ${purokMatch[2]}`;
    }
    const normalized = residentBarangays.find(item => item.toLocaleLowerCase() === submitted.toLocaleLowerCase());
    if (!normalized) throw new Error("Choose affected areas from the service-area list.");
    return normalized;
  });
  return [...new Set(areas)];
}

function parseAnnouncementLocations(value: unknown, areas: string[]): Array<{ area: string; latitude: number; longitude: number }> {
  if (!Array.isArray(value) || value.length !== areas.length) {
    throw new Error("Place a map pin for every selected affected area.");
  }
  return areas.map((area, index) => {
    const location = value[index] as Record<string, unknown> | null;
    if (!location || typeof location !== "object" || location.area !== area) {
      throw new Error("Each affected-area pin must match its selected service area.");
    }
    const latitude = optionalCoordinate(location.latitude, "Latitude", -90, 90);
    const longitude = optionalCoordinate(location.longitude, "Longitude", -180, 180);
    if (latitude === null || longitude === null) {
      throw new Error(`Place a valid map pin for ${area}.`);
    }
    return { area, latitude, longitude };
  });
}

function isMissingAreaLocationsColumn(error: { code?: string; message?: string }): boolean {
  return (error.code === "42703" || error.code === "PGRST204") &&
    /area_locations/i.test(error.message ?? "");
}

function normalizeResidentBarangay(value: unknown): string {
  const submitted = required(value, "Barangay");
  const barangay = residentBarangays.find(item => item.toLocaleLowerCase() === submitted.toLocaleLowerCase());
  if (!barangay) throw new Error("Choose a barangay from the list.");
  return barangay;
}

function normalizeResidentPurok(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const purok = typeof value === "string" ? value.trim() : "";
  if (!pilotPuroks.has(purok)) throw new Error("Choose a purok from the list, or leave it blank.");
  return purok;
}

function createSimulatedSms(advisoryId: number): number {
  const recipients = database.prepare(`
    SELECT id FROM users WHERE role = 'resident'
  `).all() as Array<{ id: number }>;
  const insert = database.prepare("INSERT OR IGNORE INTO sms_deliveries (advisory_id, resident_id) VALUES (?, ?)");
  let queued = 0;
  for (const recipient of recipients) {
    queued += Number(insert.run(advisoryId, recipient.id).changes);
  }
  return queued;
}

function formatAdvisoryDetails(advisory: {
  type?: string;
  location?: string;
  serviceStatus?: string;
  area: string;
  serviceStartsAt?: string | null;
  estimatedRestorationAt?: string | null;
  provider?: string;
  details: string;
}): string {
  return [
    `Type of Service: ${advisory.type || "Service advisory"}`,
    advisory.location ? `Location: ${advisory.location}` : null,
    `Status: ${advisory.serviceStatus || "Service interruption"}`,
    `Affecting Area: ${advisory.area}`,
    advisory.serviceStartsAt ? `Scheduled Start: ${advisory.serviceStartsAt}` : null,
    advisory.estimatedRestorationAt ? `Estimated Restoration: ${advisory.estimatedRestorationAt}` : null,
    advisory.provider ? `Provider: ${advisory.provider}` : null,
    `Description: ${advisory.details}`,
  ].filter((line): line is string => line !== null).join("\n");
}

function recordSocialPosts(advisoryId: number, summary: SocialDeliverySummary | null): void {
  if (!summary) return;
  const save = database.prepare(`
    INSERT INTO social_posts (advisory_id, platform, post_id, permalink_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(advisory_id, platform) DO UPDATE SET
      post_id = excluded.post_id,
      permalink_url = COALESCE(excluded.permalink_url, social_posts.permalink_url),
      published_at = CURRENT_TIMESTAMP
  `);
  for (const post of summary.platforms) {
    if (post.status === "published" && post.id) {
      save.run(advisoryId, post.platform, post.id, post.permalinkUrl ?? null);
    }
  }
}

function socialLinksForAdvisory(advisoryId: number): string[] {
  const rows = database.prepare(`
    SELECT platform, permalink_url FROM social_posts
    WHERE advisory_id = ? AND permalink_url IS NOT NULL
    ORDER BY platform
  `).all(advisoryId) as Array<{ platform: string; permalink_url: string }>;
  return rows.map(({ platform, permalink_url }) => `${platform === "facebook" ? "Facebook" : "Instagram"}: ${permalink_url}`);
}

function socialLinksInMessage(facebookUrl: unknown, instagramUrl: unknown): string {
  const links = [
    typeof facebookUrl === "string" && facebookUrl ? `Facebook: ${facebookUrl}` : null,
    typeof instagramUrl === "string" && instagramUrl ? `Instagram: ${instagramUrl}` : null,
  ].filter((link): link is string => link !== null);
  return links.length ? `\n\n${links.join("\n")}` : "";
}

async function publishSelectedChannels(
  portal: Exclude<Portal, "resident">,
  utility: string,
  advisory: {
    id: number;
    reference: string;
    title: string;
    type?: string;
    location?: string;
    serviceStatus?: string;
    area: string;
    serviceStartsAt?: string | null;
    estimatedRestorationAt?: string | null;
    provider?: string;
    details: string;
    imageDataUrls: string[];
  },
  channels: NotificationChannel[],
  recipientProfiles?: EmailRecipient[],
) {
  if (advisory.imageDataUrls.length === 0 && channels.some(channel => ["facebook", "instagram", "gmail"].includes(channel))) {
    throw new Error("Add an announcement image before publishing to Facebook, Instagram, or Gmail.");
  }
  const noticeDetails = formatAdvisoryDetails(advisory);
  const socialChannels = channels.filter((channel): channel is SocialPlatform => channel === "facebook" || channel === "instagram");
  const socialDelivery = socialChannels.length
    ? await publishAnnouncementToSocial(portal, utility, advisory.id, advisory.reference, advisory.title, advisory.area, noticeDetails, advisory.imageDataUrls, socialChannels)
    : null;
  recordSocialPosts(advisory.id, socialDelivery);
  const socialLinks = socialLinksForAdvisory(advisory.id);
  const emailDelivery = channels.includes("gmail")
    ? await deliverAdvisoryEmails(portal, utility, advisory.id, advisory.reference, advisory.title, advisory.area, noticeDetails, advisory.imageDataUrls, false, socialLinks, recipientProfiles)
    : null;
  const smsQueued = createSimulatedSms(advisory.id);
  return { emailDelivery, socialDelivery, socialLinks: socialLinksForAdvisory(advisory.id), smsQueued };
}

// ADDED: Validate optional map coordinates from the advisory publishing form.
function optionalCoordinate(value: unknown, name: string, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const coordinate = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(coordinate) || coordinate < minimum || coordinate > maximum) {
    throw new Error(`${name} must be a valid number between ${minimum} and ${maximum}.`);
  }
  return coordinate;
}


function publicActor(actor: Actor) {
  return {
    id: actor.id,
    name: actor.name,
    email: actor.email,
    role: actor.role,
    utility: actor.utility,
    phoneNumber: actor.phone_number ?? "",
    address: actor.address ?? "",
    barangay: actor.barangay ?? "",
    purok: actor.purok ?? "",
    district: actor.district ?? "",
    city: actor.city ?? "",
    postalCode: actor.postal_code ?? "",
    profileImage: actor.profile_image ?? null,
    smsAlerts: Boolean(actor.sms_alerts),
    maintenanceAlerts: Boolean(actor.notify_maintenance),
    emailDigest: Boolean(actor.notify_email_digest),
    immediateEmailAlerts: Boolean(actor.immediate_email_alerts),
  };
}

function decorateRows<T extends Row>(rows: T[]): T[] {
  return rows.map(row => {
    const decorated: Row = { ...row };
    for (const [key, value] of Object.entries(row)) {
      const outputKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      decorated[outputKey] = value;
    }

    return decorated as T;
  });
}

function decorateAdvisoryRows(rows: Row[]): Row[] {
  return decorateRows(rows).map(row => {
    const imageCount = Math.max(0, Math.min(MAX_ANNOUNCEMENT_IMAGES, Number(row.imageCount) || 0));
    const id = Number(row.id);
    const firstImage = typeof row.imageUrl === "string" ? row.imageUrl : null;
    let areaLocations: unknown[] = [];
    if (typeof row.areaLocationsJson === "string") {
      try {
        const parsed: unknown = JSON.parse(row.areaLocationsJson);
        if (Array.isArray(parsed)) areaLocations = parsed;
      } catch {
        areaLocations = [];
      }
    }
    return {
      ...row,
      areaLocations,
      imageUrls: Array.from({ length: imageCount }, (_, index) =>
        index === 0 ? firstImage : `/advisories/${id}/images/${index}`),
    };
  });
}

export function createApi(portal: Portal) {
  seedDemoAccounts();
  const app = express();
  app.disable("x-powered-by");
  const configuredOrigins = process.env.CORS_ORIGIN?.split(",").map(origin => origin.trim()).filter(Boolean);
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (configuredOrigins && configuredOrigins.includes(origin)) return callback(null, true);
      if (process.env.NODE_ENV !== "production") {
        if (/^https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)(?::\d+)?$/.test(origin)) {
          return callback(null, true);
        }
      }
      return callback(new Error("Origin is not allowed by CORS."));
    },
    allowedHeaders: ["Content-Type", "Authorization"],
  }));
  app.use(express.json({ limit: "16mb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, portal, service: "Community Alert System API" }));
  app.get("/content", (_req, res) => {
    const rows = database.prepare("SELECT content_key, content_value FROM ui_copy ORDER BY content_key").all() as Array<{ content_key: string; content_value: string }>;
    const settingsRows = database.prepare("SELECT portal, settings_json FROM portal_settings").all() as Array<{ portal: string; settings_json: string }>;
    const settings = Object.fromEntries(settingsRows.map(row => [row.portal, JSON.parse(row.settings_json)]));
    if (!settings[portal]) return res.status(500).json({ error: `Portal content for ${portal} is unavailable.` });
    return res.json({ copy: Object.fromEntries(rows.map(row => [row.content_key, row.content_value])), settings });
  });
  const serveAdvisoryImage = (req: Request, res: Response, imageIndex: number) => {
    const advisory = database.prepare(`
      SELECT image_data_url FROM advisories
      WHERE id = ? AND publication_status IN ('published', 'publishing')
    `).get(Number(req.params.id)) as { image_data_url: string | null } | undefined;
    if (!advisory?.image_data_url) return res.status(404).json({ error: "Announcement image not found." });
    const imageDataUrl = readStoredAnnouncementImages(advisory.image_data_url)[imageIndex];
    if (!imageDataUrl) return res.status(404).json({ error: "Announcement image is not available." });
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageDataUrl);
    if (!match) return res.status(404).json({ error: "Announcement image is not available." });
    res.setHeader("Cache-Control", "no-store");
    return res.type(match[1]).send(Buffer.from(match[2], "base64"));
  };
  app.get("/advisories/:id/image", (req, res) => serveAdvisoryImage(req, res, 0));
  app.get("/advisories/:id/images/:index", (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_ANNOUNCEMENT_IMAGES) {
      return res.status(404).json({ error: "Announcement image is not available." });
    }
    return serveAdvisoryImage(req, res, index);
  });
  if (portal === "resident") {
    app.get("/inbox", authenticate("resident"), (_req, res: Response<unknown, Locals>) => {
      const rows = database.prepare(`
        SELECT deliveries.id, users.id AS recipient_id, users.name AS recipient,
          users.phone_number, advisories.utility, advisories.reference, advisories.title,
          advisories.type, advisories.location, advisories.service_status, advisories.area,
          advisories.provider, advisories.service_starts_at, advisories.estimated_restoration_at,
          advisories.details, deliveries.created_at, deliveries.read_at,
          (SELECT permalink_url FROM social_posts WHERE advisory_id = advisories.id AND platform = 'facebook') AS facebook_url,
          (SELECT permalink_url FROM social_posts WHERE advisory_id = advisories.id AND platform = 'instagram') AS instagram_url
        FROM sms_deliveries AS deliveries
        JOIN users ON users.id = deliveries.resident_id
        JOIN advisories ON advisories.id = deliveries.advisory_id
        WHERE deliveries.resident_id = ?
        ORDER BY deliveries.id DESC
      `).all(res.locals.actor!.id) as Array<Record<string, unknown>>;
      return res.json(rows.map(row => ({
        id: row.id,
        recipientId: row.recipient_id,
        recipient: row.recipient,
        phoneNumber: row.phone_number,
        utility: row.utility,
        reference: row.reference,
        body: `${row.utility} advisory: ${row.title}\n${formatAdvisoryDetails({
          type: String(row.type ?? ""),
          location: String(row.location ?? ""),
          serviceStatus: String(row.service_status ?? ""),
          area: String(row.area ?? ""),
          serviceStartsAt: row.service_starts_at == null ? null : String(row.service_starts_at),
          estimatedRestorationAt: row.estimated_restoration_at == null ? null : String(row.estimated_restoration_at),
          provider: String(row.provider ?? ""),
          details: String(row.details ?? ""),
        })}${socialLinksInMessage(row.facebook_url, row.instagram_url)}`,
        createdAt: row.created_at,
        status: "Simulated",
        read: row.read_at !== null,
      })));
    });
    app.patch("/inbox/:id/read", authenticate("resident"), (req, res: Response<unknown, Locals>) => {
      const result = database.prepare("UPDATE sms_deliveries SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND resident_id = ?")
        .run(Number(req.params.id), res.locals.actor!.id);
      return Number(result.changes) ? res.json({ ok: true }) : res.status(404).json({ error: "Inbox message not found." });
    });
  } else {
    app.get("/inbox", requireUtility(utilities[portal]), (_req, res) =>
      res.status(404).json({ error: "The simulated SMS inbox is available only in the resident portal." }));
    app.patch("/inbox/:id/read", requireUtility(utilities[portal]), (_req, res) =>
      res.status(404).json({ error: "The simulated SMS inbox is available only in the resident portal." }));
  }
  if (portal === "resident") {
    app.get("/auth/me", authenticate("resident"), (_req, res: Response<unknown, Locals>) => res.json({ actor: publicActor(res.locals.actor!) }));
  } else {
    app.get("/auth/me", requireUtility(utilities[portal]), (_req, res: Response<unknown, Locals>) => res.json({ actor: publicActor(res.locals.actor!) }));
    app.get("/email/gmail/status", requireUtility(utilities[portal]), (_req, res) => {
      const connection = database.prepare("SELECT sender_email, connected_at FROM gmail_connections WHERE utility = ?")
        .get(utilities[portal]) as { sender_email: string; connected_at: string } | undefined;
      if (!connection) return res.json({ connected: false, senderEmail: null, connectedAt: null });
      try {
        const stored = database.prepare("SELECT encrypted_refresh_token FROM gmail_connections WHERE utility = ?")
          .get(utilities[portal]) as { encrypted_refresh_token: string };
        decryptRefreshToken(stored.encrypted_refresh_token);
        return res.json({ connected: true, senderEmail: connection.sender_email, connectedAt: connection.connected_at });
      } catch (error) {
        return res.json({
          connected: false,
          senderEmail: connection.sender_email,
          connectedAt: connection.connected_at,
          connectionError: error instanceof Error ? error.message : "Stored Gmail authorization is unavailable.",
        });
      }
    });
    app.post("/email/gmail/connect", requireUtility(utilities[portal]), (req, res: Response<unknown, Locals>) => {
      const state = randomBytes(32).toString("base64url");
      const userId = res.locals.actor!.id;
      try {
        assertGmailTokenEncryptionConfigured();
        configuredGmailSender(portal);
        const authorizationUrl = createGmailAuthorizationUrl(portal, state);
        database.prepare("DELETE FROM gmail_oauth_states WHERE expires_at < ?").run(Date.now());
        database.prepare("INSERT INTO gmail_oauth_states (state_hash, user_id, utility, expires_at) VALUES (?, ?, ?, ?)")
          .run(createHash("sha256").update(state).digest("hex"), userId, utilities[portal], Date.now() + 5 * 60 * 1000);
        return res.json({ authorizationUrl });
      } catch (error) {
        return res.status(503).json({ error: error instanceof Error ? error.message : "Gmail OAuth is not configured on the server." });
      }
    });
    app.get("/oauth/gmail/callback", async (req, res) => {
      const frontend = gmailFrontendUrl(portal);
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const stateHash = createHash("sha256").update(state).digest("hex");
      const oauthState = state ? database.prepare(`
        SELECT oauth_states.user_id, oauth_states.utility, oauth_states.expires_at
        FROM gmail_oauth_states AS oauth_states
        JOIN users ON users.id = oauth_states.user_id
        WHERE oauth_states.state_hash = ? AND users.role = 'admin' AND users.utility = oauth_states.utility
      `)
        .get(stateHash) as { user_id: number; utility: string; expires_at: number } | undefined : undefined;
      if (!oauthState || oauthState.expires_at < Date.now() || oauthState.utility !== utilities[portal]) {
        return res.redirect(gmailFrontendRedirect(frontend, portal, "error", "invalid_state"));
      }
      database.prepare("DELETE FROM gmail_oauth_states WHERE state_hash = ?").run(stateHash);
      if (typeof req.query.error === "string") {
        const reason = req.query.error === "access_denied" ? "cancelled" : "google_error";
        return res.redirect(gmailFrontendRedirect(frontend, portal, "error", reason));
      }
      if (typeof req.query.code !== "string") {
        return res.redirect(gmailFrontendRedirect(frontend, portal, "error", "google_error"));
      }
      try {
        const connected = await exchangeGmailAuthorizationCode(portal, req.query.code);
        if (connected.email !== configuredGmailSender(portal)) {
          throw new Error("The authorized Google account does not match the configured official utility address.");
        }
        const existing = database.prepare("SELECT encrypted_refresh_token FROM gmail_connections WHERE utility = ?")
          .get(utilities[portal]) as { encrypted_refresh_token: string } | undefined;
        const refreshToken = connected.refreshToken
          ? encryptRefreshToken(connected.refreshToken)
          : existing?.encrypted_refresh_token;
        if (!refreshToken) throw new Error("Google did not issue a refresh token. Reconnect and approve offline access.");
        database.prepare(`
          INSERT INTO gmail_connections (utility, sender_email, encrypted_refresh_token, connected_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(utility) DO UPDATE SET
            sender_email = excluded.sender_email,
            encrypted_refresh_token = excluded.encrypted_refresh_token,
            connected_by = excluded.connected_by,
            connected_at = CURRENT_TIMESTAMP
        `).run(utilities[portal], connected.email, refreshToken, oauthState.user_id);
        return res.redirect(gmailFrontendRedirect(frontend, portal, "connected"));
      } catch (error) {
        console.error(`[${portal}-api] Gmail account connection failed: ${safeGmailError(error)}`);
        return res.redirect(gmailFrontendRedirect(frontend, portal, "error", gmailConnectionFailure(error)));
      }
    });
  }
  app.post("/auth/login", (req, res) => {
    try {
      const email = required(req.body?.email, "Email").toLowerCase();
      const password = required(req.body?.password, "Password");
      const expectedRole = portal === "resident" ? "resident" : "admin";
      const user = database.prepare("SELECT id, name, email, password_hash, role, utility, phone_number, address, barangay, purok, district, city, postal_code, profile_image, sms_alerts, notify_maintenance, notify_email_digest, immediate_email_alerts, terms_accepted_at FROM users WHERE email = ? AND role = ? AND (utility IS ? OR utility = ?)").get(
        email, expectedRole, portal === "resident" ? null : utilities[portal], portal === "resident" ? "" : utilities[portal],
      ) as (Actor & { password_hash: string }) | undefined;
      if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "Email or password is incorrect." });
      const { password_hash: _secret, ...actor } = user;
      return res.json({ token: issueSession(user.id), actor: publicActor(actor) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid sign-in request." });
    }
  });

  if (portal === "resident") {
    app.patch("/auth/profile", authenticate("resident"), (req, res: Response<unknown, Locals>) => {
      try {
        const name = required(req.body?.name, "Full name");
        const email = required(req.body?.email, "Email").toLowerCase();
        const currentProfile = res.locals.actor!;
        const phoneNumber = typeof req.body?.phoneNumber === "string" ? req.body.phoneNumber.trim() : currentProfile.phone_number ?? "";
        const address = typeof req.body?.address === "string" ? req.body.address.trim() : currentProfile.address ?? "";
        const barangay = req.body?.barangay === undefined
          ? currentProfile.barangay ?? ""
          : normalizeResidentBarangay(req.body.barangay);
        const purok = req.body?.purok === undefined
          ? currentProfile.purok ?? null
          : normalizeResidentPurok(req.body.purok);
        const district = typeof req.body?.district === "string" ? req.body.district.trim() : currentProfile.district ?? "";
        const city = typeof req.body?.city === "string" ? req.body.city.trim() : currentProfile.city ?? "";
        const postalCode = typeof req.body?.postalCode === "string" ? req.body.postalCode.trim() : currentProfile.postal_code ?? "";
        const smsAlerts = 1;
        const maintenanceAlerts = typeof req.body?.maintenanceAlerts === "boolean" ? Number(req.body.maintenanceAlerts) : res.locals.actor!.notify_maintenance ?? 1;
        const emailDigest = typeof req.body?.emailDigest === "boolean" ? Number(req.body.emailDigest) : res.locals.actor!.notify_email_digest ?? 1;
        const immediateEmailAlerts = typeof req.body?.immediateEmailAlerts === "boolean" ? Number(req.body.immediateEmailAlerts) : res.locals.actor!.immediate_email_alerts ?? 0;
        const profileImage = req.body?.profileImage;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
        if (phoneNumber.length > 40 || address.length > 240 || barangay.length > 100 || district.length > 80 || city.length > 100 || postalCode.length > 20 || name.length > 120) {
          return res.status(400).json({ error: "One or more profile fields are too long." });
        }
        if (profileImage !== null && profileImage !== undefined &&
            (typeof profileImage !== "string" || profileImage.length > 1_500_000 ||
             !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(profileImage))) {
          return res.status(400).json({ error: "Choose a JPEG, PNG, or WebP profile image under 1 MB." });
        }
        const imageToSave = profileImage === undefined ? res.locals.actor!.profile_image ?? null : profileImage;
        const result = database.prepare(`
          UPDATE users SET name = ?, email = ?, phone_number = ?, address = ?, barangay = ?, purok = ?, district = ?, city = ?, postal_code = ?, profile_image = ?, sms_alerts = ?, notify_maintenance = ?, notify_email_digest = ?, immediate_email_alerts = ?
          WHERE id = ? AND role = 'resident'
        `).run(name, email, phoneNumber, address, barangay, purok, district, city, postalCode, imageToSave, smsAlerts, maintenanceAlerts, emailDigest, immediateEmailAlerts, res.locals.actor!.id);
        if (!Number(result.changes)) return res.status(404).json({ error: "Resident account not found." });
        const actor = database.prepare("SELECT id, name, email, role, utility, phone_number, address, barangay, purok, district, city, postal_code, profile_image, sms_alerts, notify_maintenance, notify_email_digest, immediate_email_alerts, terms_accepted_at FROM users WHERE id = ?").get(res.locals.actor!.id) as Actor;
        return res.json({ actor: publicActor(actor) });
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint")) return res.status(409).json({ error: "An account with this email already exists." });
        return res.status(400).json({ error: error instanceof Error ? error.message : "Could not update resident profile." });
      }
    });
    app.post("/auth/password", authenticate("resident"), (req, res: Response<unknown, Locals>) => {
      try {
        const currentPassword = required(req.body?.currentPassword, "Current password");
        const newPassword = required(req.body?.newPassword, "New password");
        if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
        const user = database.prepare("SELECT password_hash FROM users WHERE id = ? AND role = 'resident'").get(res.locals.actor!.id) as { password_hash: string } | undefined;
        if (!user || !verifyPassword(currentPassword, user.password_hash)) return res.status(401).json({ error: "Current password is incorrect." });
        if (verifyPassword(newPassword, user.password_hash)) return res.status(400).json({ error: "Choose a password you have not used before." });
        database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), res.locals.actor!.id);
        return res.json({ ok: true });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : "Could not change password." });
      }
    });
    app.post("/auth/register", (req, res) => {
      try {
        const name = required(req.body?.name, "Name");
        const email = required(req.body?.email, "Email").toLowerCase();
        const password = required(req.body?.password, "Password");
        const phoneNumber = required(req.body?.phoneNumber, "Mobile telephone");
        const address = required(req.body?.address, "Street address");
        const barangay = normalizeResidentBarangay(req.body?.barangay);
        const purok = normalizeResidentPurok(req.body?.purok);
        const district = required(req.body?.district, "District");
        const city = required(req.body?.city, "City");
        const postalCode = required(req.body?.postalCode, "Postal code");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
        if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
        if (name.length > 120 || phoneNumber.length > 40 || address.length > 240 || barangay.length > 100 || district.length > 80 || city.length > 100 || postalCode.length > 20) {
          return res.status(400).json({ error: "One or more registration fields are too long." });
        }
        if (req.body?.termsAccepted !== true) return res.status(400).json({ error: "Please accept the resident terms and privacy policy." });
        const smsAlerts = 1;
        const immediateEmailAlerts = req.body?.immediateEmailAlerts === true ? 1 : 0;
        const id = Number(database.prepare(`
          INSERT INTO users (name, email, password_hash, role, utility, phone_number, address, barangay, purok, district, city, postal_code, sms_alerts, immediate_email_alerts, terms_accepted_at)
          VALUES (?, ?, ?, 'resident', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(name, email, hashPassword(password), phoneNumber, address, barangay, purok, district, city, postalCode, smsAlerts, immediateEmailAlerts).lastInsertRowid);
        const actor: Actor = { id, name, email, role: "resident", utility: null, phone_number: phoneNumber, address, barangay, purok, district, city, postal_code: postalCode, sms_alerts: smsAlerts, immediate_email_alerts: immediateEmailAlerts, notify_maintenance: 1, notify_email_digest: 1 };
        return res.status(201).json({ token: issueSession(id), actor: publicActor(actor) });
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint")) return res.status(409).json({ error: "An account with this email already exists." });
        return res.status(400).json({ error: error instanceof Error ? error.message : "Could not create account." });
      }
    });
    app.get("/advisories", (_req, res) => {
      const rows = database.prepare(`
        SELECT advisories.id, reference, title, utility, type, area, status, details,
          location, service_status, provider, priority, area_locations_json,
          service_starts_at, estimated_restoration_at, created_at, latitude, longitude,
          scheduled_at, publication_status, channels_json,
          (SELECT permalink_url FROM social_posts WHERE advisory_id = advisories.id AND platform = 'facebook') AS facebook_url,
          (SELECT permalink_url FROM social_posts WHERE advisory_id = advisories.id AND platform = 'instagram') AS instagram_url,
          CASE WHEN image_data_url IS NOT NULL THEN '/advisories/' || advisories.id || '/image' END AS image_url,
          CASE WHEN image_data_url IS NULL THEN 0
            WHEN json_valid(image_data_url) AND json_type(image_data_url) = 'array' THEN json_array_length(image_data_url)
            ELSE 1 END AS image_count
        FROM advisories WHERE publication_status = 'published' ORDER BY advisories.id DESC
      `).all() as Row[];
      return res.json(decorateAdvisoryRows(rows));
    });
    app.get("/work-orders", (_req, res) => {
      const rows = database.prepare("SELECT id, reference, title, utility, area, status, starts_at, ends_at FROM work_orders ORDER BY starts_at").all() as Row[];
      return res.json(decorateRows(rows));
    });
    app.post("/reports", authenticate("resident"), (_req, res: Response<unknown, Locals>) =>
      res.status(403).json({ error: "Resident issue reports are temporarily unavailable." }));
    app.get("/reports/mine", authenticate("resident"), (_req, res: Response<unknown, Locals>) => {
      const rows = database.prepare("SELECT id, reference, title, utility, area, status, created_at FROM reports WHERE user_id = ? ORDER BY id DESC").all(res.locals.actor!.id) as Row[];
      return res.json(decorateRows(rows));
    });
  } else {
    const utility = utilities[portal];
    app.get("/advisories/recipient-estimate", requireUtility(utility), async (_req, res) => {
      try {
        const supabase = supabaseAdmin();
        const [emailCountResult, smsCountResult] = await Promise.all([
          supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "resident"),
          supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "resident"),
        ]);
        if (emailCountResult.error) throw emailCountResult.error;
        if (smsCountResult.error) throw smsCountResult.error;
        const emailRecipients = emailCountResult.count ?? 0;
        const smsRecipients = smsCountResult.count ?? 0;
        return res.json({
          emailRecipients,
          smsRecipients,
          totalResidentAccounts: emailRecipients,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not estimate recipients.";
        return res.status(503).json({ error: `Could not estimate recipients: ${message}` });
      }
    });
    app.post("/advisories/:id/deliver", requireUtility(utility), async (req, res) => {
      const supabase = supabaseAdmin();
      const advisoryId = Number(req.params.id);
      const advisoryQuery = supabase.from("advisories")
        .select("id,reference,title,utility,type,area,status,details,location,service_status,provider,priority,service_starts_at,estimated_restoration_at,image_data_url,latitude,longitude,area_locations,scheduled_at,publication_status,channels")
        .eq("id", advisoryId).eq("utility", utility);
      let advisoryResult = await advisoryQuery.single();
      if (advisoryResult.error && isMissingAreaLocationsColumn(advisoryResult.error)) {
        advisoryResult = await supabase.from("advisories")
          .select("id,reference,title,utility,type,area,status,details,location,service_status,provider,priority,service_starts_at,estimated_restoration_at,image_data_url,latitude,longitude,scheduled_at,publication_status,channels")
          .eq("id", advisoryId).eq("utility", utility).single();
      }
      const { data: advisory, error: advisoryError } = advisoryResult;
      if (advisoryError?.code === "PGRST116" || (!advisoryError && !advisory)) {
        return res.status(404).json({ error: "The saved advisory was not found for this utility. Refresh advisories and try again." });
      }
      if (advisoryError || !advisory) {
        console.error(`[${portal}-api] Could not load saved advisory ${advisoryId}:`, advisoryError);
        return res.status(500).json({ error: "Could not load the saved advisory from Supabase. Check the API database configuration and retry." });
      }
      try {
        const channels = parseAnnouncementChannels(advisory.channels);
        const area = parseAnnouncementArea(advisory.area);
        const requestAreas = req.body?.areas;
        const requestAreaLocations = req.body?.areaLocations;
        const storedAreaLocations = Array.isArray(advisory.area_locations) ? advisory.area_locations : [];
        const fallbackAreaLocations = Array.isArray(requestAreas) && requestAreas.length
          ? parseAnnouncementLocations(requestAreaLocations, parseAnnouncementAreas(requestAreas, area))
          : [];
        const areaLocations = storedAreaLocations.length
          ? parseAnnouncementLocations(
              storedAreaLocations,
              storedAreaLocations.map((location: unknown) =>
                location && typeof location === "object" && "area" in location
                  ? String(location.area)
                  : "",
              ),
            )
          : fallbackAreaLocations.length
            ? fallbackAreaLocations
            : advisory.latitude !== null && advisory.latitude !== undefined &&
                advisory.longitude !== null && advisory.longitude !== undefined
              ? [{ area, latitude: Number(advisory.latitude), longitude: Number(advisory.longitude) }]
              : [];
        const imageDataUrls = readStoredAnnouncementImages(advisory.image_data_url);
        if (imageDataUrls.length === 0 && channels.some(channel => ["facebook", "instagram", "gmail"].includes(channel))) {
          return res.status(400).json({ error: "Add an announcement image before publishing to Facebook, Instagram, or Gmail." });
        }
        const localAdvisoryId = (database.prepare(`
          INSERT INTO advisories
            (reference,title,utility,type,area,status,details,location,service_status,provider,priority,service_starts_at,
             estimated_restoration_at,image_data_url,latitude,longitude,area_locations_json,scheduled_at,
             publication_status,channels_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(reference) DO UPDATE SET
            title=excluded.title, utility=excluded.utility, type=excluded.type, area=excluded.area,
            status=excluded.status, details=excluded.details, location=excluded.location,
            service_status=excluded.service_status, provider=excluded.provider, priority=excluded.priority,
            service_starts_at=excluded.service_starts_at,
            estimated_restoration_at=excluded.estimated_restoration_at,
            image_data_url=excluded.image_data_url, latitude=excluded.latitude, longitude=excluded.longitude,
            area_locations_json=excluded.area_locations_json,
            scheduled_at=excluded.scheduled_at, publication_status=excluded.publication_status,
            channels_json=excluded.channels_json
          RETURNING id
        `).get(
          advisory.reference, advisory.title, advisory.utility, advisory.type, area,
          advisory.status, advisory.details, advisory.location, advisory.service_status,
          advisory.provider, advisory.priority, advisory.service_starts_at,
          advisory.estimated_restoration_at, advisory.image_data_url, advisory.latitude,
          advisory.longitude, JSON.stringify(areaLocations), advisory.scheduled_at, advisory.publication_status,
          JSON.stringify(channels),
        ) as { id: number }).id;

        // Mirror scheduled Supabase notices into the shared API database without publishing yet.
        // The utility-specific worker will deliver them when their schedule becomes due.
        if (advisory.publication_status === "scheduled") return res.json({ scheduled: true });

        const residents = await syncResidentProfiles(supabase);
        const delivery = await publishSelectedChannels(portal, utility, {
          id: localAdvisoryId,
          reference: advisory.reference,
          title: advisory.title,
          area,
          details: advisory.details,
          imageDataUrls,
        }, channels, residents);

        const localEmailRows = database.prepare(`
          SELECT users.email, deliveries.status, deliveries.error_message,
            deliveries.attempt_count, deliveries.sent_at, deliveries.created_at
          FROM email_deliveries AS deliveries
          JOIN users ON users.id = deliveries.resident_id
          WHERE deliveries.advisory_id = ?
        `).all(localAdvisoryId) as Array<{
          email: string;
          status: "pending" | "sent" | "failed";
          error_message: string | null;
          attempt_count: number;
          sent_at: string | null;
          created_at: string;
        }>;
        for (const emailRow of localEmailRows) {
          const resident = (residents ?? []).find(profile => profile.email.toLowerCase() === emailRow.email.toLowerCase());
          if (!resident) continue;
          const { error } = await supabase.from("email_deliveries").upsert({
            advisory_id: advisory.id,
            resident_id: resident.id,
            status: emailRow.status,
            error_message: emailRow.error_message,
            attempt_count: emailRow.attempt_count,
            sent_at: emailRow.sent_at,
            created_at: emailRow.created_at,
          }, { onConflict: "advisory_id,resident_id" });
          if (error) throw error;
        }

        const localPosts = database.prepare(`
          SELECT platform,post_id,permalink_url,published_at FROM social_posts WHERE advisory_id=?
        `).all(localAdvisoryId) as Array<{ platform: string; post_id: string; permalink_url: string | null; published_at: string }>;
        for (const post of localPosts) {
          const { error } = await supabase.from("social_posts").upsert({
            advisory_id: advisory.id,
            platform: post.platform,
            post_id: post.post_id,
            permalink_url: post.permalink_url,
            published_at: post.published_at,
          }, { onConflict: "advisory_id,platform" });
          if (error) throw error;
        }

        const recipients = residents.filter(profile => profile.role === "resident");
        if (recipients.length) {
          const { error } = await supabase.from("sms_deliveries").upsert(
            recipients.map(profile => ({ advisory_id: advisory.id, resident_id: profile.id })),
            { onConflict: "advisory_id,resident_id", ignoreDuplicates: true },
          );
          if (error) throw error;
        }
        return res.json(delivery);
      } catch (error) {
        console.error(`[${portal}-api] Supabase announcement delivery failed:`, error);
        return res.status(500).json({ error: error instanceof Error ? error.message : "Announcement delivery failed." });
      }
    });
    app.get("/advisories", requireUtility(utility), (_req, res) => {
      const rows = database.prepare(`
        SELECT advisories.id, reference, title, utility, type, area, status, details,
          location, service_status, provider, priority, area_locations_json,
          service_starts_at, estimated_restoration_at, created_at, latitude, longitude,
          scheduled_at, publication_status, channels_json,
          (SELECT permalink_url FROM social_posts WHERE advisory_id = advisories.id AND platform = 'facebook') AS facebook_url,
          (SELECT permalink_url FROM social_posts WHERE advisory_id = advisories.id AND platform = 'instagram') AS instagram_url,
          CASE WHEN image_data_url IS NOT NULL THEN '/advisories/' || advisories.id || '/image' END AS image_url,
          CASE WHEN image_data_url IS NULL THEN 0
            WHEN json_valid(image_data_url) AND json_type(image_data_url) = 'array' THEN json_array_length(image_data_url)
            ELSE 1 END AS image_count
        FROM advisories WHERE utility = ? ORDER BY advisories.id DESC
      `).all(utility) as Row[];
      return res.json(decorateAdvisoryRows(rows));
    });
    app.post("/advisories", requireUtility(utility), async (req, res) => {
      try {
        const title = required(req.body?.title, "Advisory title");
        const areas = parseAnnouncementAreas(req.body?.areas, req.body?.area);
        const area = areas.join(", ");
        const informationUrl = parseOptionalInformationUrl(req.body?.informationUrl);
        const description = required(req.body?.details, "Public update");
        const details = informationUrl ? `${description}\n\nMore information: ${informationUrl}` : description;
        const type = typeof req.body?.type === "string" ? req.body.type : "Service disruption";
        const location = typeof req.body?.location === "string" ? req.body.location.trim() : "";
        const serviceStatus = typeof req.body?.serviceStatus === "string" ? req.body.serviceStatus.trim() : "Upcoming Maintenance Interruption";
        const provider = typeof req.body?.provider === "string" ? req.body.provider.trim() : "";
        const allowedServiceStatuses = ["Upcoming Maintenance Interruption", "Active Service Interruption", "Resolved", "Cancelled"];
        if (location.length > 160 || provider.length > 120 || type.length > 80) {
          throw new Error("Location, provider, or service type exceeds its maximum length.");
        }
        if (!allowedServiceStatuses.includes(serviceStatus)) {
          throw new Error("Choose a valid service status.");
        }
        const priority = req.body?.priority == null ? "Normal" : required(req.body.priority, "Priority");
        if (!["Emergency", "Urgent", "High", "Normal", "Critical", "Medium", "Low"].includes(priority)) {
          throw new Error("Choose a valid advisory priority.");
        }
        const serviceStartsAt = parseOptionalDateTime(req.body?.serviceStartsAt, "Advisory start");
        const estimatedRestorationAt = parseOptionalDateTime(req.body?.estimatedRestorationAt, "Estimated restoration");
        if (serviceStartsAt && estimatedRestorationAt && new Date(estimatedRestorationAt).getTime() === new Date(serviceStartsAt).getTime()) {
          throw new Error("Advisory start and estimated restoration times cannot be the same.");
        }
        const selectedChannels = parseAnnouncementChannels(req.body?.channels);
        const deliveryChannels = [...new Set([...selectedChannels, "sms" as const])];
        const scheduledAt = parseScheduledAt(req.body?.scheduledAt);

        const areaLocations = req.body?.areas === undefined
          ? (() => {
              const latitude = optionalCoordinate(req.body?.latitude, "Latitude", -90, 90);
              const longitude = optionalCoordinate(req.body?.longitude, "Longitude", -180, 180);
              if (latitude === null || longitude === null) {
                throw new Error("Place an affected-area pin on the map before publishing or scheduling this announcement.");
              }
              return [{ area: areas[0], latitude, longitude }];
            })()
          : parseAnnouncementLocations(req.body?.areaLocations, areas);
        const { latitude, longitude } = areaLocations[0];

        const imageDataUrls = parseAnnouncementImages(req.body?.imageDataUrls ?? req.body?.imageDataUrl ?? null);
        const imageDataUrl = serializeAnnouncementImages(imageDataUrls);
        if (imageDataUrls.length === 0 && selectedChannels.some(channel => ["facebook", "instagram", "gmail"].includes(channel))) {
          throw new Error("Add an announcement image before publishing to Facebook, Instagram, or Gmail.");
        }

        const reference = `${portal === "water" ? "WD" : "CE"}-${Date.now().toString(36).toUpperCase()}`;

        // ADDED: Save the validated image with the advisory so failed email deliveries can retry with it.
        const publicationStatus = scheduledAt ? "scheduled" : "published";
        const status = scheduledAt ? "Scheduled" : "Active";
        const id = Number(database.prepare(`
          INSERT INTO advisories
            (reference, title, utility, type, area, status, details, location, service_status, provider, priority, service_starts_at, estimated_restoration_at, image_data_url, latitude, longitude, area_locations_json, scheduled_at, publication_status, channels_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(reference, title, utility, type, area, status, details, location, serviceStatus, provider, priority, serviceStartsAt, estimatedRestorationAt, imageDataUrl, latitude, longitude, JSON.stringify(areaLocations), scheduledAt, publicationStatus, JSON.stringify(deliveryChannels)).lastInsertRowid);

        if (!scheduledAt && supabaseConfigured()) {
          await syncResidentProfiles(supabaseAdmin());
        }
        const delivery = scheduledAt ? null : await publishSelectedChannels(portal, utility, {
          id, reference, title, type, location, serviceStatus, area, serviceStartsAt,
          estimatedRestorationAt, provider, details, imageDataUrls,
        }, deliveryChannels);

        return res.status(201).json({
          id, reference, title, utility, type, area, areas, areaLocations, status, details, location, serviceStatus, provider, priority, serviceStartsAt, estimatedRestorationAt, latitude, longitude,
          scheduledAt, publicationStatus, channels: selectedChannels,
          facebookUrl: socialLinksForAdvisory(id).find(link => link.startsWith("Facebook: "))?.slice("Facebook: ".length) ?? null,
          instagramUrl: socialLinksForAdvisory(id).find(link => link.startsWith("Instagram: "))?.slice("Instagram: ".length) ?? null,
          ...delivery,
        });
      } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Could not publish advisory." }); }
    });
    app.get("/advisories/:id/email-delivery", requireUtility(utility), (req, res) => {
      const advisory = database.prepare("SELECT id FROM advisories WHERE id = ? AND utility = ?")
        .get(Number(req.params.id), utility) as { id: number } | undefined;
      if (!advisory) return res.status(404).json({ error: "Advisory not found." });
      const rows = database.prepare(`
        SELECT deliveries.status, deliveries.error_message, deliveries.attempt_count, deliveries.sent_at,
          users.name AS recipient_name
        FROM email_deliveries AS deliveries
        JOIN users ON users.id = deliveries.resident_id
        WHERE deliveries.advisory_id = ?
        ORDER BY deliveries.id
      `).all(advisory.id) as Array<{ status: "pending" | "sent" | "failed"; error_message: string | null; attempt_count: number; sent_at: string | null; recipient_name: string }>;
      return res.json(summarizeEmailDeliveries(rows));
    });
    app.post("/advisories/:id/email-delivery/retry", requireUtility(utility), async (req, res) => {
      // ADDED: Fetch the saved image too, so retrying a failed email preserves its attachment.
      const advisory = database.prepare(`
        SELECT id, reference, title, type, area, details, location, service_status, provider,
          service_starts_at, estimated_restoration_at, image_data_url
        FROM advisories WHERE id = ? AND utility = ?
      `).get(Number(req.params.id), utility) as {
        id: number;
        reference: string;
        title: string;
        area: string;
        details: string;
        type: string;
        location: string;
        service_status: string;
        provider: string;
        service_starts_at: string | null;
        estimated_restoration_at: string | null;
        image_data_url: string | null;
      } | undefined;
      if (!advisory) return res.status(404).json({ error: "Advisory not found." });
      try {
        const recipientProfiles = supabaseConfigured()
          ? await syncResidentProfiles(supabaseAdmin())
          : undefined;
        // ADDED: Pass the originally saved image before the `failedOnly` flag.
        const emailDelivery = await deliverAdvisoryEmails(
          portal,
          utility,
          advisory.id,
          advisory.reference,
          advisory.title,
          advisory.area,
          formatAdvisoryDetails({
            type: advisory.type,
            location: advisory.location,
            serviceStatus: advisory.service_status,
            area: advisory.area,
            serviceStartsAt: advisory.service_starts_at,
            estimatedRestorationAt: advisory.estimated_restoration_at,
            provider: advisory.provider,
            details: advisory.details,
          }),
          readStoredAnnouncementImages(advisory.image_data_url),
          true,
          socialLinksForAdvisory(advisory.id),
          recipientProfiles,
        );
        return res.json(emailDelivery);
      } catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : "Could not retry email delivery." });
      }
    });
// ADDED: Report which social publishing platforms are configured for this utility.
app.get("/social/status", requireUtility(utility), (_req, res) => {
  return res.json(socialConfiguration(portal));
});

// ADDED: Publish or retry publishing an advisory to configured social media accounts.
app.post("/advisories/:id/social-publish", requireUtility(utility), async (req, res) => {
  const advisory = database.prepare(`
    SELECT id, reference, title, type, area, details, location, service_status,
      provider, service_starts_at, estimated_restoration_at, image_data_url
    FROM advisories WHERE id = ? AND utility = ?
  `).get(Number(req.params.id), utility) as {
    id: number;
    reference: string;
    title: string;
    type: string;
    area: string;
    details: string;
    location: string;
    service_status: string;
    provider: string;
    service_starts_at: string | null;
    estimated_restoration_at: string | null;
    image_data_url: string | null;
  } | undefined;
  if (!advisory) return res.status(404).json({ error: "Advisory not found." });
  const requestedPlatforms = req.body?.platforms;
  if (requestedPlatforms !== undefined &&
      (!Array.isArray(requestedPlatforms) ||
       requestedPlatforms.length === 0 ||
       requestedPlatforms.some((platform: unknown) => platform !== "facebook" && platform !== "instagram"))) {
    return res.status(400).json({ error: "Choose Facebook or Instagram to publish." });
  }
  const platforms = requestedPlatforms === undefined
    ? ["facebook"] as SocialPlatform[]
    : [...new Set(requestedPlatforms as SocialPlatform[])];
  try {
    const savedInstagramPost = platforms.length === 1 && platforms[0] === "instagram"
      ? database.prepare(`
          SELECT post_id, permalink_url FROM social_posts
          WHERE advisory_id = ? AND platform = 'instagram'
        `).get(advisory.id) as { post_id: string; permalink_url: string | null } | undefined
      : undefined;
    const storedImages = readStoredAnnouncementImages(advisory.image_data_url);
    const retryImagesProvided = req.body?.imageDataUrls !== undefined;
    const retryImages = retryImagesProvided ? parseAnnouncementImages(req.body.imageDataUrls) : storedImages;
    if (retryImagesProvided && retryImages.length !== storedImages.length) {
      return res.status(400).json({ error: "Instagram retry images must match the advisory's saved image count." });
    }
    if (!savedInstagramPost && retryImagesProvided) {
      database.prepare("UPDATE advisories SET image_data_url = ? WHERE id = ?")
        .run(serializeAnnouncementImages(retryImages), advisory.id);
    }
    const resolvedInstagramUrl = savedInstagramPost
      ? savedInstagramPost.permalink_url ?? await resolveInstagramPermalink(portal, savedInstagramPost.post_id)
      : null;
    const socialDelivery: SocialDeliverySummary = savedInstagramPost
      ? {
          status: resolvedInstagramUrl ? "published" : "partial",
          platforms: [{
            platform: "instagram",
            status: "published",
            id: savedInstagramPost.post_id,
            ...(resolvedInstagramUrl
              ? { permalinkUrl: resolvedInstagramUrl }
              : { message: "Instagram already published this post, but its link is not available yet. Try again shortly." }),
          }],
        }
      : await publishAnnouncementToSocial(
          portal,
          utility,
          advisory.id,
          advisory.reference,
          advisory.title,
          advisory.area,
          formatAdvisoryDetails({
            type: advisory.type,
            location: advisory.location,
            serviceStatus: advisory.service_status,
            area: advisory.area,
            serviceStartsAt: advisory.service_starts_at,
            estimatedRestorationAt: advisory.estimated_restoration_at,
            provider: advisory.provider,
            details: advisory.details,
          }),
          retryImages,
          platforms,
        );
    recordSocialPosts(advisory.id, socialDelivery);
    if (supabaseConfigured()) {
      const supabase = supabaseAdmin();
      const { data: supabaseAdvisory, error: advisoryError } = await supabase.from("advisories")
        .select("id").eq("reference", advisory.reference).eq("utility", utility).single();
      if (advisoryError || !supabaseAdvisory) throw advisoryError ?? new Error("Supabase advisory not found.");
      const posts = database.prepare(`
        SELECT platform, post_id, permalink_url, published_at
        FROM social_posts WHERE advisory_id = ?
      `).all(advisory.id) as Array<{
        platform: string;
        post_id: string;
        permalink_url: string | null;
        published_at: string;
      }>;
      if (posts.length) {
        const { error } = await supabase.from("social_posts").upsert(posts.map(post => ({
          advisory_id: supabaseAdvisory.id,
          platform: post.platform,
          post_id: post.post_id,
          permalink_url: post.permalink_url,
          published_at: post.published_at,
        })), { onConflict: "advisory_id,platform" });
        if (error) throw error;
      }
    }
    return res.json({ ...socialDelivery, socialLinks: socialLinksForAdvisory(advisory.id) });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Could not publish to social media." });
  }
});

app.patch("/advisories/:id/status", requireUtility(utility), (req, res) => {
      const status = req.body?.status;
      if (!["Scheduled", "Active", "Resolved", "Cancelled"].includes(status)) return res.status(400).json({ error: "Unsupported advisory status." });
      const serviceStatus = status === "Resolved" || status === "Cancelled"
        ? status
        : status === "Active" ? "Active Service Interruption" : null;
      const result = database.prepare("UPDATE advisories SET status = ?, service_status = COALESCE(?, service_status) WHERE id = ? AND utility = ? AND publication_status = 'published'")
        .run(status, serviceStatus, Number(req.params.id), utility);
      return Number(result.changes) ? res.json({ ok: true }) : res.status(404).json({ error: "Advisory not found." });
    });
    app.get("/work-orders", requireUtility(utility), (_req, res) => {
      const rows = database.prepare("SELECT id, reference, title, utility, area, status, starts_at, ends_at FROM work_orders WHERE utility = ? ORDER BY starts_at").all(utility) as Row[];
      return res.json(decorateRows(rows));
    });
    app.post("/work-orders", requireUtility(utility), (req, res) => {
      try {
        const title = required(req.body?.title, "Work order title");
        const area = required(req.body?.area, "Affected service area");
        const startsAt = required(req.body?.startsAt, "Start time");
        const endsAt = required(req.body?.endsAt, "End time");
        const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
        if (Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.parse(startsAt)) return res.status(400).json({ error: "End time must be later than start time." });
        const reference = `${portal === "water" ? "WD" : "CE"}-WO-${Date.now().toString(36).toUpperCase()}`;
        const id = Number(database.prepare("INSERT INTO work_orders (reference, title, utility, area, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(reference, title, utility, area, description, startsAt, endsAt).lastInsertRowid);
        return res.status(201).json({ id, reference, title, utility, area, description, startsAt, endsAt, status: "Scheduled" });
      } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Could not create work order." }); }
    });
    app.get("/reports", requireUtility(utility), (_req, res) => {
      const rows = database.prepare("SELECT id, reference, title, utility, area, status, created_at FROM reports WHERE utility = ? ORDER BY id DESC").all(utility) as Row[];
      return res.json(decorateRows(rows));
    });
    app.patch("/reports/:id/status", requireUtility(utility), (req, res) => {
      const status = req.body?.status;
      if (!["Received", "Under investigation", "Crew dispatched", "Resolved"].includes(status)) return res.status(400).json({ error: "Unsupported report status." });
      const result = database.prepare("UPDATE reports SET status = ? WHERE id = ? AND utility = ?").run(status, Number(req.params.id), utility);
      return Number(result.changes) ? res.json({ ok: true }) : res.status(404).json({ error: "Report not found." });
    });
    if (portal === "water") {
      app.get("/network", requireUtility(utility), (_req, res) => {
        const rows = database.prepare("SELECT district, area, pressure_psi, reservoir_percent, recorded_at FROM network_readings WHERE utility = ? ORDER BY id").all(utility) as Row[];
        return res.json(decorateRows(rows));
      });
    }
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`[${portal}-api]`, error);
    res.status(500).json({ error: "An unexpected server error occurred." });
  });
  return app;
}

async function syncScheduledDeliveryToSupabase(
  portal: Exclude<Portal, "resident">,
  utility: string,
  reference: string,
  localAdvisoryId: number,
): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return;

  try {
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: advisory, error: advisoryError } = await supabase.from("advisories")
      .select("id").eq("reference", reference).eq("utility", utility).maybeSingle();
    if (advisoryError) throw advisoryError;
    if (!advisory) return;

    const profiles = await residentProfilesFromSupabase(supabase);
    const profileIds = new Map(profiles.map(profile => [profile.email.toLowerCase(), profile.id]));
    const localEmails = database.prepare(`
      SELECT users.email, deliveries.status, deliveries.error_message, deliveries.attempt_count,
        deliveries.sent_at, deliveries.created_at
      FROM email_deliveries AS deliveries JOIN users ON users.id = deliveries.resident_id
      WHERE deliveries.advisory_id = ?
    `).all(localAdvisoryId) as Array<{
      email: string; status: "pending" | "sent" | "failed"; error_message: string | null;
      attempt_count: number; sent_at: string | null; created_at: string;
    }>;
    const emailRows = localEmails.flatMap(row => {
      const residentId = profileIds.get(row.email.toLowerCase());
      return residentId ? [{
        advisory_id: advisory.id, resident_id: residentId, status: row.status,
        error_message: row.error_message, attempt_count: row.attempt_count,
        sent_at: row.sent_at, created_at: row.created_at,
      }] : [];
    });
    if (emailRows.length) {
      const { error } = await supabase.from("email_deliveries").upsert(emailRows, { onConflict: "advisory_id,resident_id" });
      if (error) throw error;
    }

    const posts = database.prepare(`
      SELECT platform, post_id, permalink_url, published_at FROM social_posts WHERE advisory_id = ?
    `).all(localAdvisoryId) as Array<{ platform: string; post_id: string; permalink_url: string | null; published_at: string }>;
    if (posts.length) {
      const { error } = await supabase.from("social_posts").upsert(posts.map(post => ({
        advisory_id: advisory.id, ...post,
      })), { onConflict: "advisory_id,platform" });
      if (error) throw error;
    }

    const smsRows = database.prepare(`
      SELECT users.email, deliveries.created_at, deliveries.read_at
      FROM sms_deliveries AS deliveries JOIN users ON users.id = deliveries.resident_id
      WHERE deliveries.advisory_id = ?
    `).all(localAdvisoryId) as Array<{ email: string; created_at: string; read_at: string | null }>;
    const mappedSms = smsRows.flatMap(row => {
      const residentId = profileIds.get(row.email.toLowerCase());
      return residentId ? [{ advisory_id: advisory.id, resident_id: residentId, created_at: row.created_at, read_at: row.read_at }] : [];
    });
    if (mappedSms.length) {
      const { error } = await supabase.from("sms_deliveries").upsert(mappedSms, {
        onConflict: "advisory_id,resident_id", ignoreDuplicates: true,
      });
      if (error) throw error;
    }

    const { error: updateError } = await supabase.from("advisories").update({
      publication_status: "published", status: "Active",
    }).eq("id", advisory.id).eq("utility", utility);
    if (updateError) throw updateError;
  } catch (error) {
    // Do not mark an already-published external announcement failed just because its mirror sync failed.
    console.error(`[${portal}-api] Could not sync scheduled delivery to Supabase for ${reference}:`, error);
  }
}

export function startScheduledAnnouncementWorker(portal: Exclude<Portal, "resident">): () => void {
  const utility = utilities[portal];
  let running = false;
  const processDueAnnouncements = async () => {
    if (running) return;
    running = true;
    try {
      const due = database.prepare(`
        SELECT id, reference, title, type, area, details, location, service_status,
          provider, service_starts_at, estimated_restoration_at, image_data_url, channels_json
        FROM advisories
        WHERE utility = ? AND publication_status = 'scheduled'
          AND datetime(scheduled_at) <= datetime('now')
        ORDER BY scheduled_at, id
      `).all(utility) as Array<{
        id: number;
        reference: string;
        title: string;
        type: string;
        area: string;
        details: string;
        location: string;
        service_status: string;
        provider: string;
        service_starts_at: string | null;
        estimated_restoration_at: string | null;
        image_data_url: string | null;
        channels_json: string;
      }>;

      const claimed: typeof due = [];
      database.exec("BEGIN IMMEDIATE");
      try {
        const claim = database.prepare(`
          UPDATE advisories SET publication_status = 'publishing'
          WHERE id = ? AND utility = ? AND publication_status = 'scheduled'
        `);
        for (const advisory of due) {
          if (Number(claim.run(advisory.id, utility).changes)) claimed.push(advisory);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      for (const advisory of claimed) {
        try {
          const channels = parseAnnouncementChannels(JSON.parse(advisory.channels_json));
          const recipientProfiles = supabaseConfigured()
            ? await syncResidentProfiles(supabaseAdmin())
            : undefined;
          const delivery = await publishSelectedChannels(portal, utility, {
            id: advisory.id,
            reference: advisory.reference,
            title: advisory.title,
            type: advisory.type,
            location: advisory.location,
            serviceStatus: advisory.service_status,
            area: advisory.area,
            serviceStartsAt: advisory.service_starts_at,
            estimatedRestorationAt: advisory.estimated_restoration_at,
            provider: advisory.provider,
            details: advisory.details,
            imageDataUrls: readStoredAnnouncementImages(advisory.image_data_url),
          }, channels, recipientProfiles);
          await syncScheduledDeliveryToSupabase(portal, utility, advisory.reference, advisory.id);
          database.prepare(`
            UPDATE advisories SET publication_status = 'published', status = 'Active'
            WHERE id = ? AND utility = ? AND publication_status = 'publishing'
          `).run(advisory.id, utility);
          if (delivery.emailDelivery?.failed) {
            console.error(`[${portal}-api] Scheduled Gmail delivery failed for advisory ${advisory.reference}.`);
          }
          for (const post of delivery.socialDelivery?.platforms ?? []) {
            if (post.status === "failed" || post.status === "not_configured") {
              console.error(`[${portal}-api] Scheduled ${post.platform} delivery for advisory ${advisory.reference}: ${post.message || post.status}.`);
            }
          }
        } catch (error) {
          database.prepare(`
            UPDATE advisories SET publication_status = 'failed'
            WHERE id = ? AND utility = ? AND publication_status = 'publishing'
          `).run(advisory.id, utility);
          console.error(`[${portal}-api] Scheduled announcement ${advisory.reference} failed: ${error instanceof Error ? error.message : "Unknown error."}`);
        }
      }
    } catch (error) {
      console.error(`[${portal}-api] Scheduled announcement worker failed: ${error instanceof Error ? error.message : "Unknown error."}`);
    } finally {
      running = false;
    }
  };

  void processDueAnnouncements();
  const interval = setInterval(() => void processDueAnnouncements(), 15_000);
  interval.unref();
  return () => clearInterval(interval);
}

function authenticate(expectedRole: Actor["role"]) {
  return async (req: Request, res: Response<unknown, Locals>, next: NextFunction) => {
    const authorization = req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    try {
      const actor = await actorForAccessToken(token);
      if (!actor || actor.role !== expectedRole) return res.status(401).json({ error: "Please sign in to continue." });
      res.locals.actor = actor;
      next();
    } catch (error) {
      console.error("[api] Supabase token validation failed:", error);
      return res.status(503).json({ error: "Could not verify your Supabase session. Check the server-side Supabase configuration." });
    }
  };
}

function requireUtility(utility: string) {
  return async (req: Request, res: Response<unknown, Locals>, next: NextFunction) => {
    const authorization = req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    try {
      const actor = await actorForAccessToken(token);
      if (!actor || actor.role !== "admin" || actor.utility !== utility) return res.status(401).json({ error: "A matching utility administrator must sign in." });
      res.locals.actor = actor;
      next();
    } catch (error) {
      console.error("[api] Supabase token validation failed:", error);
      return res.status(503).json({ error: "Could not verify your Supabase session. Check the server-side Supabase configuration." });
    }
  };
}

async function actorForAccessToken(token: string): Promise<Actor | undefined> {
  if (!token) return undefined;
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return findActorForToken(token);

  const supabase = supabaseAdmin();
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return undefined;
  const { data: profile, error: profileError } = await supabase.from("profiles")
    .select("id,name,email,role,utility,phone_number,address,barangay,purok,district,city,postal_code,profile_image,sms_alerts,notify_maintenance,notify_email_digest,immediate_email_alerts,terms_accepted_at")
    .eq("id", user.id).single();
  if (profileError) throw profileError;
  if (!profile) return undefined;

  const existing = database.prepare(`
    SELECT id FROM users WHERE lower(email) = lower(?) AND role = ?
      AND (utility IS ? OR utility = ?) LIMIT 1
  `).get(profile.email, profile.role, profile.utility, profile.utility) as { id: number } | undefined;
  if (existing) {
    return database.prepare(`
      SELECT id,name,email,role,utility,phone_number,address,barangay,purok,district,city,
        postal_code,profile_image,sms_alerts,notify_maintenance,notify_email_digest,
        immediate_email_alerts,terms_accepted_at
      FROM users WHERE id = ?
    `).get(existing.id) as Actor;
  }

  database.prepare(`
    INSERT OR IGNORE INTO users
      (name,email,password_hash,role,utility,phone_number,address,barangay,purok,district,city,postal_code,
       profile_image,sms_alerts,notify_maintenance,notify_email_digest,immediate_email_alerts,terms_accepted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    profile.name, profile.email, hashPassword(randomBytes(32).toString("hex")),
    profile.role, profile.utility, profile.phone_number, profile.address, profile.barangay, profile.purok,
    profile.district, profile.city, profile.postal_code, profile.profile_image,
    Number(profile.sms_alerts), Number(profile.notify_maintenance), Number(profile.notify_email_digest),
    Number(profile.immediate_email_alerts), profile.terms_accepted_at,
  );
  return database.prepare(`
    SELECT id,name,email,role,utility,phone_number,address,barangay,purok,district,city,
      postal_code,profile_image,sms_alerts,notify_maintenance,notify_email_digest,
      immediate_email_alerts,terms_accepted_at
    FROM users WHERE lower(email) = lower(?) AND role = ?
      AND (utility IS ? OR utility = ?) LIMIT 1
  `).get(profile.email, profile.role, profile.utility, profile.utility) as Actor | undefined;
}

function gmailFrontendUrl(portal: Exclude<Portal, "resident">): URL {
  const variable = portal === "cepalco" ? "CEPALCO_FRONTEND_URL" : "WATER_FRONTEND_URL";
  const defaultPort = portal === "cepalco" ? 5174 : 5175;
  const configuredUrl = process.env[variable]?.trim() || `http://localhost:${defaultPort}`;
  const frontend = new URL(configuredUrl);
  if (frontend.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && frontend.protocol === "http:" && ["localhost", "127.0.0.1"].includes(frontend.hostname))) {
    throw new Error(`${variable} must use HTTPS outside local development.`);
  }
  return frontend;
}

function gmailFrontendRedirect(
  frontend: URL,
  portal: Exclude<Portal, "resident">,
  result: "connected" | "error",
  reason?: GmailConnectionFailure | "cancelled" | "google_error" | "invalid_state",
): string {
  frontend.search = "";
  frontend.hash = "";
  frontend.searchParams.set("portal", portal);
  frontend.searchParams.set("view", "portal");
  frontend.searchParams.set("page", "publish");
  frontend.searchParams.set("gmail", result);
  if (result === "error" && reason) frontend.searchParams.set("gmailError", reason);
  return frontend.toString();
}

type EmailDeliveryRow = {
  status: "pending" | "sent" | "failed";
  error_message: string | null;
  attempt_count: number;
  sent_at: string | null;
  recipient_name: string;
};

function summarizeEmailDeliveries(rows: EmailDeliveryRow[]) {
  const sent = rows.filter(row => row.status === "sent").length;
  const failed = rows.filter(row => row.status === "failed").length;
  const pending = rows.filter(row => row.status === "pending").length;
  const status = rows.length === 0
    ? "no_recipients"
    : pending > 0
      ? "pending"
      : failed === 0
        ? "sent"
        : sent > 0
          ? "partial"
          : "failed";
  const errors = new Map<string, number>();
  for (const row of rows) {
    if (row.error_message) errors.set(row.error_message, (errors.get(row.error_message) ?? 0) + 1);
  }
  return {
    status,
    attempted: sent + failed,
    sent,
    failed,
    pending,
    errors: [...errors].map(([message, count]) => ({ message, count })),
    deliveries: rows.map(row => ({
      status: row.status,
      error: row.error_message,
      attempts: row.attempt_count,
      sentAt: row.sent_at,
      recipientName: row.recipient_name,
    })),
  };
}

async function deliverAdvisoryEmails(
  portal: Exclude<Portal, "resident">,
  utility: string,
  advisoryId: number,
  reference: string,
  title: string,
  area: string,
  details: string,
  imageDataUrls: string[] = [],
  failedOnly = false,
  socialLinks: string[] = [],
  recipientProfiles?: EmailRecipient[],
) {
  if (imageDataUrls.length === 0) throw new Error("Add an announcement image before sending advisory emails.");
  const localRecipients = recipientProfiles === undefined
    ? database.prepare(`
        SELECT users.id, users.name, users.email FROM users
        WHERE users.role = 'resident'
        ORDER BY id
      `).all() as Array<{ id: number; name: string; email: string }>
    : recipientProfiles.map(profile => {
        const localUser = database.prepare(`
          SELECT id FROM users
          WHERE role = 'resident' AND lower(trim(email)) = lower(trim(?))
          LIMIT 1
        `).get(profile.email) as { id: number } | undefined;
        if (!localUser) {
          throw new Error(`Supabase resident ${profile.email} was not synchronized to the local delivery index.`);
        }
        return { id: localUser.id, name: profile.name, email: profile.email };
      });
  const failedRecipientIds = failedOnly
    ? new Set((database.prepare(`
        SELECT resident_id FROM email_deliveries
        WHERE advisory_id = ? AND status = 'failed'
      `).all(advisoryId) as Array<{ resident_id: number }>).map(row => row.resident_id))
    : null;
  const recipients = failedRecipientIds
    ? localRecipients.filter(recipient => failedRecipientIds.has(recipient.id))
    : localRecipients;
  if (failedOnly) {
    const resetFailedDelivery = database.prepare(`
      UPDATE email_deliveries SET status = 'pending', error_message = NULL
      WHERE advisory_id = ? AND resident_id = ? AND status = 'failed'
    `);
    for (const recipient of recipients) resetFailedDelivery.run(advisoryId, recipient.id);
  } else {
    for (const resident of recipients) {
      database.prepare(`
        INSERT OR IGNORE INTO email_deliveries (advisory_id, resident_id, status)
        VALUES (?, ?, 'pending')
      `).run(advisoryId, resident.id);
    }
  }
  if (recipients.length === 0) return summarizeEmailDeliveries([]);

  const connection = database.prepare("SELECT encrypted_refresh_token FROM gmail_connections WHERE utility = ?")
    .get(utility) as { encrypted_refresh_token: string } | undefined;
  let refreshToken: string | null = null;
  let connectionError: string | null = null;
  if (!connection) {
    connectionError = "No Gmail sending account is connected for this utility.";
  } else {
    try {
      refreshToken = decryptRefreshToken(connection.encrypted_refresh_token);
    } catch (error) {
      connectionError = error instanceof Error ? error.message : "Reconnect the Gmail sending account.";
    }
  }

  for (const recipient of recipients) {
    const update = database.prepare(`
      UPDATE email_deliveries
      SET status = ?, error_message = ?, attempt_count = attempt_count + 1,
        sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE advisory_id = ? AND resident_id = ?
    `);
    if (!refreshToken) {
      update.run("failed", connectionError, "failed", advisoryId, recipient.id);
      continue;
    }
    try {
      await sendGmailMessage(
        portal,
        refreshToken,
        recipient.email,
        `${utility} advisory: ${title}`,
        `${title}\n\n${area}\n\n${details}\n\nReference: ${reference}${socialLinks.length ? `\n\nSocial post links:\n${socialLinks.join("\n")}` : ""}`,
        imageDataUrls,
      );
      update.run("sent", null, "sent", advisoryId, recipient.id);
    } catch (error) {
      update.run("failed", safeGmailError(error), "failed", advisoryId, recipient.id);
    }
  }

  const rows = database.prepare(`
    SELECT deliveries.status, deliveries.error_message, deliveries.attempt_count,
      deliveries.sent_at, users.name AS recipient_name
    FROM email_deliveries AS deliveries
    JOIN users ON users.id = deliveries.resident_id
    WHERE deliveries.advisory_id = ?
    ORDER BY deliveries.id
  `).all(advisoryId) as EmailDeliveryRow[];
  return summarizeEmailDeliveries(rows);
}
