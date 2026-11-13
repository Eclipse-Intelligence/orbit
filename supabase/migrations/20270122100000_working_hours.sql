set lock_timeout = '5s';

create table if not exists crm.working_hours (
  user_id uuid not null references crm.profiles (id) on delete cascade,
  weekday smallint not null,
  works boolean not null default true,
  starts_minute integer not null,
  ends_minute integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, weekday)
);

alter table crm.working_hours drop constraint if exists working_hours_weekday;
alter table crm.working_hours
  add constraint working_hours_weekday check (weekday between 0 and 6);

alter table crm.working_hours drop constraint if exists working_hours_range;
alter table crm.working_hours
  add constraint working_hours_range check (
    starts_minute >= 0
    and ends_minute <= 1440
    and starts_minute < ends_minute
    and starts_minute % 15 = 0
    and ends_minute % 15 = 0
  );

drop trigger if exists working_hours_set_updated_at on crm.working_hours;
create trigger working_hours_set_updated_at
  before update on crm.working_hours
  for each row execute function private.set_updated_at();

alter table crm.working_hours enable row level security;
alter table crm.working_hours force row level security;

drop policy if exists working_hours_self on crm.working_hours;
create policy working_hours_self on crm.working_hours for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on crm.working_hours from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.working_hours to authenticated;
