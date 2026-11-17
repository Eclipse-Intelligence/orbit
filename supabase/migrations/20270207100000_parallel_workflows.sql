set lock_timeout = '5s';

alter table crm.workflow_runs add column if not exists parent_run_id uuid;
alter table crm.workflow_runs add column if not exists loop_step_id text;
alter table crm.workflow_runs add column if not exists item_index integer;
alter table crm.workflow_runs add column if not exists skip_reason text;
alter table crm.workflow_runs add column if not exists children_total integer not null default 0;
alter table crm.workflow_runs add column if not exists children_at_once integer;
alter table crm.workflow_runs add column if not exists children_succeeded integer not null default 0;
alter table crm.workflow_runs add column if not exists children_skipped integer not null default 0;
alter table crm.workflow_runs add column if not exists children_failed integer not null default 0;

alter table crm.workflow_runs drop constraint if exists workflow_runs_parent_fk;
alter table crm.workflow_runs add constraint workflow_runs_parent_fk
  foreign key (parent_run_id) references crm.workflow_runs (id) on delete cascade not valid;

alter table crm.workflow_runs drop constraint if exists workflow_runs_waiting;
alter table crm.workflow_runs add constraint workflow_runs_waiting
  check (waiting_for is null or waiting_for in ('delay', 'approval', 'children')) not valid;

alter table crm.workflow_runs drop constraint if exists workflow_runs_child_fields;
alter table crm.workflow_runs add constraint workflow_runs_child_fields
  check (
    (parent_run_id is null and loop_step_id is null and item_index is null)
    or (parent_run_id is not null and loop_step_id is not null and char_length(loop_step_id) between 1 and 400 and item_index >= 0)
  ) not valid;

alter table crm.workflow_runs drop constraint if exists workflow_runs_skip_reason_length;
alter table crm.workflow_runs add constraint workflow_runs_skip_reason_length
  check (skip_reason is null or char_length(skip_reason) <= 2000) not valid;

alter table crm.workflow_runs drop constraint if exists workflow_runs_children_counts;
alter table crm.workflow_runs add constraint workflow_runs_children_counts
  check (
    children_total between 0 and 1000
    and children_succeeded >= 0 and children_skipped >= 0 and children_failed >= 0
    and (children_at_once is null or children_at_once between 1 and 500)
  ) not valid;

create table if not exists crm.workflow_workers (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table crm.workflow_workers enable row level security;
alter table crm.workflow_workers force row level security;
revoke all on crm.workflow_workers from public, anon, authenticated, crm_agent;

create table if not exists private.service_slots (
  slot_key text not null,
  holder text not null,
  expires_at timestamptz not null,
  primary key (slot_key, holder)
);

alter table private.service_slots enable row level security;
alter table private.service_slots force row level security;
revoke all on private.service_slots from public;

create or replace function private.claim_workflow_runs(p_limit integer, p_long boolean)
returns table (run_id uuid, workspace_id uuid, owner_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('orbit.claim_workflow_runs'));
  return query
  with busy as (
    select b.parent_run_id, count(*)::integer as running
    from crm.workflow_runs b
    where b.parent_run_id is not null and b.status = 'running' and b.claimed_at >= now() - interval '10 minutes'
    group by b.parent_run_id
  ),
  candidates as (
    select r.id, r.parent_run_id, coalesce(r.resume_at, r.created_at) as due_at
    from crm.workflow_runs r
    where (r.status = 'queued'
       or (r.status = 'waiting' and r.waiting_for = 'delay' and r.resume_at <= now())
       or (r.status = 'running' and r.claimed_at < now() - interval '10 minutes'))
      and (p_long or coalesce(r.state->>'needsTime', 'false') <> 'true')
      and exists (select 1 from crm.workspace_members m where m.workspace_id = r.workspace_id and m.user_id = r.owner_id)
      and (
        r.parent_run_id is null
        or coalesce((select bz.running from busy bz where bz.parent_run_id = r.parent_run_id), 0)
          < coalesce((select p.children_at_once from crm.workflow_runs p where p.id = r.parent_run_id), 50)
      )
    order by coalesce(r.resume_at, r.created_at)
    limit greatest(1, least(p_limit, 50)) * 4
    for update of r skip locked
  ),
  ranked as (
    select c.id, c.due_at, c.parent_run_id,
      row_number() over (partition by c.parent_run_id order by c.due_at, c.id) as place
    from candidates c
  ),
  due as (
    select k.id
    from ranked k
    where k.parent_run_id is null
      or k.place + coalesce((select bz.running from busy bz where bz.parent_run_id = k.parent_run_id), 0)
        <= coalesce((select p.children_at_once from crm.workflow_runs p where p.id = k.parent_run_id), 50)
    order by k.due_at
    limit greatest(1, least(p_limit, 50))
  )
  update crm.workflow_runs r
    set status = 'running', claimed_at = now(), started_at = coalesce(r.started_at, now()), waiting_for = null, resume_at = null
  from due
  where r.id = due.id
  returning r.id, r.workspace_id, r.owner_id;
end;
$$;
revoke all on function private.claim_workflow_runs(integer, boolean) from public;
grant execute on function private.claim_workflow_runs(integer, boolean) to crm_app;

create or replace function private.workflow_backlog(p_long boolean)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from (
    select 1
    from crm.workflow_runs r
    where (r.status = 'queued' or (r.status = 'waiting' and r.waiting_for = 'delay' and r.resume_at <= now()))
      and (p_long or coalesce(r.state->>'needsTime', 'false') <> 'true')
    limit 1000
  ) due;
$$;
revoke all on function private.workflow_backlog(boolean) from public;
grant execute on function private.workflow_backlog(boolean) to crm_app;

create or replace function private.take_workflow_worker(p_max integer, p_seconds integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_live integer;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('orbit.workflow_workers'));
  delete from crm.workflow_workers w where w.expires_at <= now();
  select count(*)::integer into v_live from crm.workflow_workers;
  if v_live >= greatest(1, least(coalesce(p_max, 10), 10)) then
    return null;
  end if;
  insert into crm.workflow_workers (expires_at)
  values (now() + make_interval(secs => greatest(30, least(coalesce(p_seconds, 300), 900))))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function private.take_workflow_worker(integer, integer) from public;
grant execute on function private.take_workflow_worker(integer, integer) to crm_app;

create or replace function private.release_workflow_worker(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from crm.workflow_workers w where w.id = p_id;
$$;
revoke all on function private.release_workflow_worker(uuid) from public;
grant execute on function private.release_workflow_worker(uuid) to crm_app;

create or replace function private.live_workflow_workers()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from crm.workflow_workers w where w.expires_at > now();
$$;
revoke all on function private.live_workflow_workers() from public;
grant execute on function private.live_workflow_workers() to crm_app;

create or replace function private.take_slot(p_key text, p_limit integer, p_holder text, p_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('orbit.slot:' || p_key));
  delete from private.service_slots s where s.slot_key = p_key and s.expires_at <= now();
  update private.service_slots s
    set expires_at = now() + make_interval(secs => greatest(1, coalesce(p_seconds, 300)))
  where s.slot_key = p_key and s.holder = p_holder;
  if found then
    return true;
  end if;
  select count(*)::integer into v_count from private.service_slots s where s.slot_key = p_key;
  if v_count >= greatest(1, coalesce(p_limit, 1)) then
    return false;
  end if;
  insert into private.service_slots (slot_key, holder, expires_at)
  values (p_key, p_holder, now() + make_interval(secs => greatest(1, coalesce(p_seconds, 300))));
  return true;
end;
$$;
revoke all on function private.take_slot(text, integer, text, integer) from public;
grant execute on function private.take_slot(text, integer, text, integer) to crm_app;

create or replace function private.release_slot(p_key text, p_holder text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.service_slots s where s.slot_key = p_key and s.holder = p_holder;
$$;
revoke all on function private.release_slot(text, text) from public;
grant execute on function private.release_slot(text, text) to crm_app;

reset lock_timeout;

alter table crm.workflow_runs validate constraint workflow_runs_parent_fk;
alter table crm.workflow_runs validate constraint workflow_runs_waiting;
alter table crm.workflow_runs validate constraint workflow_runs_child_fields;
alter table crm.workflow_runs validate constraint workflow_runs_skip_reason_length;
alter table crm.workflow_runs validate constraint workflow_runs_children_counts;

create unique index concurrently if not exists workflow_runs_child_key on crm.workflow_runs (parent_run_id, loop_step_id, item_index) where parent_run_id is not null;

create index concurrently if not exists workflow_runs_running_children_idx on crm.workflow_runs (parent_run_id) where parent_run_id is not null and status = 'running';
