set lock_timeout = '5s';

alter table crm.tasks add column if not exists calendar_event_ref text;

alter table crm.tasks drop constraint if exists tasks_calendar_event_ref_length;
alter table crm.tasks
  add constraint tasks_calendar_event_ref_length
  check (calendar_event_ref is null or char_length(calendar_event_ref) between 1 and 400);

alter table crm.calendar_events add column if not exists task_id uuid references crm.tasks (id) on delete set null;
alter table crm.calendar_events add column if not exists block_written_at timestamptz;
alter table crm.calendar_events add column if not exists block_workspace_id uuid;

grant update (task_id, block_written_at, block_workspace_id) on crm.calendar_events to authenticated;

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
  );

create or replace function private.calendar_event_task_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.session_user_id();
begin
  if new.task_id is null or v_user is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.task_id is not distinct from old.task_id then
    return new;
  end if;
  if not exists (select 1 from crm.tasks t where t.id = new.task_id and t.owner_id = v_user) then
    raise exception 'task block must be your own task' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.calendar_event_task_guard() from public;

drop trigger if exists calendar_events_task_guard on crm.calendar_events;
create trigger calendar_events_task_guard
  before insert or update of task_id on crm.calendar_events
  for each row execute function private.calendar_event_task_guard();

create table if not exists crm.task_outlook_queue (
  task_id uuid primary key references crm.tasks (id) on delete cascade,
  pending_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  attempts integer not null default 0,
  retry_at timestamptz,
  refused boolean not null default false
);

alter table crm.task_outlook_queue add column if not exists attempts integer not null default 0;
alter table crm.task_outlook_queue add column if not exists retry_at timestamptz;
alter table crm.task_outlook_queue add column if not exists refused boolean not null default false;

alter table crm.integration_state add column if not exists task_blocks_write boolean;

alter table crm.task_outlook_queue enable row level security;
alter table crm.task_outlook_queue force row level security;
revoke all on crm.task_outlook_queue from public, anon, authenticated, crm_agent;

do $$
begin
  execute 'drop policy if exists task_outlook_queue_definer on crm.task_outlook_queue';
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    execute format('create policy task_outlook_queue_definer on crm.task_outlook_queue for all to %I using (true) with check (true)', current_user);
  end if;
end;
$$;

create or replace function private.task_outlook_enqueue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and new.due_at is not distinct from old.due_at
    and new.due_has_time is not distinct from old.due_has_time
    and new.duration_minutes is not distinct from old.duration_minutes
    and new.owner_id is not distinct from old.owner_id
    and new.completed_at is not distinct from old.completed_at
    and new.archived_at is not distinct from old.archived_at
    and new.title is not distinct from old.title
    and new.workspace_id is not distinct from old.workspace_id
  then
    return null;
  end if;
  if new.calendar_event_ref is null
    and not (
      new.owner_id is not null
      and new.due_has_time
      and new.due_at is not null
      and new.completed_at is null
      and new.archived_at is null
    )
  then
    return null;
  end if;
  insert into crm.task_outlook_queue (task_id, pending_at)
  values (new.id, clock_timestamp())
  on conflict (task_id) do update
  set pending_at = excluded.pending_at, attempts = 0, retry_at = null, refused = false;
  return null;
end;
$$;

revoke all on function private.task_outlook_enqueue() from public;

drop trigger if exists tasks_outlook_enqueue on crm.tasks;
create trigger tasks_outlook_enqueue
  after insert or update on crm.tasks
  for each row execute function private.task_outlook_enqueue();

drop function if exists private.claim_task_blocks(uuid[], uuid, integer);
create function private.claim_task_blocks(p_task_ids uuid[], p_user_id uuid, p_limit integer)
returns table (
  task_id uuid,
  workspace_id uuid,
  title text,
  due_at timestamptz,
  due_has_time boolean,
  duration_minutes integer,
  owner_id uuid,
  completed_at timestamptz,
  archived_at timestamptz,
  calendar_event_ref text,
  pending_at text,
  attempts integer,
  event_id uuid,
  event_user_id uuid,
  provider_event_id text,
  event_starts_at timestamptz,
  event_ends_at timestamptz,
  event_subject text,
  event_workspace_id uuid
)
language sql
security definer
set search_path = ''
set datestyle = 'ISO, YMD'
as $$
  with picked as (
    select q.task_id
    from crm.task_outlook_queue q
    join crm.tasks t on t.id = q.task_id
    where (q.claimed_at is null or q.claimed_at < clock_timestamp() - interval '2 minutes')
      and (q.retry_at is null or q.retry_at <= clock_timestamp())
      and (p_task_ids is null or q.task_id = any(p_task_ids))
      and (
        p_user_id is null
        or t.owner_id = p_user_id
        or exists (select 1 from crm.calendar_events e where e.task_id = q.task_id and e.user_id = p_user_id)
      )
    order by q.pending_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of q skip locked
  ), claimed as (
    update crm.task_outlook_queue q
    set claimed_at = clock_timestamp()
    from picked
    where q.task_id = picked.task_id
    returning q.task_id, q.pending_at, q.attempts
  )
  select t.id, t.workspace_id, t.title, t.due_at, t.due_has_time, t.duration_minutes, t.owner_id,
         t.completed_at, t.archived_at, t.calendar_event_ref, c.pending_at::text, c.attempts,
         e.id, e.user_id, e.provider_event_id, e.starts_at, e.ends_at, e.subject, e.block_workspace_id
  from claimed c
  join crm.tasks t on t.id = c.task_id
  left join crm.calendar_events e on e.task_id = c.task_id
  order by c.pending_at
$$;

drop function if exists private.settle_task_block(uuid, timestamptz, text, boolean);
drop function if exists private.settle_task_block(uuid, text, text, boolean);
create or replace function private.settle_task_block(p_task_id uuid, p_pending_at timestamptz, p_ref text, p_set_ref boolean, p_drop_event boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from crm.calendar_events
  where task_id = p_task_id and p_drop_event;
  update crm.tasks
  set calendar_event_ref = p_ref
  where id = p_task_id and p_set_ref and calendar_event_ref is distinct from p_ref;
  delete from crm.task_outlook_queue
  where task_id = p_task_id and pending_at = p_pending_at;
  update crm.task_outlook_queue
  set claimed_at = null
  where task_id = p_task_id;
$$;

create or replace function private.link_task_block(p_task_id uuid, p_ref text)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.tasks
  set calendar_event_ref = p_ref
  where id = p_task_id and calendar_event_ref is distinct from p_ref;
$$;

drop function if exists private.defer_task_block(uuid, boolean);
create or replace function private.defer_task_block(p_task_id uuid, p_pending_at timestamptz, p_refused boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_outlook_queue
  set claimed_at = null,
      attempts = case when pending_at = p_pending_at then attempts + 1 else attempts end,
      refused = case when pending_at = p_pending_at then p_refused else refused end,
      retry_at = case
        when pending_at <> p_pending_at then retry_at
        when p_refused then 'infinity'::timestamptz
        else clock_timestamp() + least(interval '6 hours', interval '1 minute' * power(2, least(attempts, 12)))
      end
  where task_id = p_task_id;
$$;

create or replace function private.note_task_blocks_write(p_connection_id uuid, p_write boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before boolean;
begin
  select s.task_blocks_write into v_before
  from crm.integration_state s
  where s.connection_id = p_connection_id and s.source = 'calendar'
  for update;
  if not found then
    return p_write;
  end if;
  update crm.integration_state
  set task_blocks_write = p_write
  where connection_id = p_connection_id and source = 'calendar' and task_blocks_write is distinct from p_write;
  return p_write and v_before is distinct from true;
end;
$$;

create or replace function private.release_task_block(p_task_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_outlook_queue set claimed_at = null where task_id = p_task_id;
$$;

drop function if exists private.queue_task_blocks(uuid, timestamptz);
create or replace function private.queue_task_blocks(p_user_id uuid, p_now timestamptz, p_fresh boolean)
returns integer
language sql
security definer
set search_path = ''
as $$
  with wanted as (
    select t.id
    from crm.tasks t
    join crm.workspace_members m on m.workspace_id = t.workspace_id and m.user_id = t.owner_id
    left join crm.calendar_events e on e.task_id = t.id and e.user_id = t.owner_id
    where t.owner_id = p_user_id
      and t.due_has_time
      and t.due_at is not null
      and t.completed_at is null
      and t.archived_at is null
      and (
        (t.calendar_event_ref is null and e.id is null and t.due_at + make_interval(mins => t.duration_minutes) > p_now)
        or (
          t.calendar_event_ref is not null
          and (
            e.id is null
            or e.provider_event_id is distinct from t.calendar_event_ref
            or e.starts_at is distinct from t.due_at
            or e.ends_at is distinct from t.due_at + make_interval(mins => t.duration_minutes)
            or e.subject is distinct from t.title
          )
        )
      )
    union
    select t.id
    from crm.tasks t
    where t.calendar_event_ref is not null
      and (t.owner_id = p_user_id or exists (select 1 from crm.calendar_events e where e.task_id = t.id and e.user_id = p_user_id))
      and (not t.due_has_time or t.archived_at is not null or t.owner_id is distinct from p_user_id)
  ), added as (
    insert into crm.task_outlook_queue (task_id)
    select id from wanted
    on conflict (task_id) do update
    set retry_at = null, attempts = 0, refused = false
    where p_fresh
    returning 1
  )
  select count(*)::integer from added
$$;

create or replace function private.task_blocks_pending(p_task_ids uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select q.task_id from crm.task_outlook_queue q where q.task_id = any(p_task_ids) and not q.refused
$$;

create or replace function private.team_remove(p_workspace uuid, p_actor uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := private.team_role(p_workspace, p_actor);
  target_role text := private.team_role(p_workspace, p_user);
  next_home uuid;
begin
  if coalesce(actor_role, '') not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can remove people.' using errcode = '42501';
  end if;
  if target_role is null then
    raise exception 'They are not in this workspace.' using errcode = '22023';
  end if;
  if target_role = 'owner' then
    raise exception 'The owner can''t be removed.' using errcode = '42501';
  end if;
  if p_user = p_actor then
    raise exception 'You can''t remove yourself.' using errcode = '42501';
  end if;
  if target_role = 'admin' and actor_role <> 'owner' then
    raise exception 'Only the owner can remove an admin.' using errcode = '42501';
  end if;
  select m.workspace_id into next_home
  from crm.workspace_members m
  where m.user_id = p_user and m.workspace_id <> p_workspace
  order by m.created_at, m.workspace_id
  limit 1;
  update crm.companies set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.contacts set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.opportunities set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.tasks
    set owner_id = p_actor,
        due_at = case
          when due_has_time and due_at is not null
          then date_trunc('day', due_at at time zone 'Europe/London') at time zone 'Europe/London'
          else due_at
        end,
        scheduled_by = case when due_has_time then null else scheduled_by end,
        remind_minutes = case when due_has_time then null else remind_minutes end,
        due_has_time = false
    where workspace_id = p_workspace and owner_id = p_user;
  update crm.documents set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  if next_home is not null then
    perform private.move_personal_rows(p_user, p_workspace, next_home);
  else
    update crm.mailbox_connections
      set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
      where workspace_id = p_workspace and user_id = p_user;
    update crm.calendar_accounts
      set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
      where workspace_id = p_workspace and user_id = p_user;
    delete from crm.ai_accounts where workspace_id = p_workspace and user_id = p_user;
    update crm.ai_companions set revoked_at = now()
      where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  end if;
  delete from crm.granola_keys where workspace_id = p_workspace and user_id = p_user;
  delete from crm.readwise_keys where workspace_id = p_workspace and user_id = p_user;
  delete from crm.recall_keys where workspace_id = p_workspace and user_id = p_user;
  update crm.personal_tokens set revoked_at = now()
    where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  update crm.agent_mail_messages
    set status = 'failed', status_reason = 'They left the workspace.', advancing_until = null
    where workspace_id = p_workspace and user_id = p_user and status in ('received', 'working') and replied_at is null;
  delete from crm.agent_mail_threads where workspace_id = p_workspace and user_id = p_user;
  delete from crm.workspace_members where workspace_id = p_workspace and user_id = p_user;
end;
$$;

revoke all on function private.team_remove(uuid, uuid, uuid) from public;
grant execute on function private.team_remove(uuid, uuid, uuid) to crm_app;

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
  ) busy
  order by busy.starts_at
  limit 5000;
end;
$$;

revoke all on function private.claim_task_blocks(uuid[], uuid, integer) from public;
revoke all on function private.settle_task_block(uuid, timestamptz, text, boolean, boolean) from public;
revoke all on function private.link_task_block(uuid, text) from public;
revoke all on function private.defer_task_block(uuid, timestamptz, boolean) from public;
revoke all on function private.release_task_block(uuid) from public;
revoke all on function private.note_task_blocks_write(uuid, boolean) from public;
revoke all on function private.queue_task_blocks(uuid, timestamptz, boolean) from public;
revoke all on function private.task_blocks_pending(uuid[]) from public;
revoke all on function private.booking_busy(uuid, timestamptz, timestamptz) from public;
grant execute on function private.claim_task_blocks(uuid[], uuid, integer) to crm_app;
grant execute on function private.settle_task_block(uuid, timestamptz, text, boolean, boolean) to crm_app;
grant execute on function private.link_task_block(uuid, text) to crm_app;
grant execute on function private.defer_task_block(uuid, timestamptz, boolean) to crm_app;
grant execute on function private.release_task_block(uuid) to crm_app;
grant execute on function private.note_task_blocks_write(uuid, boolean) to crm_app;
grant execute on function private.queue_task_blocks(uuid, timestamptz, boolean) to crm_app;
grant execute on function private.task_blocks_pending(uuid[]) to crm_app;
grant execute on function private.booking_busy(uuid, timestamptz, timestamptz) to crm_app;

reset lock_timeout;

create unique index concurrently if not exists calendar_events_task_key
  on crm.calendar_events (task_id)
  where task_id is not null;

create index concurrently if not exists tasks_owner_timed_idx
  on crm.tasks (owner_id, due_at)
  where due_has_time and completed_at is null and archived_at is null;

create index concurrently if not exists tasks_calendar_event_ref_idx
  on crm.tasks (calendar_event_ref)
  where calendar_event_ref is not null;
