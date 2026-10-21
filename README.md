# CivicAlert

CivicAlert currently has Resident, CEPALCO, and Water District portals backed by a shared Express API and SQLite database. The frontend uses:

| Layer | Technology |
|---|---|
| Frontend framework | React 18 |
| Programming language | TypeScript |
| Build tool | Vite |
| Styling | Tailwind CSS |
| API (current runtime) | Express + TypeScript |
| Database (current runtime) | SQLite |
| Notification demonstration | Simulated SMS records and a virtual inbox |

A Supabase/PostgreSQL migration has been prepared under `supabase/`. It defines the intended hosted database, Row Level Security, authentication profile trigger, and Realtime publication; it does not become the application's active database until the backend and frontend are configured to use a Supabase project. See [Supabase database setup](./supabase/SETUP.md) for setup steps and account migration limitations.

The planned stack, matching the provided technology outline, is:

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS | Build and serve the three responsive portals |
| Database | Supabase PostgreSQL | Store profiles, advisories, reports, work orders, and notifications |
| Authentication and realtime | Supabase Auth and Realtime | Manage user sessions and deliver live advisory/inbox updates |
| Private integrations | Express + TypeScript API | Keep Gmail/social credentials and scheduled publishing on the server |

Resident accounts and profiles, utility administrator authentication, advisories, work orders, reports, simulated SMS inbox messages, and Water District network readings use the backend. SMS is simulated; no text messages are sent.

## Project structure

- `frontend/apps/` — Resident, CEPALCO, and Water District Vite applications.
- `frontend/packages/ui/` — shared React interface, Tailwind styles, local demo settings, and `localStorage` prototype data.
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

## Demo accounts and data

CEPALCO and Water District demo administrator accounts use the password `DemoPass123!`:

| Portal | Username |
|---|---|
| CEPALCO | `admin@cepalco.local` |
| Water District | `admin@waterdistrict.local` |

Residents can register from the Resident portal. Resident accounts, profiles, advisories, work orders, reports, simulated inbox messages, and network readings are stored in the shared backend database.

In development, CEPALCO and Water District demo administrators use the password `DemoPass123!` from the accounts above. Demo accounts are seeded when the API starts outside production. In production, configure administrator accounts separately; development seed accounts are not created.

Set these optional Vite environment variables to point each portal at a different API host:

```text
VITE_RESIDENT_API_URL=http://localhost:4101
VITE_CEPALCO_API_URL=http://localhost:4102
VITE_WATER_API_URL=http://localhost:4103
```

The APIs accept `RESIDENT_API_PORT`, `CEPALCO_API_PORT`, and `WATER_API_PORT` to override their individual listen ports (`PORT` remains a fallback when running one API by itself), `DATABASE_PATH` to configure the SQLite file, and `CORS_ORIGIN` as a comma-separated list of allowed frontend origins. If changing the database location, give all three API processes the same `DATABASE_PATH`.

Advisories are stored centrally. A resident can list advisories; CEPALCO and Water District administrators must authenticate against their respective API, and the server restricts advisory creation, listing, and status changes to that administrator's utility. Login tokens are stored in browser local storage to preserve portal sessions.

The **Virtual SMS inbox** remains a demonstration feature: its records are browser-local and no SMS is sent. Clearing site local storage clears those demo records and drafts, but does not delete backend accounts or advisories.

## Gmail advisory notifications

CEPALCO and Water District administrators use one announcement composer to enter the report details and affected location, select Facebook, Instagram, Gmail, and/or simulated SMS, and publish immediately or schedule a future announcement. Scheduled announcements are published by their API process; keep the relevant API running at the scheduled time. Existing CEPALCO and Water District advisories are removed once when the updated database schema is first loaded.

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

**Live email delivery has not been verified in this environment.** It requires the Google Cloud setup above, an authorized official Gmail account connected by a utility administrator, and at least one real resident who explicitly opted in. Tests exercise OAuth scope construction, token encryption, message formatting, opt-in filtering, scheduled announcements, and simulated SMS without sending real email or SMS.

## Checks

```powershell
npm run typecheck
npm run test:api
npm run build
```
