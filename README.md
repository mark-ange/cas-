# CivicAlert

CivicAlert has Resident, CEPALCO, and Water District portals. Authentication and application records (profiles, advisories, reports, work orders, network readings, and the resident inbox) use Supabase. The Express APIs remain responsible for Gmail/Meta delivery and keep their provider credentials server-side; their SQLite database is still used for Gmail OAuth state and notification-delivery bookkeeping. See the [Supabase setup guide](./supabase/SETUP.md) before starting the portals.

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

Set these optional Vite environment variables to point each portal at a different API host:

```text
VITE_RESIDENT_API_URL=http://localhost:4101
VITE_CEPALCO_API_URL=http://localhost:4102
VITE_WATER_API_URL=http://localhost:4103
```

The APIs accept `RESIDENT_API_PORT`, `CEPALCO_API_PORT`, and `WATER_API_PORT` to override their individual listen ports (`PORT` remains a fallback when running one API by itself), `DATABASE_PATH` to configure the SQLite file, and `CORS_ORIGIN` as a comma-separated list of allowed frontend origins. If changing the database location, give all three API processes the same `DATABASE_PATH`.

Advisories, work orders, profiles, reports, inbox messages, and water-network readings are stored in Supabase. The app uses Supabase Auth sessions; the utility APIs verify those sessions before handling private provider-integration requests.

The **Virtual SMS inbox** remains a demonstration feature: messages are stored in Supabase, but no SMS is sent. Clearing browser local storage signs the user out; it does not delete Supabase accounts or records.

## Gmail advisory notifications

CEPALCO and Water District administrators use utility-specific announcement composers to enter advisory details and affected location, select Facebook, Instagram, Gmail, and/or simulated SMS, and publish immediately or schedule an announcement. Oversized JPEG, PNG, and WebP images up to 15 MB are optimized in the browser. Immediate advisories are saved to Supabase before provider delivery is requested from the utility API. Scheduled advisories are stored in Supabase, but scheduled provider delivery is not yet handled by the Supabase runtime.

Facebook publishing requires `META_FACEBOOK_PAGE_ID` and `META_FACEBOOK_PAGE_ACCESS_TOKEN` in the utility API environment. Instagram publishing requires `META_INSTAGRAM_BUSINESS_ACCOUNT_ID`, an Instagram or Facebook page access token, and `META_PUBLIC_BASE_URL` set to a public HTTPS URL from which Instagram can fetch the saved advisory image. `META_GRAPH_API_VERSION` is optional. Keep all Meta credentials on the server; the utility publish form reports whether the social integrations are configured. Gmail requires the OAuth setup below and an administrator to connect the official sender account. A channel being selectable does not mean its external integration is configured; each publish result reports delivery status.

An advisory is saved even if email delivery cannot complete. After publishing, the utility portal shows how many opted-in resident emails were sent or failed. Per-recipient results are stored in SQLite. An authorized administrator can retry failed deliveries after reconnecting Gmail; residents who have since opted out are excluded from a retry.

Only residents who explicitly select **Immediate advisory emails** during registration or in their profile are recipients. The checkbox is off by default, including for existing accounts migrated to the new database column. It is independent of **Email Advisory Digest**; the weekly digest preference does not enable immediate alerts. Each recipient receives a separate message containing the advisory title, affected area, full public details, and reference.

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

When Meta returns public post permalinks, they are saved with the advisory, shown as Facebook/Instagram links in resident and admin advisory feeds, and included in Gmail notices sent after social publishing. Gmail is sent only to residents who opted in to immediate advisory emails. All published advisories are visible in the resident advisory feed; social and email delivery are additional channels, not prerequisites for feed visibility.

**Live email delivery has not been verified in this environment.** It requires the Google Cloud setup above, an authorized official Gmail account connected by a utility administrator, and at least one real resident who explicitly opted in. Tests exercise OAuth scope construction, token encryption, message formatting, opt-in filtering, scheduled announcements, and simulated SMS without sending real email or SMS.

## Checks

```powershell
npm run typecheck
npm run test:api
npm run build
```
