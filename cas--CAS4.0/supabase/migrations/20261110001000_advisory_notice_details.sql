alter table public.advisories
  add column if not exists location text not null default '',
  add column if not exists service_status text not null default 'Upcoming Maintenance Interruption',
  add column if not exists provider text not null default '';

update public.advisories
set service_status = case
  when status = 'Resolved' then 'Resolved'
  when status = 'Cancelled' then 'Cancelled'
  when status = 'Scheduled' then 'Upcoming Maintenance Interruption'
  else 'Active Service Interruption'
end
where service_status = 'Upcoming Maintenance Interruption'
  and status <> 'Scheduled';
