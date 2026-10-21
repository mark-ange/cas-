import { parseGmailImageAttachment } from "./gmail.js";

export type SocialPlatformResult = {
  platform: "facebook" | "instagram";
  status: "published" | "failed" | "not_configured";
  message?: string;
  id?: string;
};

export type SocialDeliverySummary = {
  status: "published" | "partial" | "failed" | "not_configured";
  platforms: SocialPlatformResult[];
};
export type SocialPlatform = SocialPlatformResult["platform"];

function environment(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function graphVersion(): string {
  return environment("META_GRAPH_API_VERSION") || "v19.0";
}

function graphBase(): string {
  return `https://graph.facebook.com/${graphVersion()}`;
}

function advisoryMessage(title: string, area: string, details: string, reference: string): string {
  return `${title}\n\nAffected area: ${area}\n\n${details}\n\nReference: ${reference}`;
}

async function publishToFacebook(
  title: string,
  area: string,
  details: string,
  reference: string,
  imageDataUrl: string | null,
): Promise<SocialPlatformResult> {
  const pageId = environment("META_FACEBOOK_PAGE_ID");
  const accessToken = environment("META_FACEBOOK_PAGE_ACCESS_TOKEN");
  if (!pageId || !accessToken) {
    return { platform: "facebook", status: "not_configured", message: "Facebook page publishing is not configured." };
  }

  const message = advisoryMessage(title, area, details, reference);
  try {
    if (imageDataUrl) {
      const attachment = parseGmailImageAttachment(imageDataUrl);
if (!attachment) {
  return { platform: "facebook", status: "failed", message: "The announcement image is invalid." };
}
      const form = new FormData();
      form.append("message", message);
      form.append("source", new Blob([new Uint8Array(attachment.content)], { type: attachment.mimeType }), attachment.filename);
      const response = await fetch(`${graphBase()}/${encodeURIComponent(pageId)}/photos?access_token=${encodeURIComponent(accessToken)}`, {
        method: "POST",
        body: form,
      });
      const result = await response.json() as { id?: string; post_id?: string; error?: { message?: string } };
      if (!response.ok || (!result.id && !result.post_id)) {
        return { platform: "facebook", status: "failed", message: result.error?.message || "Facebook could not publish the image." };
      }
      return { platform: "facebook", status: "published", id: result.post_id ?? result.id };
    }

    const response = await fetch(`${graphBase()}/${encodeURIComponent(pageId)}/feed?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const result = await response.json() as { id?: string; error?: { message?: string } };
    if (!response.ok || !result.id) {
      return { platform: "facebook", status: "failed", message: result.error?.message || "Facebook could not publish the announcement." };
    }
    return { platform: "facebook", status: "published", id: result.id };
  } catch (error) {
    return { platform: "facebook", status: "failed", message: error instanceof Error ? error.message : "Facebook publishing failed." };
  }
}

async function publishToInstagram(
  title: string,
  area: string,
  details: string,
  reference: string,
  imageDataUrl: string | null,
  advisoryId: number,
  publicBaseUrl: string,
): Promise<SocialPlatformResult> {
  const accountId = environment("META_INSTAGRAM_BUSINESS_ACCOUNT_ID");
  const accessToken = environment("META_INSTAGRAM_ACCESS_TOKEN") || environment("META_FACEBOOK_PAGE_ACCESS_TOKEN");
  if (!accountId || !accessToken) {
    return { platform: "instagram", status: "not_configured", message: "Instagram publishing is not configured." };
  }
  if (!imageDataUrl) {
    return { platform: "instagram", status: "failed", message: "Instagram publishing requires an announcement image." };
  }
  if (!publicBaseUrl) {
    return { platform: "instagram", status: "failed", message: "META_PUBLIC_BASE_URL is required so Instagram can fetch the announcement image." };
  }

  const caption = advisoryMessage(title, area, details, reference);
  const imageUrl = `${publicBaseUrl.replace(/\/$/, "")}/advisories/${advisoryId}/image`;
  try {
    const containerResponse = await fetch(`${graphBase()}/${encodeURIComponent(accountId)}/media?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: imageUrl, caption }),
    });
    const container = await containerResponse.json() as { id?: string; error?: { message?: string } };
    if (!containerResponse.ok || !container.id) {
      return { platform: "instagram", status: "failed", message: container.error?.message || "Instagram could not create the media container." };
    }

    const publishResponse = await fetch(`${graphBase()}/${encodeURIComponent(accountId)}/media_publish?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: container.id }),
    });
    const published = await publishResponse.json() as { id?: string; error?: { message?: string } };
    if (!publishResponse.ok || !published.id) {
      return { platform: "instagram", status: "failed", message: published.error?.message || "Instagram could not publish the announcement." };
    }
    return { platform: "instagram", status: "published", id: published.id };
  } catch (error) {
    return { platform: "instagram", status: "failed", message: error instanceof Error ? error.message : "Instagram publishing failed." };
  }
}

export async function publishAnnouncementToSocial(
  _portal: string,
  _utility: string,
  advisoryId: number,
  reference: string,
  title: string,
  area: string,
  details: string,
  imageDataUrl: string | null,
  selectedPlatforms: SocialPlatform[] = ["facebook", "instagram"],
): Promise<SocialDeliverySummary> {
  const platforms = await Promise.all(selectedPlatforms.map(platform => platform === "facebook"
    ? publishToFacebook(title, area, details, reference, imageDataUrl)
    : publishToInstagram(title, area, details, reference, imageDataUrl, advisoryId, environment("META_PUBLIC_BASE_URL"))));

  const configuredPlatforms = platforms.filter(result => result.status !== "not_configured");
  const published = platforms.filter(result => result.status === "published").length;

  let status: SocialDeliverySummary["status"];
  if (configuredPlatforms.length === 0) status = "not_configured";
  else if (published === configuredPlatforms.length && published > 0) status = "published";
  else if (published > 0) status = "partial";
  else status = "failed";

  return { status, platforms };
}
