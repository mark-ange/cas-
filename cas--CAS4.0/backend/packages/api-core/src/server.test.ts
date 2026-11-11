import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const databaseDirectory = mkdtempSync(join(tmpdir(), "civicalert-gmail-test-"));
process.env.DATABASE_PATH = join(databaseDirectory, "test.sqlite");
process.env.NODE_ENV = "test";
delete process.env.GMAIL_OAUTH_CLIENT_ID;
delete process.env.GMAIL_OAUTH_CLIENT_SECRET;
delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
delete process.env.CEPALCO_GMAIL_SENDER_EMAIL;
delete process.env.WATER_GMAIL_SENDER_EMAIL;
// Keep delivery tests hermetic by using only isolated SQLite fixtures, never
// profiles from a configured Supabase project.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.META_FACEBOOK_PAGE_ID;
delete process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN;
delete process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID;
delete process.env.META_INSTAGRAM_ACCESS_TOKEN;
delete process.env.META_PUBLIC_BASE_URL;

const [{ createApi, startScheduledAnnouncementWorker }, { database }] = await Promise.all([
  import("./server.js"),
  import("./database.js"),
]);
const servers: Server[] = [];
const mapPin = { latitude: 8.4542, longitude: 124.6319 };

async function startApi(portal: "resident" | "cepalco" | "water"): Promise<string> {
  const server = createApi(portal).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the API test port.");
  return `http://127.0.0.1:${address.port}`;
}

async function jsonRequest(url: string, method = "GET", body?: unknown, token?: string) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result: unknown = await response.json();
  return { response, result: result as Record<string, unknown> };
}

after(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
  database.close();
  rmSync(databaseDirectory, { recursive: true, force: true });
});

test("public portal content includes settings for every portal", async () => {
  const residentApi = await startApi("resident");
  const portalContent = await jsonRequest(`${residentApi}/content`);
  assert.equal(portalContent.response.status, 200);
  assert.ok(portalContent.result.copy && typeof portalContent.result.copy === "object");
  const portalSettings = portalContent.result.settings as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(portalSettings).sort(), ["cepalco", "resident", "water"]);
  assert.equal(portalSettings.resident.label, "Resident");
  assert.equal(portalSettings.cepalco.label, "CEPALCO");
  assert.equal(portalSettings.water.label, "Water District");
  const residentNavigation = (portalSettings.resident.navigation as Array<{ key: string }>).map(item => item.key);
  assert.deepEqual(residentNavigation, ["overview", "inbox", "services", "about", "profile"]);
  assert.ok(!residentNavigation.some(key => ["publish", "incidents", "residents", "restoration"].includes(key)));
  assert.ok(!(portalSettings.cepalco.navigation as Array<{ key: string }>).some(item => item.key === "inbox"));
  assert.ok(!(portalSettings.water.navigation as Array<{ key: string }>).some(item => item.key === "inbox"));
  for (const key of ["smsInboxDisclaimer", "smsInboxEmpty", "smsInboxStatusSimulated", "smsInboxStatusRead", "smsInboxStatusUnread", "smsInboxMarkRead"]) {
    assert.equal(typeof (portalContent.result.copy as Record<string, unknown>)[key], "string", `Missing UI copy: ${key}`);
  }
  assert.deepEqual(
    (portalSettings.cepalco.navigation as Array<{ key: string }>).map(item => item.key),
    ["overview", "incidents", "residents"],
  );
  assert.deepEqual(
    (portalSettings.water.navigation as Array<{ key: string }>).map(item => item.key),
    ["overview", "incidents", "residents", "restoration"],
  );
});

test("resident report submission is temporarily disabled", async () => {
  const residentApi = await startApi("resident");
  const report = { utility: "CEPALCO", issue: "Intermittent power", area: "Carmen", details: "Observed this morning." };
  const anonymousSubmission = await jsonRequest(`${residentApi}/reports`, "POST", report);
  assert.equal(anonymousSubmission.response.status, 401);

  const registration = await jsonRequest(`${residentApi}/auth/register`, "POST", {
    name: "Report Test Resident",
    email: "report-test@example.test",
    password: "resident-test-password",
    phoneNumber: "09170000000",
    address: "Test address",
    barangay: "Carmen",
    purok: "",
    district: "1st District",
    city: "Cagayan de Oro City",
    postalCode: "9000",
    termsAccepted: true,
  });
  assert.equal(registration.response.status, 201);
  assert.equal(typeof registration.result.token, "string");

  const actor = registration.result.actor as Record<string, unknown>;
  const residentId = Number(actor.id);
  try {
    const submission = await jsonRequest(`${residentApi}/reports`, "POST", report, String(registration.result.token));
    assert.equal(submission.response.status, 403);
    assert.match(String(submission.result.error), /temporarily unavailable/i);
    const mine = await jsonRequest(`${residentApi}/reports/mine`, "GET", undefined, String(registration.result.token));
    assert.equal(mine.response.status, 200);
    assert.deepEqual(mine.result, []);
  } finally {
    database.prepare("DELETE FROM reports WHERE user_id = ?").run(residentId);
    database.prepare("DELETE FROM users WHERE id = ?").run(residentId);
  }
});

test("resident profiles preserve location and every resident receives inbox alerts across areas", async () => {
  const residentApi = await startApi("resident");
  const cepalcoApi = await startApi("cepalco");
  const waterApi = await startApi("water");

  const registrationFields = {
    name: "Consenting Resident",
    password: "ValidPass123",
    phoneNumber: "09170000000",
    address: "1 Test Street",
    barangay: "Carmen",
    purok: "4",
    district: "1st District",
    city: "Cagayan de Oro City",
    postalCode: "9000",
    termsAccepted: true,
  };
  const optedInRegistration = await jsonRequest(`${residentApi}/auth/register`, "POST", {
    ...registrationFields,
    email: "opted-in@example.test",
    immediateEmailAlerts: true,
  });
  assert.equal(optedInRegistration.response.status, 201);
  assert.equal((optedInRegistration.result.actor as Record<string, unknown>).purok, "4");
  const optedInToken = optedInRegistration.result.token as string;
  const optedInProfile = await jsonRequest(`${residentApi}/auth/profile`, "PATCH", {
    name: "Consenting Resident",
    email: "opted-in@example.test",
    phoneNumber: registrationFields.phoneNumber,
    emailDigest: false,
    immediateEmailAlerts: true,
    profileImage: null,
  }, optedInToken);
  assert.equal(optedInProfile.response.status, 200);
  assert.equal((optedInProfile.result.actor as Record<string, unknown>).emailDigest, false);
  assert.equal((optedInProfile.result.actor as Record<string, unknown>).immediateEmailAlerts, true);

  const optedOutRegistration = await jsonRequest(`${residentApi}/auth/register`, "POST", {
    ...registrationFields,
    name: "Nonconsenting Resident",
    email: "not-opted-in@example.test",
    smsAlerts: false,
  });
  assert.equal(optedOutRegistration.response.status, 201);
  const optedOutToken = optedOutRegistration.result.token as string;
  const noPhoneProfile = await jsonRequest(`${residentApi}/auth/profile`, "PATCH", {
    name: "Nonconsenting Resident",
    email: "not-opted-in@example.test",
    phoneNumber: "",
    smsAlerts: false,
  }, optedOutToken);
  assert.equal(noPhoneProfile.response.status, 200);
  assert.equal((noPhoneProfile.result.actor as Record<string, unknown>).phoneNumber, "");
  assert.equal((noPhoneProfile.result.actor as Record<string, unknown>).smsAlerts, true);

  const otherAreaRegistration = await jsonRequest(`${residentApi}/auth/register`, "POST", {
    ...registrationFields,
    name: "Resident in Another Barangay",
    email: "other-area@example.test",
    barangay: "Bugo",
    purok: "2",
  });
  assert.equal(otherAreaRegistration.response.status, 201);

  const cepalcoLogin = await jsonRequest(`${cepalcoApi}/auth/login`, "POST", {
    email: "admin@cepalco.local",
    password: "DemoPass123!",
  });
  assert.equal(cepalcoLogin.response.status, 200);
  const cepalcoToken = cepalcoLogin.result.token as string;
  const initialAdvisories = await jsonRequest(`${cepalcoApi}/advisories`, "GET", undefined, cepalcoToken);
  assert.deepEqual(initialAdvisories.result, []);
  const gmailStatus = await jsonRequest(`${cepalcoApi}/email/gmail/status`, "GET", undefined, cepalcoToken);
  assert.equal(gmailStatus.response.status, 200);
  assert.equal(gmailStatus.result.connected, false);
  const socialStatus = await jsonRequest(`${cepalcoApi}/social/status`, "GET", undefined, cepalcoToken);
  assert.equal(socialStatus.response.status, 200);
  assert.equal(typeof socialStatus.result.facebook, "boolean");
  assert.equal(typeof socialStatus.result.instagram, "boolean");
  assert.equal(socialStatus.result.instagramTokenSource, "missing");

  const missingMapPin = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    title: "Missing map pin",
    area: "Carmen",
    details: "This announcement must not be published without a map pin.",
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(missingMapPin.response.status, 400);
  assert.match(String(missingMapPin.result.error), /pin on the map before publishing or scheduling/);
  const missingScheduledMapPin = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    title: "Scheduled notice missing map pin",
    area: "Carmen",
    details: "Scheduled notices also require a map pin.",
    channels: ["sms"],
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, cepalcoToken);
  assert.equal(missingScheduledMapPin.response.status, 400);
  assert.match(String(missingScheduledMapPin.result.error), /pin on the map before publishing or scheduling/);

  const socialEnv = [
    "CEPALCO_META_FACEBOOK_PAGE_ACCESS_TOKEN",
    "CEPALCO_META_INSTAGRAM_ACCESS_TOKEN",
    "CEPALCO_META_INSTAGRAM_BUSINESS_ACCOUNT_ID",
    "META_PUBLIC_BASE_URL",
  ] as const;
  const originalSocialEnv = new Map(socialEnv.map(name => [name, process.env[name]]));
  try {
    process.env.CEPALCO_META_FACEBOOK_PAGE_ACCESS_TOKEN = "test-page-token";
    process.env.CEPALCO_META_INSTAGRAM_BUSINESS_ACCOUNT_ID = "test-instagram-account";
    process.env.META_PUBLIC_BASE_URL = "https://example.test";
    const pageTokenStatus = await jsonRequest(`${cepalcoApi}/social/status`, "GET", undefined, cepalcoToken);
    assert.equal(pageTokenStatus.result.instagram, true);
    assert.equal(pageTokenStatus.result.instagramTokenSource, "facebook_page");

    process.env.CEPALCO_META_INSTAGRAM_ACCESS_TOKEN = "test-instagram-token";
    const instagramTokenStatus = await jsonRequest(`${cepalcoApi}/social/status`, "GET", undefined, cepalcoToken);
    assert.equal(instagramTokenStatus.result.instagramTokenSource, "instagram");
  } finally {
    for (const [name, value] of originalSocialEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const smsAnnouncement = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    ...mapPin,
    title: "Test simulated alert",
    type: "Scheduled maintenance",
    area: "Carmen",
    location: "Carmen, Cagayan de Oro City",
    serviceStatus: "Upcoming Maintenance Interruption",
    provider: "CEPALCO",
    serviceStartsAt: "2026-11-11T05:00",
    estimatedRestorationAt: "2026-11-11T21:00",
    details: "This is a test of the simulated resident inbox.",
    priority: "High",
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(smsAnnouncement.response.status, 201, JSON.stringify(smsAnnouncement.result));
  assert.equal(smsAnnouncement.result.smsQueued, 3);
  assert.equal(smsAnnouncement.result.location, "Carmen, Cagayan de Oro City");
  assert.equal(smsAnnouncement.result.latitude, mapPin.latitude);
  assert.equal(smsAnnouncement.result.longitude, mapPin.longitude);
  assert.equal(smsAnnouncement.result.serviceStatus, "Upcoming Maintenance Interruption");
  assert.equal(smsAnnouncement.result.provider, "CEPALCO");
  const savedNoticeList = await jsonRequest(`${cepalcoApi}/advisories`, "GET", undefined, cepalcoToken);
  const savedNotice = (savedNoticeList.result as unknown as Array<Record<string, unknown>>)
    .find(item => item.reference === smsAnnouncement.result.reference);
  assert.ok(savedNotice);
  assert.equal(savedNotice.location, "Carmen, Cagayan de Oro City");
  assert.equal(savedNotice.latitude, mapPin.latitude);
  assert.equal(savedNotice.longitude, mapPin.longitude);
  assert.equal(savedNotice.serviceStatus, "Upcoming Maintenance Interruption");
  assert.equal(savedNotice.provider, "CEPALCO");
  const residentMapAdvisories = await jsonRequest(`${residentApi}/advisories`);
  const residentMapNotice = (residentMapAdvisories.result as unknown as Array<Record<string, unknown>>)
    .find(item => item.id === smsAnnouncement.result.id);
  assert.equal(residentMapNotice?.latitude, mapPin.latitude);
  assert.equal(residentMapNotice?.longitude, mapPin.longitude);
  const multiAreaAnnouncement = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    title: "Multi-area test advisory",
    type: "Scheduled maintenance",
    areas: ["Carmen", "Bugo"],
    area: "Carmen, Bugo",
    areaLocations: [
      { area: "Carmen", latitude: 8.4542, longitude: 124.6319 },
      { area: "Bugo", latitude: 8.519, longitude: 124.75 },
    ],
    location: "Carmen, Cagayan de Oro City",
    serviceStatus: "Upcoming Maintenance Interruption",
    provider: "CEPALCO",
    details: "This advisory affects multiple service areas.",
    priority: "High",
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(multiAreaAnnouncement.response.status, 201, JSON.stringify(multiAreaAnnouncement.result));
  assert.equal(multiAreaAnnouncement.result.area, "Carmen, Bugo");
  assert.deepEqual(multiAreaAnnouncement.result.areas, ["Carmen", "Bugo"]);
  assert.deepEqual(multiAreaAnnouncement.result.areaLocations, [
    { area: "Carmen", latitude: 8.4542, longitude: 124.6319 },
    { area: "Bugo", latitude: 8.519, longitude: 124.75 },
  ]);
  const savedMultiAreaAdvisory = await jsonRequest(`${cepalcoApi}/advisories`, "GET", undefined, cepalcoToken);
  const savedMultiAreaNotice = (savedMultiAreaAdvisory.result as unknown as Array<Record<string, unknown>>)
    .find(item => item.id === multiAreaAnnouncement.result.id);
  assert.deepEqual(savedMultiAreaNotice?.areaLocations, multiAreaAnnouncement.result.areaLocations);
  const purokAreas = Array.from({ length: 10 }, (_, index) => `Carmen · Purok ${index + 1}`);
  const purokAnnouncement = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    title: "Multiple Purok test advisory",
    type: "Scheduled maintenance",
    areas: purokAreas,
    area: purokAreas.join(", "),
    areaLocations: purokAreas.map(area => ({ area, ...mapPin })),
    location: "Carmen, Cagayan de Oro City",
    serviceStatus: "Upcoming Maintenance Interruption",
    provider: "CEPALCO",
    details: "This advisory affects multiple Puroks within one barangay.",
    priority: "High",
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(purokAnnouncement.response.status, 201, JSON.stringify(purokAnnouncement.result));
  assert.deepEqual(purokAnnouncement.result.areas, purokAreas);
  assert.deepEqual(purokAnnouncement.result.areaLocations, purokAreas.map(area => ({ area, ...mapPin })));
  const immediateResidentInbox = await jsonRequest(`${residentApi}/inbox`, "GET", undefined, optedInToken);
  assert.equal(immediateResidentInbox.response.status, 200);
  const simulatedNotice = (immediateResidentInbox.result as unknown as Array<Record<string, unknown>>)
    .find(item => item.reference === smsAnnouncement.result.reference && item.status === "Simulated");
  assert.ok(simulatedNotice);
  assert.match(String(simulatedNotice.body), /Location: Carmen, Cagayan de Oro City/);
  assert.match(String(simulatedNotice.body), /Type of Service: Scheduled maintenance/);
  assert.match(String(simulatedNotice.body), /Status: Upcoming Maintenance Interruption/);
  assert.match(String(simulatedNotice.body), /Provider: CEPALCO/);
  assert.match(String(simulatedNotice.body), /Description: This is a test of the simulated resident inbox\./);
  const resolvedNotice = await jsonRequest(
    `${cepalcoApi}/advisories/${smsAnnouncement.result.id}/status`,
    "PATCH",
    { status: "Resolved" },
    cepalcoToken,
  );
  assert.equal(resolvedNotice.response.status, 200);
  const updatedNoticeList = await jsonRequest(`${cepalcoApi}/advisories`, "GET", undefined, cepalcoToken);
  const updatedNotice = (updatedNoticeList.result as unknown as Array<Record<string, unknown>>)
    .find(item => item.reference === smsAnnouncement.result.reference);
  assert.equal(updatedNotice?.serviceStatus, "Resolved");
  const cepalcoSmsActivity = await jsonRequest(`${cepalcoApi}/inbox`, "GET", undefined, cepalcoToken);
  assert.equal(cepalcoSmsActivity.response.status, 404);
  const waterActivityAdminLogin = await jsonRequest(`${waterApi}/auth/login`, "POST", {
    email: "admin@waterdistrict.local",
    password: "DemoPass123!",
  });
  assert.equal(waterActivityAdminLogin.response.status, 200);
  const waterSmsActivity = await jsonRequest(`${waterApi}/inbox`, "GET", undefined, waterActivityAdminLogin.result.token as string);
  assert.equal(waterSmsActivity.response.status, 404);

  const previousFetch = globalThis.fetch;
  const previousMetaEnvironment = {
    pageId: process.env.META_FACEBOOK_PAGE_ID,
    accessToken: process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN,
    instagramId: process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID,
    instagramToken: process.env.META_INSTAGRAM_ACCESS_TOKEN,
    publicBaseUrl: process.env.META_PUBLIC_BASE_URL,
    graphVersion: process.env.CEPALCO_META_GRAPH_API_VERSION,
  };
  let facebookPermalinkAttempts = 0;
  let facebookAlbumPhotoCount = 0;
  let facebookAttachedMedia: string[] = [];
  let instagramCarouselChildren: string[] = [];
  let instagramChildCount = 0;
  let instagramSourceImageUrl = "";
  let instagramCaption = "";
  let instagramStatusChecks = 0;
  let instagramPermalinkAttempts = 0;
  const graphVersions = new Set<string>();
  process.env.META_FACEBOOK_PAGE_ID = "test-page";
  process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN = "test-page-token";
  process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID = "test-instagram";
  process.env.META_INSTAGRAM_ACCESS_TOKEN = "test-instagram-token";
  process.env.META_PUBLIC_BASE_URL = "https://cas.example.test";
  process.env.CEPALCO_META_GRAPH_API_VERSION = "v26.0";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "graph.facebook.com") graphVersions.add(url.pathname.split("/")[1]);
    if (url.hostname === "graph.facebook.com" && init?.method === "POST" && url.pathname.endsWith("/photos")) {
      if (init.body instanceof FormData && init.body.get("published") === "false") {
        facebookAlbumPhotoCount += 1;
        return new Response(JSON.stringify({ id: `test-album-photo-${facebookAlbumPhotoCount}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "test-photo", post_id: "test-page_456" }), { status: 200 });
    }
    if (url.hostname === "graph.facebook.com" && init?.method === "POST" && url.pathname.endsWith("/feed")) {
      const body = init.body instanceof URLSearchParams ? init.body : null;
      facebookAttachedMedia = body ? [body.get("attached_media[0]") ?? "", body.get("attached_media[1]") ?? ""] : [];
      return new Response(JSON.stringify({ id: "test-page_789" }), { status: 200 });
    }
    if (url.hostname === "graph.facebook.com" && init?.method === "POST" && url.pathname.endsWith("/media")) {
      const body = init.body instanceof URLSearchParams ? init.body : null;
      if (body?.get("caption")) instagramCaption = body.get("caption")!;
      if (body?.get("image_url")) instagramSourceImageUrl = body.get("image_url")!;
      if (body?.get("caption")?.includes("network failure test")) throw new TypeError("fetch failed");
      if (body?.get("is_carousel_item") === "true") {
        instagramChildCount += 1;
        return new Response(JSON.stringify({ id: `test-instagram-child-${instagramChildCount}` }), { status: 200 });
      }
      if (body?.get("media_type") === "CAROUSEL") {
        instagramCarouselChildren = (body.get("children") ?? "").split(",");
        return new Response(JSON.stringify({ id: "test-instagram-carousel" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "test-instagram-container" }), { status: 200 });
    }
    if (url.hostname === "graph.facebook.com" && init?.method === "POST" && url.pathname.endsWith("/media_publish")) {
      return new Response(JSON.stringify({ id: "test-instagram-post" }), { status: 200 });
    }
    if (url.hostname === "graph.facebook.com" && url.searchParams.get("fields") === "status_code,status") {
      instagramStatusChecks += 1;
      return new Response(JSON.stringify({
        status_code: instagramStatusChecks % 2 === 1 ? "IN_PROGRESS" : "FINISHED",
        status: "Media is ready",
      }), { status: 200 });
    }
    if (url.hostname === "graph.facebook.com" && url.searchParams.get("fields") === "permalink_url") {
      facebookPermalinkAttempts += 1;
      if (facebookPermalinkAttempts === 1) return new Response("Temporary Meta error", { status: 503 });
      return new Response(JSON.stringify({ permalink_url: "https://www.facebook.com/test-page/posts/456" }), { status: 200 });
    }
    if (url.hostname === "graph.facebook.com" && url.searchParams.get("fields") === "permalink") {
      instagramPermalinkAttempts += 1;
      if (instagramPermalinkAttempts === 1) return new Response("Instagram post is not indexed yet", { status: 404 });
      return new Response(JSON.stringify({ permalink: "https://www.instagram.com/p/test-post/" }), { status: 200 });
    }
    return previousFetch(input, init);
  };
  try {
    const facebookAdvisory = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
      ...mapPin,
      title: "Facebook link test",
      area: "Carmen",
      details: "Verify stored social post links.",
      informationUrl: "https://utility.example.test/notices/456",
      imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      channels: ["facebook", "instagram"],
    }, cepalcoToken);
    assert.equal(facebookAdvisory.response.status, 201);
    assert.equal(facebookAdvisory.result.facebookUrl, "https://www.facebook.com/test-page/posts/456");
    assert.equal(facebookAdvisory.result.instagramUrl, "https://www.instagram.com/p/test-post/");
    assert.equal(facebookAdvisory.result.smsQueued, 3);
    assert.deepEqual(facebookAdvisory.result.channels, ["facebook", "instagram"]);
    assert.match(instagramCaption, /More information: https:\/\/utility\.example\.test\/notices\/456/);
    assert.equal(instagramPermalinkAttempts, 2);
    assert.equal(facebookPermalinkAttempts, 2);
    assert.equal(instagramStatusChecks, 2);
    const residentFacebookAdvisories = await jsonRequest(`${residentApi}/advisories`);
    const residentFacebookAdvisory = (residentFacebookAdvisories.result as unknown as Array<Record<string, unknown>>)
      .find(item => item.id === facebookAdvisory.result.id);
    assert.equal(residentFacebookAdvisory?.facebookUrl, "https://www.facebook.com/test-page/posts/456");
    assert.equal(residentFacebookAdvisory?.instagramUrl, "https://www.instagram.com/p/test-post/");
    const residentSocialInbox = await jsonRequest(`${residentApi}/inbox`, "GET", undefined, optedInToken);
    const socialMessage = (residentSocialInbox.result as unknown as Array<Record<string, unknown>>)
      .find(item => item.reference === facebookAdvisory.result.reference);
    assert.ok(socialMessage);
    assert.match(String(socialMessage.body), /Facebook: https:\/\/www\.facebook\.com\/test-page\/posts\/456/);
    assert.match(String(socialMessage.body), /Instagram: https:\/\/www\.instagram\.com\/p\/test-post\//);
    assert.match(String(socialMessage.body), /More information: https:\/\/utility\.example\.test\/notices\/456/);

    const invalidLinkAdvisory = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
      ...mapPin,
      title: "Invalid information link",
      area: "Carmen",
      details: "This should be rejected.",
      informationUrl: "http://utility.example.test/notices",
      imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      channels: ["gmail"],
    }, cepalcoToken);
    assert.equal(invalidLinkAdvisory.response.status, 400);
    assert.match(String(invalidLinkAdvisory.result.error), /must use HTTPS/);

    const failedInstagramAdvisory = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
      ...mapPin,
      title: "network failure test",
      area: "Carmen",
      details: "Verify Meta connectivity diagnostics.",
      imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      channels: ["instagram"],
    }, cepalcoToken);
    assert.equal(failedInstagramAdvisory.response.status, 201);
    const failedInstagram = (failedInstagramAdvisory.result.socialDelivery as { platforms: Array<{ message?: string }> }).platforms[0];
    assert.match(String(failedInstagram.message), /create an Instagram image container/);
    assert.match(String(failedInstagram.message), /outbound HTTPS access/);

    const multiImageSocialAdvisory = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
      ...mapPin,
      title: "Multi-image social post",
      area: "Carmen",
      details: "Publish this set as Facebook and Instagram carousels.",
      imageDataUrls: ["data:image/png;base64,iVBORw0KGgo=", "data:image/png;base64,iVBORw0KGgo="],
      channels: ["facebook", "instagram"],
    }, cepalcoToken);
    assert.equal(multiImageSocialAdvisory.response.status, 201);
    assert.equal(facebookAlbumPhotoCount, 2);
    assert.deepEqual(
      facebookAttachedMedia.map(value => JSON.parse(value).media_fbid),
      ["test-album-photo-1", "test-album-photo-2"],
    );
    assert.equal(instagramChildCount, 2);
    assert.deepEqual(instagramCarouselChildren, ["test-instagram-child-1", "test-instagram-child-2"]);
    assert.equal(instagramStatusChecks, 4);
    assert.ok(graphVersions.has("v26.0"));

    const facebookOnlyAdvisory = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
      ...mapPin,
      title: "Facebook-only advisory",
      area: "Carmen",
      details: "Retry Instagram publishing from the admin card.",
      imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      channels: ["facebook"],
    }, cepalcoToken);
    assert.equal(facebookOnlyAdvisory.response.status, 201);
    const facebookAlbumCountBeforeRetry = facebookAlbumPhotoCount;
    const invalidInstagramRetry = await jsonRequest(
      `${cepalcoApi}/advisories/${facebookOnlyAdvisory.result.id}/social-publish`,
      "POST",
      { platforms: ["instagram"], imageDataUrls: [] },
      cepalcoToken,
    );
    assert.equal(invalidInstagramRetry.response.status, 400);
    assert.match(String(invalidInstagramRetry.result.error), /match the advisory's saved image count/);
    const instagramRetry = await jsonRequest(
      `${cepalcoApi}/advisories/${facebookOnlyAdvisory.result.id}/social-publish`,
      "POST",
      { platforms: ["instagram"], imageDataUrls: ["data:image/jpeg;base64,/9j/2Q=="] },
      cepalcoToken,
    );
    assert.equal(instagramRetry.response.status, 200);
    const retriedPlatforms = instagramRetry.result.platforms as Array<Record<string, unknown>>;
    assert.equal(retriedPlatforms[0].platform, "instagram");
    assert.equal(retriedPlatforms[0].status, "published");
    assert.equal(facebookAlbumPhotoCount, facebookAlbumCountBeforeRetry);
    assert.equal(instagramStatusChecks, 6);
    const normalizedRetryImage = await fetch(`${cepalcoApi}/advisories/${facebookOnlyAdvisory.result.id}/image`);
    assert.equal(normalizedRetryImage.status, 200);
    assert.match(normalizedRetryImage.headers.get("content-type") ?? "", /image\/jpeg/);
    assert.match(instagramSourceImageUrl, /\/advisories\/\d+\/image\?v=[a-f0-9]{12}$/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousMetaEnvironment.pageId === undefined) delete process.env.META_FACEBOOK_PAGE_ID;
    else process.env.META_FACEBOOK_PAGE_ID = previousMetaEnvironment.pageId;
    if (previousMetaEnvironment.accessToken === undefined) delete process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN;
    else process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN = previousMetaEnvironment.accessToken;
    if (previousMetaEnvironment.instagramId === undefined) delete process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID;
    else process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID = previousMetaEnvironment.instagramId;
    if (previousMetaEnvironment.instagramToken === undefined) delete process.env.META_INSTAGRAM_ACCESS_TOKEN;
    else process.env.META_INSTAGRAM_ACCESS_TOKEN = previousMetaEnvironment.instagramToken;
    if (previousMetaEnvironment.publicBaseUrl === undefined) delete process.env.META_PUBLIC_BASE_URL;
    else process.env.META_PUBLIC_BASE_URL = previousMetaEnvironment.publicBaseUrl;
    if (previousMetaEnvironment.graphVersion === undefined) delete process.env.CEPALCO_META_GRAPH_API_VERSION;
    else process.env.CEPALCO_META_GRAPH_API_VERSION = previousMetaEnvironment.graphVersion;
  }

  const scheduled = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    ...mapPin,
    title: "Scheduled service update",
    area: "Carmen",
    type: "Maintenance",
    details: "This update is scheduled for testing.",
    priority: "Urgent",
    serviceStartsAt: "2026-10-23T08:00:00.000Z",
    estimatedRestorationAt: "2026-10-23T12:00:00.000Z",
    channels: ["sms"],
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, cepalcoToken);
  assert.equal(scheduled.response.status, 201);
  assert.equal(scheduled.result.publicationStatus, "scheduled");
  assert.deepEqual(scheduled.result.channels, ["sms"]);
  assert.equal(scheduled.result.priority, "Urgent");
  assert.equal(scheduled.result.serviceStartsAt, "2026-10-23T08:00:00.000Z");
  assert.equal(scheduled.result.estimatedRestorationAt, "2026-10-23T12:00:00.000Z");
  assert.equal(scheduled.result.emailDelivery, undefined);
  const identicalWindow = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    ...mapPin,
    title: "Identical service window",
    area: "Carmen",
    details: "Start and restoration times must differ.",
    serviceStartsAt: "2026-10-23T08:00:00.000Z",
    estimatedRestorationAt: "2026-10-23T08:00:00.000Z",
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(identicalWindow.response.status, 400);
  assert.match(String(identicalWindow.result.error), /cannot be the same/);
  const distinctEarlierWindow = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    ...mapPin,
    title: "Distinct service window",
    area: "Carmen",
    details: "Different times are accepted even when they are not chronological.",
    serviceStartsAt: "2026-10-23T12:00:00.000Z",
    estimatedRestorationAt: "2026-10-23T08:00:00.000Z",
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(distinctEarlierWindow.response.status, 201);
  const invalidPriority = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    ...mapPin,
    title: "Invalid priority",
    area: "Carmen",
    details: "This advisory uses an unsupported priority.",
    priority: "Immediate",
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(invalidPriority.response.status, 400);
  assert.match(String(invalidPriority.result.error), /valid advisory priority/);
  const noChannels = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    ...mapPin,
    title: "No channel selected",
    area: "Carmen",
    details: "This advisory must select a delivery channel.",
    channels: [],
  }, cepalcoToken);
  assert.equal(noChannels.response.status, 400);
  assert.match(String(noChannels.result.error), /at least one announcement channel/);
  const freeTextArea = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    ...mapPin,
    title: "Broadcast with free-text affected area",
    area: "Carmen, Purok West",
    details: "Area descriptions do not restrict the audience.",
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(freeTextArea.response.status, 201);
  assert.equal(freeTextArea.result.area, "Carmen, Purok West");
  const describedArea = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    ...mapPin,
    title: "Free-text service area test",
    area: "Agusan, Purok 4",
    details: "Affected locations are descriptive and do not limit announcement recipients.",
    channels: ["sms"],
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, cepalcoToken);
  assert.equal(describedArea.response.status, 201);
  assert.equal(describedArea.result.area, "Agusan, Purok 4");
  const scheduledPublic = await jsonRequest(`${residentApi}/advisories`);
  const scheduledId = Number(scheduled.result.id);
  const scheduledReference = String(scheduled.result.reference);
  assert.ok(!(scheduledPublic.result as unknown as Array<Record<string, unknown>>).some(item => item.id === scheduledId));
  const scheduledImage = await fetch(`${residentApi}/advisories/${scheduledId}/image`);
  assert.equal(scheduledImage.status, 404);
  database.prepare("UPDATE advisories SET scheduled_at = datetime('now', '-1 minute') WHERE id = ?").run(scheduledId);
  const stopScheduledWorker = startScheduledAnnouncementWorker("cepalco");
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally {
    stopScheduledWorker();
  }
  const scheduledState = database.prepare("SELECT publication_status FROM advisories WHERE id = ?").get(scheduledId) as { publication_status: string };
  assert.equal(scheduledState.publication_status, "published");
  const scheduledEmailCount = database.prepare("SELECT COUNT(*) AS count FROM email_deliveries WHERE advisory_id = ?")
    .get(scheduledId) as { count: number };
  assert.equal(scheduledEmailCount.count, 0);
  const residentId = (database.prepare("SELECT id FROM users WHERE email = ?").get("opted-in@example.test") as { id: number }).id;
  const preservedLocation = database.prepare("SELECT address,barangay,purok FROM users WHERE id = ?").get(residentId) as { address: string; barangay: string; purok: string };
  assert.equal(preservedLocation.address, registrationFields.address);
  assert.equal(preservedLocation.barangay, registrationFields.barangay);
  assert.equal(preservedLocation.purok, registrationFields.purok);
  const optedOutResidentId = (database.prepare("SELECT id FROM users WHERE email = ?").get("not-opted-in@example.test") as { id: number }).id;
  const otherAreaResidentId = (database.prepare("SELECT id FROM users WHERE email = ?").get("other-area@example.test") as { id: number }).id;
  const simulatedSmsRows = database.prepare("SELECT resident_id FROM sms_deliveries WHERE advisory_id = ?").all(scheduledId) as Array<{ resident_id: number }>;
  assert.deepEqual(simulatedSmsRows.map(row => row.resident_id).sort(), [residentId, optedOutResidentId, otherAreaResidentId].sort());
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sms_deliveries WHERE advisory_id = ? AND resident_id IN (SELECT id FROM users WHERE role != 'resident')").get(scheduledId)?.count, 0);
  const residentInbox = await jsonRequest(`${residentApi}/inbox`, "GET", undefined, optedInToken);
  assert.equal(residentInbox.response.status, 200, JSON.stringify(residentInbox.result));
  assert.ok((residentInbox.result as unknown as Array<Record<string, unknown>>).some(
    item => item.reference === scheduledReference && item.status === "Simulated",
  ), JSON.stringify(residentInbox.result));
  const optedOutInbox = await jsonRequest(`${residentApi}/inbox`, "GET", undefined, optedOutToken);
  assert.equal(optedOutInbox.response.status, 200);
  assert.ok((optedOutInbox.result as unknown as Array<Record<string, unknown>>).some(
    item => item.reference === scheduledReference && item.status === "Simulated",
  ));
  const otherAreaToken = otherAreaRegistration.result.token as string;
  const otherAreaInbox = await jsonRequest(`${residentApi}/inbox`, "GET", undefined, otherAreaToken);
  assert.equal(otherAreaInbox.response.status, 200);
  assert.ok((otherAreaInbox.result as unknown as Array<Record<string, unknown>>).some(
    item => item.reference === scheduledReference && item.status === "Simulated",
  ));
  const adminInbox = await jsonRequest(`${cepalcoApi}/inbox`, "GET", undefined, cepalcoToken);
  assert.equal(adminInbox.response.status, 404);
  const scheduledAdminList = await jsonRequest(`${cepalcoApi}/advisories`, "GET", undefined, cepalcoToken);
  assert.ok((scheduledAdminList.result as unknown as Array<Record<string, unknown>>).some(
    item => item.id === scheduledId && item.publicationStatus === "published" &&
      item.priority === "Urgent" &&
      item.serviceStartsAt === "2026-10-23T08:00:00.000Z" &&
      item.estimatedRestorationAt === "2026-10-23T12:00:00.000Z",
  ));
  const publishedImage = await fetch(`${residentApi}/advisories/${scheduledId}/image`);
  assert.equal(publishedImage.status, 404);
  const residentAdvisories = await jsonRequest(`${residentApi}/advisories`);
  const residentScheduled = (residentAdvisories.result as unknown as Array<Record<string, unknown>>).find(item => item.id === scheduledId);
  assert.equal(residentScheduled?.imageUrl, null);
  assert.equal(residentScheduled?.priority, "Urgent");
  assert.equal(residentScheduled?.serviceStartsAt, "2026-10-23T08:00:00.000Z");
  assert.equal(residentScheduled?.estimatedRestorationAt, "2026-10-23T12:00:00.000Z");

  const multiImageAdvisory = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    ...mapPin,
    title: "Multi-image advisory",
    area: "Carmen",
    details: "Verify all announcement images are available.",
    imageDataUrls: [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/png;base64,iVBORw0KGgo=",
    ],
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(multiImageAdvisory.response.status, 201);
  const utilityAdvisories = await jsonRequest(`${cepalcoApi}/advisories`, "GET", undefined, cepalcoToken);
  const savedMultiImage = (utilityAdvisories.result as unknown as Array<Record<string, unknown>>)
    .find(item => item.id === multiImageAdvisory.result.id);
  assert.deepEqual(savedMultiImage?.imageUrls, [
    `/advisories/${multiImageAdvisory.result.id}/image`,
    `/advisories/${multiImageAdvisory.result.id}/images/1`,
  ]);
  for (const imagePath of savedMultiImage?.imageUrls as string[]) {
    const imageResponse = await fetch(`${cepalcoApi}${imagePath}`);
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get("content-type") ?? "", /image\/png/);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  const connect = await jsonRequest(`${cepalcoApi}/email/gmail/connect`, "POST", {}, cepalcoToken);
  assert.equal(connect.response.status, 503);
  assert.match(String(connect.result.error), /GMAIL_TOKEN_ENCRYPTION_KEY/);

  const advisory = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    ...mapPin,
    title: "Power interruption notice",
    area: "Carmen",
    type: "Outage",
    details: "Full announcement text and safety information.",
    channels: ["facebook", "gmail"],
    imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
  }, cepalcoToken);
  assert.equal(advisory.response.status, 201);
  const delivery = advisory.result.emailDelivery as Record<string, unknown>;
  assert.equal(delivery.status, "failed");
  assert.equal(delivery.sent, 0);
  assert.equal(delivery.failed, 3);
  assert.deepEqual(
    (delivery.deliveries as Array<Record<string, unknown>>).map(item => item.recipientName).sort(),
    ["Consenting Resident", "Nonconsenting Resident", "Resident in Another Barangay"],
  );
  assert.ok((advisory.result.channels as string[]).includes("facebook"));
  assert.ok((advisory.result.channels as string[]).includes("gmail"));
  const deliveryStatus = await jsonRequest(
    `${cepalcoApi}/advisories/${advisory.result.id}/email-delivery`,
    "GET",
    undefined,
    cepalcoToken,
  );
  assert.equal(deliveryStatus.response.status, 200);
  assert.equal(deliveryStatus.result.failed, 3);
  assert.equal((deliveryStatus.result.deliveries as Array<Record<string, unknown>>).length, 3);
  const retry = await jsonRequest(
    `${cepalcoApi}/advisories/${advisory.result.id}/email-delivery/retry`,
    "POST",
    {},
    cepalcoToken,
  );
  assert.equal(retry.response.status, 200);
  assert.equal(retry.result.failed, 3);
  assert.ok((retry.result.deliveries as Array<Record<string, unknown>>).every(item => item.attempts === 2));

  const latestResidentAdvisories = await jsonRequest(`${residentApi}/advisories`);
  const listed = latestResidentAdvisories.result as unknown as Array<Record<string, unknown>>;
  assert.ok(listed.some(item => item.id === advisory.result.id));
  const unauthenticatedDelivery = await jsonRequest(`${cepalcoApi}/advisories/${advisory.result.id}/email-delivery`);
  assert.equal(unauthenticatedDelivery.response.status, 401);

  const waterLogin = await jsonRequest(`${waterApi}/auth/login`, "POST", {
    email: "admin@waterdistrict.local",
    password: "DemoPass123!",
  });
  assert.equal(waterLogin.response.status, 200);
  const crossUtilityUpdate = await jsonRequest(
    `${waterApi}/advisories/${advisory.result.id}/status`,
    "PATCH",
    { status: "Resolved" },
    waterLogin.result.token as string,
  );
  assert.equal(crossUtilityUpdate.response.status, 404);
});
