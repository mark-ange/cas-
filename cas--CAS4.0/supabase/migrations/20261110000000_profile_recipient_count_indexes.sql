create index if not exists profiles_resident_count_idx
  on public.profiles (id)
  where role = 'resident';

create index if not exists profiles_sms_recipient_count_idx
  on public.profiles (id)
  where role = 'resident'
    and sms_alerts is true
    and phone_number is not null
    and phone_number <> '';
