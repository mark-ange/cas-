alter table public.advisories
  add column if not exists area_locations jsonb not null default '[]'::jsonb;
