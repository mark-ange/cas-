# Supabase database setup

The SQL migration in `migrations/` defines the planned PostgreSQL database for CivicAlert. The running application still uses its local Express API and SQLite database; this migration does not switch the application to Supabase by itself.

## Create and initialize a project

1. Create a Supabase project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. In the project dashboard, open **SQL Editor**, create a query, and run the contents of the migration file in `migrations/`.
3. Confirm the migration completes, then check **Database → Tables** for `profiles`, `advisories`, `work_orders`, `reports`, and the other CivicAlert tables.
4. Create each utility admin through **Authentication → Users**. Do not set `role` or `utility` in user metadata. Then, in SQL Editor, assign the admin role to the new user's UUID:

   ```sql
   update public.profiles
   set role = 'admin', utility = 'CEPALCO'
   where email = 'your-cepalco-admin@example.com';
   ```

   For the Water District administrator, use `utility = 'Water District'`. Only do this for accounts you control.
5. Configure the application after its backend and frontend Supabase integration is completed. The frontend must use only the project's public/anon key. A `service_role` key must remain in backend-only environment variables and must never be placed in a `VITE_*` variable or committed to source control.

## Authentication and current accounts

New sign-ups create resident profiles through a database trigger. The trigger always assigns the resident role and no utility; user-supplied metadata cannot grant administrator access.

Supabase Auth cannot import this application's existing scrypt password hashes. When the application is switched to Supabase Auth, existing users will need to register again or receive password-reset invitations. This SQL migration does not copy SQLite account or application data into the new project, and it does not modify or delete the local SQLite database.

## Access controls and Realtime

Row Level Security is enabled on every application table. Public visitors can read published advisories, work orders, network readings, UI copy, and portal settings. Authenticated residents can access their own profile, reports, and SMS inbox entries. Utility administrators are limited to their utility for operational data. Gmail OAuth credentials/state and migration bookkeeping are not exposed to browser roles.

Realtime publication is enabled for advisories and SMS inbox entries. The application still needs Supabase subscriptions to consume those updates; the migration alone only prepares the database side.

Do not paste project keys, database passwords, OAuth secrets, or service-role credentials into chat or source files.
