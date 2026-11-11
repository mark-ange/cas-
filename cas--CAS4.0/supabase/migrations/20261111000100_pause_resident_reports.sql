drop policy if exists reports_create_own on public.reports;

revoke insert on public.reports from authenticated;
