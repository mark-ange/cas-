import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { parseGmailImageAttachment } from "./gmail.js";

export type SocialPlatformResult = {
  platform: "facebook" | "instagram";
  status: "published" | "failed" | "not_configured";
  message?: string;
  id?: string;
  permalinkUrl?: string;
};

export type SocialDeliverySummary = {
  status: "published" | "partial" | "failed" | "not_configured";
  platforms: SocialPlatformResult[];
};
export type SocialPlatform = SocialPlatformResult["platform"];

function environment(portal: string, name: string): string {
  const utilityPrefix = portal === "cepalco" ? "CEPALCO" : portal === "water" ? "WATER" : "";
  const scopedName = utilityPrefix ? `${utilityPrefix}_${name}` : "";
  let value = (scopedName ? process.env[scopedName] : undefined)?.trim() ?? process.env[name]?.trim() ?? "";
  if (!value && name === "META_PUBLIC_BASE_URL") {
    value = process.env.ETA_PUBLIC_BASE_URL?.trim() ?? "";
  }
  return value;
}

function graphVersion(portal: string): string {
  return environment(portal, "META_GRAPH_API_VERSION") || "v24.0";
}

function graphBase(portal: string): string {
  return `https://graph.facebook.com/${graphVersion(portal)}`;
}

function advisoryMessage(title: string, area: string, details: string, reference: string): string {
  return `${title}\n\nAffected area: ${area}\n\n${details}\n\nReference: ${reference}`;
}

async function fetchPermalink(
  portal: string,
  id: string,
  fields: "permalink_url" | "permalink",
  accessToken: string,
  attempts = 3,
): Promise<string | null> {
  let lastFailure = "Meta returned no public permalink.";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${graphBase(portal)}/${encodeURIComponent(id)}?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`);
      if (response.ok) {
        const result = await response.json() as { permalink_url?: string; permalink?: string };
        const permalink = fields === "permalink_url" ? result.permalink_url : result.permalink;
        if (typeof permalink === "string" && /^https:\/\/(?:www\.)?(?:facebook\.com|instagram\.com)\//.test(permalink)) {
          return permalink;
        }
      } else {
        lastFailure = `Meta permalink lookup returned HTTP ${response.status}.`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : "Meta permalink lookup failed.";
    }
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
  }
  console.warn(`[social] Could not resolve ${fields} for published media ${id}: ${lastFailure}`);
  return null;
}

export async function resolveInstagramPermalink(portal: string, id: string): Promise<string | null> {
  const tokens = [
    environment(portal, "META_INSTAGRAM_ACCESS_TOKEN"),
    environment(portal, "META_FACEBOOK_PAGE_ACCESS_TOKEN"),
  ].filter((token, index, values): token is string => Boolean(token) && values.indexOf(token) === index);
  for (const token of tokens) {
    const permalink = await fetchPermalink(portal, id, "permalink", token, 8);
    if (permalink?.startsWith("https://www.instagram.com/") ||
        permalink?.startsWith("https://instagram.com/")) return permalink;
  }
  return null;
}

function facebookPermalinkFromPostId(pageId: string, postId: string): string | null {
  const pagePrefix = `${pageId}_`;
  if (!postId.startsWith(pagePrefix) || !postId.slice(pagePrefix.length)) return null;
  return `https://www.facebook.com/${encodeURIComponent(pageId)}/posts/${encodeURIComponent(postId.slice(pagePrefix.length))}`;
}

async function publishToFacebook(
  portal: string,
  title: string,
  area: string,
  details: string,
  reference: string,
  imageDataUrls: string[],
): Promise<SocialPlatformResult> {
  const pageId = environment(portal, "META_FACEBOOK_PAGE_ID");
  const accessToken = environment(portal, "META_FACEBOOK_PAGE_ACCESS_TOKEN");
  if (!pageId || !accessToken) {
    return { platform: "facebook", status: "not_configured", message: "Facebook page publishing is not configured." };
  }

  const message = advisoryMessage(title, area, details, reference);
  try {
    if (imageDataUrls.length > 1) {
      const mediaIds: string[] = [];
      for (const [index, imageDataUrl] of imageDataUrls.entries()) {
        const attachment = parseGmailImageAttachment(imageDataUrl);
        if (!attachment) {
          return { platform: "facebook", status: "failed", message: "An announcement image is invalid." };
        }
        const photoForm = new FormData();
        photoForm.append("access_token", accessToken);
        photoForm.append("published", "false");
        photoForm.append("source", new Blob([new Uint8Array(attachment.content)], { type: attachment.mimeType }), `announcement-${index + 1}.${attachment.filename.split(".").at(-1)}`);
        const photoResponse = await fetch(`${graphBase(portal)}/${encodeURIComponent(pageId)}/photos`, {
          method: "POST",
          body: photoForm,
        });
        const photo = await photoResponse.json() as { id?: string; error?: { message?: string } };
        if (!photoResponse.ok || !photo.id) {
          return { platform: "facebook", status: "failed", message: photo.error?.message || "Facebook could not upload an announcement image." };
        }
        mediaIds.push(photo.id);
      }

      const postResponse = await fetch(`${graphBase(portal)}/${encodeURIComponent(pageId)}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          message,
          access_token: accessToken,
          ...Object.fromEntries(mediaIds.map((id, index) => [`attached_media[${index}]`, JSON.stringify({ media_fbid: id })])),
        }),
      });
      const post = await postResponse.json() as { id?: string; error?: { message?: string } };
      if (!postResponse.ok || !post.id) {
        return { platform: "facebook", status: "failed", message: post.error?.message || "Facebook could not publish the image album." };
      }
      const permalinkUrl = await fetchPermalink(portal, post.id, "permalink_url", accessToken);
      return {
        platform: "facebook",
        status: "published",
        id: post.id,
        ...(permalinkUrl ? { permalinkUrl } : { message: "Facebook published the post, but its public link could not be confirmed." }),
      };
    }
    if (imageDataUrls.length === 1) {
      const attachment = parseGmailImageAttachment(imageDataUrls[0]);
      if (!attachment) {
        return { platform: "facebook", status: "failed", message: "The announcement image is invalid." };
      }
      const form = new FormData();
      form.append("message", message);
      form.append("access_token", accessToken);
      form.append("source", new Blob([new Uint8Array(attachment.content)], { type: attachment.mimeType }), attachment.filename);
      const response = await fetch(`${graphBase(portal)}/${encodeURIComponent(pageId)}/photos`, {
        method: "POST",
        body: form,
      });
      const result = await response.json() as { id?: string; post_id?: string; error?: { message?: string } };
      if (!response.ok || (!result.id && !result.post_id)) {
        return { platform: "facebook", status: "failed", message: result.error?.message || "Facebook could not publish the image." };
      }
      const id = result.post_id ?? result.id!;
      const permalinkUrl = await fetchPermalink(portal, id, "permalink_url", accessToken);
      const confirmedPermalink = permalinkUrl ?? facebookPermalinkFromPostId(pageId, id);
      return {
        platform: "facebook",
        status: "published",
        id,
        ...(confirmedPermalink ? { permalinkUrl: confirmedPermalink } : { message: "Facebook published the post, but its public link could not be confirmed." }),
      };
    }

    const response = await fetch(`${graphBase(portal)}/${encodeURIComponent(pageId)}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message, access_token: accessToken }),
    });
    const result = await response.json() as { id?: string; error?: { message?: string } };
    if (!response.ok || !result.id) {
      return { platform: "facebook", status: "failed", message: result.error?.message || "Facebook could not publish the announcement." };
    }
    const permalinkUrl = await fetchPermalink(portal, result.id, "permalink_url", accessToken);
    const confirmedPermalink = permalinkUrl ?? facebookPermalinkFromPostId(pageId, result.id);
    return {
      platform: "facebook",
      status: "published",
      id: result.id,
      ...(confirmedPermalink ? { permalinkUrl: confirmedPermalink } : { message: "Facebook published the post, but its public link could not be confirmed." }),
    };
  } catch (error) {
    return { platform: "facebook", status: "failed", message: error instanceof Error ? error.message : "Facebook publishing failed." };
  }
}

async function uploadToSupabaseStorage(
  advisoryId: number,
  imageDataUrl: string,
  imageIndex: number,
): Promise<string | null> {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return null;

  try {
    const attachment = parseGmailImageAttachment(imageDataUrl);
    if (!attachment) return null;

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const extension = attachment.mimeType === "image/png" ? "png" : attachment.mimeType === "image/webp" ? "webp" : "jpg";
    const filename = `advisory-${advisoryId}-${imageIndex + 1}-${Date.now()}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("advisories")
      .upload(filename, Buffer.from(attachment.content), {
        contentType: attachment.mimeType,
        upsert: true,
      });

    if (uploadError) {
      if (uploadError.message?.toLowerCase().includes("bucket not found")) {
        await supabase.storage.createBucket("advisories", { public: true });
        const { error: retryError } = await supabase.storage
          .from("advisories")
          .upload(filename, Buffer.from(attachment.content), {
            contentType: attachment.mimeType,
            upsert: true,
          });
        if (retryError) {
          console.error("[social] Supabase storage upload retry failed:", retryError);
          return null;
        }
      } else {
        console.error("[social] Supabase storage upload failed:", uploadError);
        return null;
      }
    }

    const { data: { publicUrl } } = supabase.storage.from("advisories").getPublicUrl(filename);
    return publicUrl;
  } catch (err) {
    console.error("[social] Error uploading image to Supabase storage:", err);
    return null;
  }
}

async function waitForInstagramMediaReady(
  portal: string,
  mediaId: string,
  accessToken: string,
): Promise<{ ready: boolean; message?: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetchInstagramGraph(
      "check Instagram image processing status",
      `${graphBase(portal)}/${encodeURIComponent(mediaId)}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`,
    );
    const result = await response.json() as {
      status_code?: string;
      status?: string;
      error?: { message?: string };
    };
    if (!response.ok) {
      return {
        ready: false,
        message: result.error?.message || `Instagram media status check returned HTTP ${response.status}.`,
      };
    }

    const status = result.status_code?.toUpperCase();
    if (status === "FINISHED") return { ready: true };
    if (status === "ERROR" || status === "EXPIRED") {
      return {
        ready: false,
        message: result.status || `Instagram media processing ended with status ${status}.`,
      };
    }
    if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return {
    ready: false,
    message: "Instagram is still processing the image. Wait a little and retry publishing.",
  };
}

async function fetchInstagramGraph(
  operation: string,
  input: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network request failed.";
    const cause = error instanceof Error && "cause" in error && error.cause instanceof Error
      ? ` (${error.cause.message})`
      : "";
    throw new Error(`Could not reach Meta Graph API to ${operation}: ${message}${cause}. Check outbound HTTPS access from the API server.`);
  }
}

async function publishToInstagram(
  portal: string,
  title: string,
  area: string,
  details: string,
  reference: string,
  imageDataUrls: string[],
  advisoryId: number,
  publicBaseUrl: string,
): Promise<SocialPlatformResult> {
  const accountId = environment(portal, "META_INSTAGRAM_BUSINESS_ACCOUNT_ID");
  const candidateTokens = [
    environment(portal, "META_INSTAGRAM_ACCESS_TOKEN"),
    environment(portal, "META_FACEBOOK_PAGE_ACCESS_TOKEN"),
  ].filter((token, index, self): token is string => Boolean(token) && self.indexOf(token) === index);

  if (!accountId || candidateTokens.length === 0) {
    return { platform: "instagram", status: "not_configured", message: "Instagram publishing is not configured." };
  }
  if (imageDataUrls.length === 0) {
    return { platform: "instagram", status: "failed", message: "Instagram publishing requires an announcement image." };
  }

  const imageUrls: string[] = [];
  for (const [index, imageDataUrl] of imageDataUrls.entries()) {
    let imageUrl: string | null = await uploadToSupabaseStorage(advisoryId, imageDataUrl, index);
    if (!imageUrl) {
      const configuredPublicBaseUrl = environment(portal, "META_PUBLIC_BASE_URL") || publicBaseUrl;
      if (!configuredPublicBaseUrl) {
        return { platform: "instagram", status: "failed", message: "Instagram publishing requires either Supabase Storage or META_PUBLIC_BASE_URL to host the announcement image." };
      }
      const version = createHash("sha256").update(imageDataUrl).digest("hex").slice(0, 12);
      imageUrl = `${configuredPublicBaseUrl.replace(/\/$/, "")}/advisories/${advisoryId}${index === 0 ? "/image" : `/images/${index}`}?v=${version}`;
    }
    imageUrls.push(imageUrl);
  }

  const caption = advisoryMessage(title, area, details, reference);
  try {
    let container: { id?: string; error?: { message?: string; code?: number } } | null = null;
    let activeToken = candidateTokens[0];

    for (const token of candidateTokens) {
      activeToken = token;
      let containerResponseOk = false;
      if (imageUrls.length === 1) {
        const containerResponse = await fetchInstagramGraph("create an Instagram image container", `${graphBase(portal)}/${encodeURIComponent(accountId)}/media`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ image_url: imageUrls[0], caption, access_token: token }),
        });
        containerResponseOk = containerResponse.ok;
        container = await containerResponse.json() as { id?: string; error?: { message?: string; code?: number } };
      } else {
        const children: string[] = [];
        for (const imageUrl of imageUrls) {
          const childResponse = await fetchInstagramGraph("create an Instagram carousel image", `${graphBase(portal)}/${encodeURIComponent(accountId)}/media`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ image_url: imageUrl, is_carousel_item: "true", access_token: token }),
          });
          const child = await childResponse.json() as { id?: string; error?: { message?: string; code?: number } };
          if (!childResponse.ok || !child.id) {
            container = { error: child.error ?? { message: "Instagram could not create an image carousel item." } };
            break;
          }
          children.push(child.id);
        }
        if (children.length === imageUrls.length) {
          const carouselResponse = await fetchInstagramGraph("create an Instagram carousel", `${graphBase(portal)}/${encodeURIComponent(accountId)}/media`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              media_type: "CAROUSEL",
              children: children.join(","),
              caption,
              access_token: token,
            }),
          });
          containerResponseOk = carouselResponse.ok;
          container = await carouselResponse.json() as { id?: string; error?: { message?: string; code?: number } };
        }
      }
      if (containerResponseOk && container?.id) {
        break;
      }
      const isAuthError = container?.error?.code === 190 || /access token|decrypted|expired|invalid/i.test(container?.error?.message ?? "");
      if (!isAuthError) {
        break;
      }
    }

    if (!container?.id) {
      return { platform: "instagram", status: "failed", message: container?.error?.message || "Instagram could not create the media container." };
    }

    const readiness = await waitForInstagramMediaReady(portal, container.id, activeToken);
    if (!readiness.ready) {
      return { platform: "instagram", status: "failed", message: readiness.message || "Instagram media is not ready to publish." };
    }

    const publishResponse = await fetchInstagramGraph("publish the Instagram media container", `${graphBase(portal)}/${encodeURIComponent(accountId)}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: container.id, access_token: activeToken }),
    });
    const published = await publishResponse.json() as { id?: string; error?: { message?: string } };
    if (!publishResponse.ok || !published.id) {
      return { platform: "instagram", status: "failed", message: published.error?.message || "Instagram could not publish the announcement." };
    }
    const permalinkUrl = await resolveInstagramPermalink(portal, published.id);
    return { platform: "instagram", status: "published", id: published.id, ...(permalinkUrl ? { permalinkUrl } : { message: "Instagram published the post, but Meta did not return its permalink. Check the connected account permissions." }) };
  } catch (error) {
    return { platform: "instagram", status: "failed", message: error instanceof Error ? error.message : "Instagram publishing failed." };
  }
}

export async function publishAnnouncementToSocial(
  portal: string,
  _utility: string,
  advisoryId: number,
  reference: string,
  title: string,
  area: string,
  details: string,
  imageDataUrls: string[] | null,
  selectedPlatforms: SocialPlatform[] = ["facebook"],
): Promise<SocialDeliverySummary> {
  const images = imageDataUrls ?? [];
  const platforms = await Promise.all(selectedPlatforms.map(platform => platform === "facebook"
    ? publishToFacebook(portal, title, area, details, reference, images)
    : publishToInstagram(portal, title, area, details, reference, images, advisoryId, environment(portal, "META_PUBLIC_BASE_URL"))));

  const configuredPlatforms = platforms.filter(result => result.status !== "not_configured");
  const published = platforms.filter(result => result.status === "published").length;

  let status: SocialDeliverySummary["status"];
  if (configuredPlatforms.length === 0) status = "not_configured";
  else if (published === configuredPlatforms.length && published > 0) status = "published";
  else if (published > 0) status = "partial";
  else status = "failed";

  return { status, platforms };
}

export function socialConfiguration(portal: string) {
  const facebook = Boolean(environment(portal, "META_FACEBOOK_PAGE_ID") && environment(portal, "META_FACEBOOK_PAGE_ACCESS_TOKEN"));
  const instagramAccessToken = environment(portal, "META_INSTAGRAM_ACCESS_TOKEN");
  const pageAccessToken = environment(portal, "META_FACEBOOK_PAGE_ACCESS_TOKEN");
  const hasPublicStorage = Boolean(
    (process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) ||
    environment(portal, "META_PUBLIC_BASE_URL")
  );
  const instagram = Boolean(
    environment(portal, "META_INSTAGRAM_BUSINESS_ACCOUNT_ID") &&
    (instagramAccessToken || pageAccessToken) &&
    hasPublicStorage
  );
  const instagramTokenSource = instagramAccessToken
    ? "instagram"
    : pageAccessToken ? "facebook_page" : "missing";
  return { facebook, instagram, instagramTokenSource };
}
