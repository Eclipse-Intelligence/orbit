set lock_timeout = '5s';

create table if not exists crm.schedule_preferences (
  user_id uuid primary key references crm.profiles (id) on delete cascade,
  spread jsonb,
  learned_at timestamptz,
  reset_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table crm.schedule_preferences drop constraint if exists schedule_preferences_spread_shape;
alter table crm.schedule_preferences
  add constraint schedule_preferences_spread_shape check (
    spread is null or (jsonb_typeof(spread) = 'object' and pg_column_size(spread) <= 65536)
  );

drop trigger if exists schedule_preferences_set_updated_at on crm.schedule_preferences;
create trigger schedule_preferences_set_updated_at
  before update on crm.schedule_preferences
  for each row execute function private.set_updated_at();

alter table crm.schedule_preferences enable row level security;
alter table crm.schedule_preferences force row level security;

drop policy if exists schedule_preferences_self on crm.schedule_preferences;
create policy schedule_preferences_self on crm.schedule_preferences for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on crm.schedule_preferences from anon, authenticated, crm_agent;
grant select, insert, update on crm.schedule_preferences to authenticated;
