set lock_timeout = '5s';

alter table crm.calendar_events add column if not exists reminder_id uuid references crm.reminders (id) on delete set null;

grant update (reminder_id) on crm.calendar_events to authenticated;

drop policy if exists calendar_events_insert_owner on crm.calendar_events;
create policy calendar_events_insert_owner on crm.calendar_events
  for insert to authenticated
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and calendar_id in (select id from crm.calendars where user_id = (select private.session_user_id()))
    and (
      connection_id is null
      or connection_id in (select id from crm.mailbox_connections where user_id = (select private.session_user_id()))
    )
    and (
      account_id is null
      or account_id in (select id from crm.calendar_accounts where user_id = (select private.session_user_id()))
    )
    and (
      task_id is null
      or task_id in (select id from crm.tasks where owner_id = (select private.session_user_id()))
    )
    and (
      reminder_id is null
      or reminder_id in (select id from crm.reminders where user_id = (select private.session_user_id()))
    )
  );

create or replace function private.calendar_event_reminder_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.session_user_id();
begin
  if new.reminder_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.reminder_id is not distinct from old.reminder_id and new.user_id is not distinct from old.user_id then
    return new;
  end if;
  if not exists (
    select 1 from crm.reminders r
    where r.id = new.reminder_id
      and r.user_id = new.user_id
      and (v_user is null or r.user_id = v_user)
  ) then
    raise exception 'reminder block must be your own reminder' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.calendar_event_reminder_guard() from public;

drop trigger if exists calendar_events_reminder_guard on crm.calendar_events;
create trigger calendar_events_reminder_guard
  before insert or update of reminder_id, user_id on crm.calendar_events
  for each row execute function private.calendar_event_reminder_guard();

create table if not exists crm.reminder_outlook_queue (
  reminder_id uuid primary key,
  user_id uuid not null,
  pending_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  attempts integer not null default 0,
  retry_at timestamptz,
  refused boolean not null default false,
  event_ref text,
  create_key uuid,
  create_sent_at timestamptz,
  constraint reminder_outlook_queue_event_ref_length check (event_ref is null or char_length(event_ref) between 1 and 400)
);

create index if not exists reminder_outlook_queue_user_idx on crm.reminder_outlook_queue (user_id);

alter table crm.reminder_outlook_queue enable row level security;
alter table crm.reminder_outlook_queue force row level security;
revoke all on crm.reminder_outlook_queue from public, anon, authenticated, crm_agent;

do $$
begin
  execute 'drop policy if exists reminder_outlook_queue_definer on crm.reminder_outlook_queue';
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    execute format('create policy reminder_outlook_queue_definer on crm.reminder_outlook_queue for all to %I using (true) with check (true)', current_user);
  end if;
end;
$$;

create or replace function private.reminder_outlook_enqueue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and new.title is not distinct from old.title
    and new.due_at is not distinct from old.due_at
    and new.blocks_time is not distinct from old.blocks_time
    and new.duration_minutes is not distinct from old.duration_minutes
    and new.completed_at is not distinct from old.completed_at
    and new.user_id is not distinct from old.user_id
  then
    return null;
  end if;
  if not (new.blocks_time and new.due_at is not null and new.completed_at is null)
    and not exists (select 1 from crm.calendar_events e where e.reminder_id = new.id)
  then
    update crm.reminder_outlook_queue
    set pending_at = clock_timestamp(), attempts = 0, retry_at = null, refused = false
    where reminder_id = new.id;
    return null;
  end if;
  insert into crm.reminder_outlook_queue (reminder_id, user_id, pending_at)
  values (new.id, new.user_id, clock_timestamp())
  on conflict (reminder_id) do update
  set pending_at = excluded.pending_at, attempts = 0, retry_at = null, refused = false;
  return null;
end;
$$;

revoke all on function private.reminder_outlook_enqueue() from public;

drop trigger if exists reminders_outlook_enqueue on crm.reminders;
create trigger reminders_outlook_enqueue
  after insert or update on crm.reminders
  for each row execute function private.reminder_outlook_enqueue();

create or replace function private.reminder_outlook_forget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref text;
begin
  select e.provider_event_id into v_ref
  from crm.calendar_events e
  where e.reminder_id = old.id;
  if v_ref is null and not exists (select 1 from crm.reminder_outlook_queue q where q.reminder_id = old.id) then
    return old;
  end if;
  delete from crm.calendar_events where reminder_id = old.id;
  if not exists (select 1 from crm.profiles p where p.id = old.user_id) then
    delete from crm.reminder_outlook_queue where reminder_id = old.id;
    return old;
  end if;
  insert into crm.reminder_outlook_queue (reminder_id, user_id, pending_at, event_ref)
  values (old.id, old.user_id, clock_timestamp(), v_ref)
  on conflict (reminder_id) do update
  set pending_at = excluded.pending_at,
      attempts = 0,
      retry_at = null,
      refused = false,
      event_ref = coalesce(crm.reminder_outlook_queue.event_ref, excluded.event_ref);
  return old;
end;
$$;

revoke all on function private.reminder_outlook_forget() from public;

drop trigger if exists reminders_outlook_forget on crm.reminders;
create trigger reminders_outlook_forget
  before delete on crm.reminders
  for each row execute function private.reminder_outlook_forget();

drop function if exists private.claim_reminder_blocks(uuid[], uuid, integer);
create function private.claim_reminder_blocks(p_reminder_ids uuid[], p_user_id uuid, p_limit integer)
returns table (
  reminder_id uuid,
  user_id uuid,
  present boolean,
  title text,
  due_at timestamptz,
  duration_minutes integer,
  blocks_time boolean,
  completed_at timestamptz,
  pending_at text,
  attempts integer,
  event_ref text,
  create_key text,
  create_sent_at timestamptz,
  event_id uuid,
  provider_event_id text,
  event_starts_at timestamptz,
  event_ends_at timestamptz,
  event_subject text
)
language sql
security definer
set search_path = ''
set datestyle = 'ISO, YMD'
as $$
  with picked as (
    select q.reminder_id
    from crm.reminder_outlook_queue q
    where (q.claimed_at is null or q.claimed_at < clock_timestamp() - interval '2 minutes')
      and (q.retry_at is null or q.retry_at <= clock_timestamp())
      and (p_reminder_ids is null or q.reminder_id = any(p_reminder_ids))
      and (p_user_id is null or q.user_id = p_user_id)
    order by q.pending_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of q skip locked
  ), claimed as (
    update crm.reminder_outlook_queue q
    set claimed_at = clock_timestamp()
    from picked
    where q.reminder_id = picked.reminder_id
    returning q.reminder_id, q.user_id, q.pending_at, q.attempts, q.event_ref, q.create_key, q.create_sent_at
  )
  select c.reminder_id, c.user_id, r.id is not null, r.title, r.due_at, r.duration_minutes, coalesce(r.blocks_time, false),
         r.completed_at, c.pending_at::text, c.attempts, c.event_ref, c.create_key::text, c.create_sent_at,
         e.id, e.provider_event_id, e.starts_at, e.ends_at, e.subject
  from claimed c
  left join crm.reminders r on r.id = c.reminder_id and r.user_id = c.user_id
  left join crm.calendar_events e on e.reminder_id = c.reminder_id and e.user_id = c.user_id
  order by c.pending_at
$$;

create or replace function private.begin_reminder_block_create(p_reminder_id uuid)
returns uuid
language sql
security definer
set search_path = ''
as $$
  update crm.reminder_outlook_queue
  set create_key = coalesce(create_key, gen_random_uuid()),
      create_sent_at = clock_timestamp()
  where reminder_id = p_reminder_id
  returning create_key
$$;

create or replace function private.link_reminder_block(p_reminder_id uuid, p_ref text)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.reminder_outlook_queue
  set event_ref = p_ref
  where reminder_id = p_reminder_id and event_ref is distinct from p_ref;
$$;

create or replace function private.settle_reminder_block(p_reminder_id uuid, p_pending_at timestamptz, p_ref text, p_drop_event boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from crm.calendar_events e
  using crm.reminder_outlook_queue q
  where p_drop_event and q.reminder_id = p_reminder_id and e.user_id = q.user_id
    and (e.reminder_id = p_reminder_id or (q.event_ref is not null and e.provider_event_id = q.event_ref));
  delete from crm.reminder_outlook_queue
  where reminder_id = p_reminder_id and pending_at = p_pending_at;
  update crm.reminder_outlook_queue
  set claimed_at = null,
      event_ref = p_ref,
      create_key = null,
      create_sent_at = null
  where reminder_id = p_reminder_id;
$$;

create or replace function private.defer_reminder_block(p_reminder_id uuid, p_pending_at timestamptz, p_refused boolean, p_refused_key uuid default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.reminder_outlook_queue
  set claimed_at = null,
      attempts = case when pending_at = p_pending_at then attempts + 1 else attempts end,
      refused = case when pending_at = p_pending_at then p_refused else refused end,
      retry_at = case
        when pending_at <> p_pending_at then retry_at
        when p_refused then 'infinity'::timestamptz
        else clock_timestamp() + least(interval '6 hours', interval '1 minute' * power(2, least(attempts, 12)))
      end,
      create_key = case when create_key = p_refused_key then null else create_key end,
      create_sent_at = case when create_key = p_refused_key then null else create_sent_at end
  where reminder_id = p_reminder_id;
$$;

create or replace function private.hold_reminder_block(p_reminder_id uuid, p_grace interval)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.reminder_outlook_queue
  set claimed_at = null,
      retry_at = greatest(clock_timestamp() + interval '1 minute', coalesce(create_sent_at, clock_timestamp()) + p_grace)
  where reminder_id = p_reminder_id;
$$;

create or replace function private.release_reminder_block(p_reminder_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.reminder_outlook_queue set claimed_at = null where reminder_id = p_reminder_id;
$$;

create or replace function private.reminder_block_gone(p_reminder_id uuid, p_ref text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from crm.calendar_events e
  using crm.reminder_outlook_queue q
  where q.reminder_id = p_reminder_id and e.user_id = q.user_id
    and (e.reminder_id = p_reminder_id or e.provider_event_id = p_ref);
  update crm.reminder_outlook_queue
  set event_ref = null, create_key = null, create_sent_at = null
  where reminder_id = p_reminder_id;
  update crm.reminders
  set blocks_time = false
  where id = p_reminder_id and blocks_time;
$$;

create or replace function private.queue_reminder_blocks(p_user_id uuid, p_now timestamptz)
returns integer
language sql
security definer
set search_path = ''
as $$
  with wanted as (
    select r.id, r.user_id
    from crm.reminders r
    where r.user_id = p_user_id
      and r.blocks_time
      and r.due_at is not null
      and r.completed_at is null
      and r.due_at + make_interval(mins => r.duration_minutes) > p_now
      and not exists (select 1 from crm.calendar_events e where e.reminder_id = r.id)
      and not exists (select 1 from crm.reminder_outlook_queue q where q.reminder_id = r.id)
    limit 500
  ), added as (
    insert into crm.reminder_outlook_queue (reminder_id, user_id)
    select id, user_id from wanted
    on conflict (reminder_id) do nothing
    returning 1
  )
  select count(*)::integer from added
$$;

create or replace function private.reminder_blocks_pending(p_reminder_ids uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select q.reminder_id from crm.reminder_outlook_queue q where q.reminder_id = any(p_reminder_ids) and not q.refused
$$;

create or replace function private.booking_busy(p_user_id uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '100 days' then
    raise exception 'invalid busy window' using errcode = '22023';
  end if;
  if not exists (select 1 from crm.booking_pages b where b.user_id = p_user_id and b.enabled) then
    return;
  end if;

  return query
  select busy.starts_at, busy.ends_at
  from (
    select e.starts_at, e.ends_at
    from crm.calendar_events e
    join crm.calendars c on c.id = e.calendar_id and c.user_id = e.user_id
    where e.user_id = p_user_id
      and e.task_id is null
      and e.reminder_id is null
      and not e.is_cancelled
      and coalesce(lower(e.show_as), 'busy') <> 'free'
      and e.starts_at < p_to
      and e.ends_at > p_from
    union all
    select t.due_at, t.due_at + make_interval(mins => t.duration_minutes)
    from crm.tasks t
    join crm.workspace_members m on m.workspace_id = t.workspace_id and m.user_id = t.owner_id
    where t.owner_id = p_user_id
      and t.due_has_time
      and t.due_at is not null
      and t.completed_at is null
      and t.archived_at is null
      and t.due_at < p_to
      and t.due_at + make_interval(mins => t.duration_minutes) > p_from
    union all
    select r.due_at, r.due_at + make_interval(mins => r.duration_minutes)
    from crm.reminders r
    where r.user_id = p_user_id
      and r.blocks_time
      and r.due_at is not null
      and r.completed_at is null
      and r.due_at < p_to
      and r.due_at + make_interval(mins => r.duration_minutes) > p_from
  ) busy
  order by busy.starts_at
  limit 5000;
end;
$$;

revoke all on function private.booking_busy(uuid, timestamptz, timestamptz) from public;
revoke all on function private.claim_reminder_blocks(uuid[], uuid, integer) from public;
revoke all on function private.begin_reminder_block_create(uuid) from public;
revoke all on function private.link_reminder_block(uuid, text) from public;
revoke all on function private.settle_reminder_block(uuid, timestamptz, text, boolean) from public;
revoke all on function private.defer_reminder_block(uuid, timestamptz, boolean, uuid) from public;
revoke all on function private.hold_reminder_block(uuid, interval) from public;
revoke all on function private.release_reminder_block(uuid) from public;
revoke all on function private.reminder_block_gone(uuid, text) from public;
revoke all on function private.queue_reminder_blocks(uuid, timestamptz) from public;
revoke all on function private.reminder_blocks_pending(uuid[]) from public;
grant execute on function private.booking_busy(uuid, timestamptz, timestamptz) to crm_app;
grant execute on function private.claim_reminder_blocks(uuid[], uuid, integer) to crm_app;
grant execute on function private.begin_reminder_block_create(uuid) to crm_app;
grant execute on function private.link_reminder_block(uuid, text) to crm_app;
grant execute on function private.settle_reminder_block(uuid, timestamptz, text, boolean) to crm_app;
grant execute on function private.defer_reminder_block(uuid, timestamptz, boolean, uuid) to crm_app;
grant execute on function private.hold_reminder_block(uuid, interval) to crm_app;
grant execute on function private.release_reminder_block(uuid) to crm_app;
grant execute on function private.reminder_block_gone(uuid, text) to crm_app;
grant execute on function private.queue_reminder_blocks(uuid, timestamptz) to crm_app;
grant execute on function private.reminder_blocks_pending(uuid[]) to crm_app;

reset lock_timeout;

create unique index concurrently if not exists calendar_events_reminder_key
  on crm.calendar_events (reminder_id)
  where reminder_id is not null;
