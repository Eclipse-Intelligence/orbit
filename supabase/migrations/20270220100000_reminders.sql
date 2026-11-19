set lock_timeout = '5s';

create table if not exists crm.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references crm.profiles (id) on delete cascade,
  title text not null,
  due_on date,
  due_at timestamptz,
  blocks_time boolean not null default false,
  duration_minutes integer not null default 15,
  repeat_rule jsonb,
  repeat_ends jsonb,
  completed_at timestamptz,
  repeat_of uuid references crm.reminders (id) on delete set null,
  moved_to date,
  pushed_for timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reminders_title_length check (char_length(btrim(title)) between 1 and 500),
  constraint reminders_duration_range check (duration_minutes between 5 and 480),
  constraint reminders_time_needs_date check (due_at is null or due_on is not null),
  constraint reminders_block_needs_time check (not blocks_time or due_at is not null),
  constraint reminders_repeat_needs_date check (repeat_rule is null or due_on is not null),
  constraint reminders_repeat_whole check ((repeat_rule is null) = (repeat_ends is null))
);

create index if not exists reminders_user_idx on crm.reminders (user_id, completed_at, due_on);
create index if not exists reminders_push_idx on crm.reminders (due_at) where completed_at is null and due_at is not null;
create index if not exists reminders_repeat_of_idx on crm.reminders (repeat_of) where repeat_of is not null;

drop trigger if exists reminders_set_updated_at on crm.reminders;
create trigger reminders_set_updated_at
  before update on crm.reminders
  for each row
  when ((to_jsonb(new) - 'pushed_for' - 'updated_at') is distinct from (to_jsonb(old) - 'pushed_for' - 'updated_at'))
  execute function private.set_updated_at();

alter table crm.reminders enable row level security;
alter table crm.reminders force row level security;

drop policy if exists reminders_self on crm.reminders;
create policy reminders_self on crm.reminders for all to authenticated
  using (user_id = (select private.session_user_id()))
  with check (user_id = (select private.session_user_id()));

revoke all on crm.reminders from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.reminders to authenticated;

create table if not exists crm.reminder_settings (
  user_id uuid primary key references crm.profiles (id) on delete cascade,
  morning_at time not null default '08:00',
  morning_sent_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists reminder_settings_set_updated_at on crm.reminder_settings;
create trigger reminder_settings_set_updated_at
  before update on crm.reminder_settings
  for each row execute function private.set_updated_at();

alter table crm.reminder_settings enable row level security;
alter table crm.reminder_settings force row level security;

drop policy if exists reminder_settings_self on crm.reminder_settings;
create policy reminder_settings_self on crm.reminder_settings for all to authenticated
  using (user_id = (select private.session_user_id()))
  with check (user_id = (select private.session_user_id()));

revoke all on crm.reminder_settings from anon, authenticated, crm_agent;
grant select, insert, update on crm.reminder_settings to authenticated;

create or replace function private.claim_reminder_pushes(p_now timestamptz, p_limit integer, p_skip uuid[])
returns table (reminder_id uuid, user_id uuid, title text, due_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  with picked as (
    select r.id
    from crm.reminders r
    where r.completed_at is null
      and r.due_at is not null
      and r.pushed_for is distinct from r.due_at
      and r.due_at <= p_now
      and r.due_at > p_now - interval '5 minutes'
      and not (r.id = any(coalesce(p_skip, '{}'::uuid[])))
    order by r.due_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of r skip locked
  )
  update crm.reminders r
  set pushed_for = r.due_at
  from picked
  where r.id = picked.id
  returning r.id, r.user_id, r.title, r.due_at
$$;

revoke all on function private.claim_reminder_pushes(timestamptz, integer, uuid[]) from public;
grant execute on function private.claim_reminder_pushes(timestamptz, integer, uuid[]) to crm_app;

create or replace function private.release_reminder_push(p_reminder_id uuid, p_due_at timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.reminders
  set pushed_for = null
  where id = p_reminder_id and pushed_for = p_due_at;
$$;

revoke all on function private.release_reminder_push(uuid, timestamptz) from public;
grant execute on function private.release_reminder_push(uuid, timestamptz) to crm_app;

create or replace function private.claim_morning_reminders(p_now timestamptz, p_limit integer)
returns table (user_id uuid, day date, titles text[], total integer)
language sql
security definer
set search_path = ''
as $$
  with params as (
    select (p_now at time zone 'Europe/London')::date as today
  ), due as (
    select r.user_id, array_agg(r.title order by r.created_at, r.id) as titles, count(*)::integer as total
    from crm.reminders r, params
    where r.completed_at is null
      and r.due_at is null
      and r.due_on = params.today
    group by r.user_id
  ), ready as (
    select d.user_id, d.titles, d.total, params.today
    from due d
    cross join params
    left join crm.reminder_settings s on s.user_id = d.user_id
    where ((params.today + coalesce(s.morning_at, time '08:00')) at time zone 'Europe/London') <= p_now
      and ((params.today + coalesce(s.morning_at, time '08:00')) at time zone 'Europe/London') > p_now - interval '1 hour'
      and (s.morning_sent_on is null or s.morning_sent_on < params.today)
    order by d.user_id
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ), claimed as (
    insert into crm.reminder_settings as s (user_id, morning_sent_on)
    select ready.user_id, ready.today from ready
    on conflict (user_id) do update set morning_sent_on = excluded.morning_sent_on
      where s.morning_sent_on is null or s.morning_sent_on < excluded.morning_sent_on
    returning s.user_id
  )
  select ready.user_id, ready.today, ready.titles, ready.total
  from claimed
  join ready on ready.user_id = claimed.user_id
$$;

revoke all on function private.claim_morning_reminders(timestamptz, integer) from public;
grant execute on function private.claim_morning_reminders(timestamptz, integer) to crm_app;

create or replace function private.release_morning_reminders(p_user_id uuid, p_day date)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.reminder_settings
  set morning_sent_on = null
  where user_id = p_user_id and morning_sent_on = p_day;
$$;

revoke all on function private.release_morning_reminders(uuid, date) from public;
grant execute on function private.release_morning_reminders(uuid, date) to crm_app;

reset lock_timeout;
