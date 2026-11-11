# Community Alert System (CAS)

Community Alert System (CAS) has Resident, CEPALCO, and Water District portals. Authentication and application records (profiles, advisories, reports, work orders, network readings, and the resident inbox) use Supabase. The Express APIs remain responsible for Gmail/Meta delivery and keep their provider credentials server-side; their SQLite database is still used for Gmail OAuth state and notification-delivery bookkeeping. See the [Supabase setup guide](./supabase/SETUP.md) before starting the portals.

| Layer | Technology |
|---|---|
| Frontend framework | React 18 |
| Programming language | TypeScript |
| Build tool | Vite |
| Styling | Tailwind CSS |
| API | Express + TypeScript (private notification integrations) |
| Database | Supabase PostgreSQL (application records); SQLite (local notification-integration state) |
| Notification demonstration | Simulated SMS records and a virtual inbox |

A Supabase/PostgreSQL schema and incremental migrations are under `supabase/`. They define Row Level Security, authentication profile creation, Realtime publication, resident self-service policy, and a resumable SQLite importer (`npm run db:import:sqlite`). See [Supabase database setup](./supabase/SETUP.md) for configuration and account-transfer details.

Resident accounts and utility administrator authentication use Supabase Auth. Supabase RLS protects application tables. SMS remains simulated; no text messages are sent. Realtime is configured in the database but the portals currently refresh through requests.

## Project structure

- `frontend/apps/` — Resident, CEPALCO, and Water District Vite applications.
- `frontend/packages/ui/` — shared React interface, Supabase client, and Tailwind styles.
- `backend/apps/` — Resident, CEPALCO, and Water District API entry points.
- `backend/packages/api-core/` — shared API routes, authentication, and SQLite storage.
- `package.json`, `package-lock.json`, and `tsconfig.json` — root workspace and tool configuration.

## Requirements

- Node.js 20 or newer
- npm 10 or newer

Install dependencies from the project root:

```powershell
npm install
```

Run all three portals and their APIs together:

```powershell
npm run dev:all
```

The Vite portals and APIs run at:

- Resident: `http://localhost:5173`
- CEPALCO: `http://localhost:5174`
- Water District: `http://localhost:5175`
- Resident API: `http://localhost:4101`
- CEPALCO API: `http://localhost:4102`
- Water District API: `http://localhost:4103`

Run only the APIs with `npm run dev:backend`, or launch an individual API with `npm run dev:api:resident`, `npm run dev:api:cepalco`, or `npm run dev:api:water`. The API processes share `backend/data/civicalert.sqlite` by default.

You can run one portal instead:

```powershell
npm run dev:resident
npm run dev:cepalco
npm run dev:water
```

## Accounts and data

Create utility administrator accounts in Supabase Authentication and set their profiles to `role = 'admin'` with the exact utility (`CEPALCO` or `Water District`) using the Supabase SQL Editor. Residents register from the Resident portal. The old SQLite demo logins do not work with Supabase Auth.

For local development, each portal uses a same-origin `/api/...` route that its Vite dev server proxies to the corresponding local API. You can override these variables when the APIs are hosted elsewhere:

```text
VITE_RESIDENT_API_URL=/api/resident
VITE_CEPALCO_API_URL=/api/cepalco
VITE_WATER_API_URL=/api/water
```

The APIs accept `RESIDENT_API_PORT`, `CEPALCO_API_PORT`, and `WATER_API_PORT` to override their individual listen ports (`PORT` remains a fallback when running one API by itself), `DATABASE_PATH` to configure the SQLite file, and `CORS_ORIGIN` as a comma-separated list of allowed frontend origins. If changing the database location, give all three API processes the same `DATABASE_PATH`.

Advisories, work orders, profiles, reports, inbox messages, and water-network readings are stored in Supabase. The app uses Supabase Auth sessions; the utility APIs verify those sessions before handling private provider-integration requests.

For each frontend, copy its `.env.example` to `.env.local` and set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and (optionally) `VITE_GOOGLE_MAPS_API_KEY`. During development, each portal's Vite server proxies its same-origin `/api/...` routes to the local APIs; this also works when a portal is opened through a forwarded port or development tunnel. In Google Cloud, enable Maps JavaScript API and billing, then restrict the browser key to that API and the exact local/production HTTP referrers. The local Vite origins are `http://localhost:5173/*` (Resident), `http://localhost:5174/*` (CEPALCO), and `http://localhost:5175/*` (Water District). Vite uses strict ports so a busy port cannot silently move an app to an unauthorized origin. Area-to-coordinate lookup uses the OpenStreetMap Nominatim service independently of Google's Geocoding API; if Google Maps is unavailable because of a missing/restricted key, portals fall back to OpenStreetMap tiles for map viewing and manual pin selection. Restart Vite after changing environment values.

For the APIs, copy `backend/.env.example` to `backend/.env`. This shared file supplies `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY` to all three APIs, plus optional Gmail/Meta settings. For utility-specific overrides, put a `.env` or `.env.local` in that API's workspace folder (for example `backend/apps/cepalco-api/.env`); workspace files override shared values, and shell-provided environment variables take precedence over files. Never put the service-role key or provider secrets in a frontend env file or a `VITE_*` variable.

The **Virtual SMS inbox** remains a demonstration feature: messages are stored in Supabase, but no SMS is sent. Clearing browser local storage signs the user out; it does not delete Supabase accounts or records.

## Gmail advisory notifications

CEPALCO and Water District administrators use utility-specific announcement composers to enter the location, service type and status, affected areas, scheduled start, estimated restoration, provider, and description. Select one barangay and city, then select one or more Purok/Zone areas within that barangay. Since public map data does not provide Purok coordinates, the form looks up one approximate barangay location and associates it with all selected Puroks; it does not pretend to know individual Purok boundaries. Administrators can adjust that shared location on the map, and publishing or scheduling requires it to be set. The map shows a translucent 1.2 km radius, an estimate rather than an official boundary. Saved area labels and map coordinates are returned to the resident portal and displayed on advisory maps. Apply the `20261111000200_advisory_area_locations.sql` migration to each existing Supabase project before publishing or scheduling; the composer reports an actionable error rather than saving without the selected area pins if the migration is missing. Administrators review the notice and all-resident recipient estimate in an in-app confirmation pop-out, then confirm publishing or scheduling. These details are saved with the advisory and included in resident-facing notice text. Announcements are sent to all registered resident accounts regardless of barangay or purok. Facebook and Gmail are required for every announcement; Instagram is optional. Simulated resident inbox alerts are created automatically for opted-in residents with a registered mobile number; the SMS inbox is available only in the Resident portal and no text message is sent. JPEG, PNG, and WebP images up to 15 MB are optimized in the browser; images outside Instagram's supported 4:5–1.91:1 aspect-ratio range are padded rather than cropped. Retrying Instagram on an older advisory also normalizes and saves its images before publishing. The images are attached to Facebook and Gmail and used for Instagram. Advisories are saved to Supabase; the appropriate utility API publishes immediately or mirrors a scheduled notice to its shared SQLite queue. The worker publishes it when due and syncs delivery records and final publication status back to Supabase. Administrators can update advisory status through Scheduled, Active, Resolved, and Cancelled.

Both announcement forms use server-side Meta credentials. CEPALCO settings use `CEPALCO_META_*`; Water District uses `META_*` by default, with optional `WATER_META_*` overrides. Facebook publishing requires the effective `META_FACEBOOK_PAGE_ID` and `META_FACEBOOK_PAGE_ACCESS_TOKEN`. Use a valid, long-lived Page access token; Meta validates it when a post is published, so a configured-but-expired token still fails. Instagram publishing requires an Instagram Business Account ID, an Instagram or Facebook page access token, a professional Instagram account, and a public HTTPS `META_PUBLIC_BASE_URL` from which Instagram can fetch the saved advisory image. Facebook image posts and Gmail messages attach the chosen image; Instagram fetches it from the API image endpoint. An optional HTTPS information link in the composer is included in the advisory description, social captions, and resident notices. `META_GRAPH_API_VERSION` is optional. Keep all Meta credentials on the server; the utility publish form reports whether the social integrations are configured. On successful publishing, the notification and advisory card show a clickable Instagram permalink when Meta returns one; failed publishing does not have a post link to display. If Meta rejects the token, replace it with a valid token for the linked page/business account and restart the API before retrying. Gmail requires OAuth setup below and an administrator to connect the official sender account. Each publish result reports delivery status.

Run the matching utility API as well as its Vite portal (`npm run dev:all` starts all six services). If retrying Instagram displays `Could not publish this advisory to Instagram: Failed to fetch`, the portal could not reach its API through the Vite proxy; check that the corresponding API is listening on port 4102 (CEPALCO) or 4103 (Water District) and that the portal tunnel is still available. If the API responds but Instagram publishing fails, the result reports the Meta error and stage; confirm the image URL is publicly reachable over HTTPS and the server has outbound HTTPS access to `graph.facebook.com`.

An advisory is saved even if email delivery cannot complete. After publishing, the utility portal shows how many resident emails were sent or failed. The utility API reads recipient names and email addresses directly from resident profiles in Supabase; SQLite is used only to track per-recipient delivery attempts, which are mirrored back to Supabase using each resident's profile ID. An authorized administrator can retry failed deliveries after reconnecting Gmail.

All resident profiles are eligible for advisory email delivery, regardless of their registered barangay, purok, or email notification preference; administrator accounts are excluded. Each resident receives a separate message containing the advisory title, affected area, full public details, reference, social links when available, and the attached image. Simulated inbox alerts are created for every resident account, regardless of SMS preferences or whether a mobile number is on file. Residents see their own alerts in the Resident SMS inbox; utility administrators do not have SMS activity views or recipient counts. The records contain text only, and no SMS is transmitted.

Before enabling real delivery, an administrator must complete this one-time setup:

1. In Google Cloud Console, create/select a project, enable the Gmail API, and configure the OAuth consent screen. Add the utility sending accounts as test users if the consent screen is in Testing; publish/verify the consent screen as required for the intended deployment.
2. Create a **Web application** OAuth client. Register the exact callback URLs as authorized redirect URIs:
   - Local CEPALCO: `http://localhost:4102/oauth/gmail/callback`
   - Local Water District: `http://localhost:4103/oauth/gmail/callback`
   - Production: the corresponding HTTPS API callback URL for each utility.
3. Provide the following settings to the backend processes using the host's secret/environment configuration. Do not put values in frontend `VITE_*` variables, TypeScript, or source control:
   - `GMAIL_OAUTH_CLIENT_ID`
   - `GMAIL_OAUTH_CLIENT_SECRET`
   - `GMAIL_TOKEN_ENCRYPTION_KEY` — a randomly generated, base64-encoded 32-byte key. Keep it stable and backed up securely; losing/changing it requires administrators to reconnect Gmail.
   - `CEPALCO_GMAIL_SENDER_EMAIL` and `WATER_GMAIL_SENDER_EMAIL` — exact official sending addresses, used to reject authorization of another Google account.
   - `GMAIL_CEPALCO_REDIRECT_URI` and `GMAIL_WATER_REDIRECT_URI` when the defaults above do not apply.
   - `CEPALCO_FRONTEND_URL` and `WATER_FRONTEND_URL` if the admin portals use non-default URLs; production URLs must use HTTPS.
4. Start the APIs with those settings present in their environment. Sign in as the matching utility administrator and use **Connect Gmail** in the announcement composer. Google consent is requested for Gmail send access (`gmail.send`) plus `openid`/`email` only to verify that the connected account matches the configured official address.

If the connection fails, the portal now identifies common causes, including a redirect URI mismatch, rejected OAuth client, wrong sender account, or missing refresh token. Check that the exact callback URL from step 2 is registered in Google Cloud and that Gmail settings are present in the API environment (not the frontend `.env.local`).

Refresh tokens are encrypted with AES-256-GCM before they are stored in SQLite. They, OAuth client secrets, and the encryption key are never returned to the frontend. If Gmail is not configured, not connected, revoked, or rejects a message, the advisory remains published and the delivery result reports failure instead of claiming an email was sent. The utility admin can inspect `GET /advisories/:id/email-delivery` and retry failed recipients with `POST /advisories/:id/email-delivery/retry` on that utility's API.

An authorized Gmail sender is connected once per utility and its encrypted refresh token is retained in the shared SQLite database. Keep `GMAIL_TOKEN_ENCRYPTION_KEY` stable across restarts and make the same value available to each API process (a root `cas/.env` can provide shared settings; a workspace API `.env` overrides it). Do not delete or replace the database or encryption key during normal restarts; either action can require administrators to reconnect. CEPALCO and Water District sender accounts are separate utility connections.

When Meta returns public post permalinks, they are saved with the advisory, shown as Facebook/Instagram links in resident and admin advisory feeds, and included in Gmail notices sent after social publishing. Facebook posts remain on the Page until someone removes them; the portal also retains published advisories in its feed. The advisory remains saved if an external delivery fails, and the publish result reports the failure for follow-up.

**Live email delivery has not been verified in this environment.** It requires the Google Cloud setup above, an authorized official Gmail account connected by a utility administrator, and at least one resident profile in Supabase. Tests exercise OAuth scope construction, token encryption, message formatting and image attachments, all-resident delivery, scheduled announcements, and simulated SMS without sending real email or SMS.

## Checks

```powershell
npm run typecheck
npm run test:api
npm run build
```
