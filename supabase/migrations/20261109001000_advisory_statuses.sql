update public.advisories
set status = case
  when publication_status = 'scheduled' then 'Scheduled'
  when status = 'Resolved' then 'Resolved'
  when status = 'Cancelled' then 'Cancelled'
  else 'Active'
end
where status not in ('Scheduled', 'Active', 'Resolved', 'Cancelled');
