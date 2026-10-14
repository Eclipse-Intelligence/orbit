alter table crm.profiles
  add column if not exists other_emails text[] not null default '{}';

alter table crm.profiles drop constraint if exists profiles_other_emails_count;
alter table crm.profiles
  add constraint profiles_other_emails_count
  check (coalesce(array_length(other_emails, 1), 0) <= 20);
