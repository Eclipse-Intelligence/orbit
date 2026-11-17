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
    or (parent_run_id is not null and loop_step_id is not null and char_length(loop_step_id) between 1 and 400 and item_index is not null and item_index >= 0)
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

do $$
begin
  execute 'drop policy if exists workflow_workers_definer on crm.workflow_workers';
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    execute format('create policy workflow_workers_definer on crm.workflow_workers for all to %I using (true) with check (true)', current_user);
  end if;
end;
$$;

create table if not exists private.service_slots (
  slot_key text not null,
  holder text not null,
  expires_at timestamptz not null,
  primary key (slot_key, holder)
);

alter table private.service_slots enable row level security;
alter table private.service_slots force row level security;
revoke all on private.service_slots from public, anon, authenticated, crm_agent;

do $$
begin
  execute 'drop policy if exists service_slots_definer on private.service_slots';
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    execute format('create policy service_slots_definer on private.service_slots for all to %I using (true) with check (true)', current_user);
  end if;
end;
$$;

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
        or (
          exists (select 1 from crm.workflow_runs p where p.id = r.parent_run_id and p.status in ('running', 'waiting'))
          and coalesce((select bz.running from busy bz where bz.parent_run_id = r.parent_run_id), 0)
            < coalesce((select p.children_at_once from crm.workflow_runs p where p.id = r.parent_run_id), 50)
        )
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
  with busy as (
    select b.parent_run_id, count(*)::integer as running
    from crm.workflow_runs b
    where b.parent_run_id is not null and b.status = 'running' and b.claimed_at >= now() - interval '10 minutes'
    group by b.parent_run_id
  ),
  due as (
    select r.parent_run_id
    from crm.workflow_runs r
    where (r.status = 'queued' or (r.status = 'waiting' and r.waiting_for = 'delay' and r.resume_at <= now()))
      and (p_long or coalesce(r.state->>'needsTime', 'false') <> 'true')
      and exists (select 1 from crm.workspace_members m where m.workspace_id = r.workspace_id and m.user_id = r.owner_id)
      and (
        r.parent_run_id is null
        or exists (select 1 from crm.workflow_runs p where p.id = r.parent_run_id and p.status in ('running', 'waiting'))
      )
    limit 5000
  ),
  room as (
    select d.parent_run_id, count(*)::integer as waiting
    from due d
    group by d.parent_run_id
  )
  select coalesce(sum(
    case
      when k.parent_run_id is null then k.waiting
      else greatest(0, least(k.waiting,
        coalesce((select p.children_at_once from crm.workflow_runs p where p.id = k.parent_run_id), 50)
          - coalesce((select bz.running from busy bz where bz.parent_run_id = k.parent_run_id), 0)))
    end
  ), 0)::integer
  from room k;
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

create or replace function private.team_remove_records(
  p_workspace uuid,
  p_actor uuid,
  p_user uuid,
  p_source text default null,
  p_operation text default 'remove_member',
  p_source_url text default null
)
returns table (record_kind text, record_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := private.team_role(p_workspace, p_actor);
  target_role text := private.team_role(p_workspace, p_user);
  next_home uuid;
  handed jsonb := '[]'::jsonb;
  owner_only jsonb := jsonb_build_object('ownerId', p_user);
  owner_now jsonb := jsonb_build_object('ownerId', p_actor);
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

  with moved as (
    update crm.companies c set owner_id = p_actor
    where c.workspace_id = p_workspace and c.owner_id = p_user
    returning c.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'company', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  with moved as (
    update crm.contacts c set owner_id = p_actor
    where c.workspace_id = p_workspace and c.owner_id = p_user
    returning c.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'contact', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  with moved as (
    update crm.opportunities o set owner_id = p_actor
    where o.workspace_id = p_workspace and o.owner_id = p_user
    returning o.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'opportunity', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  with prior as (
    select t.id, t.owner_id, t.due_at, t.due_has_time, t.scheduled_by, t.remind_minutes
    from crm.tasks t
    where t.workspace_id = p_workspace
      and (t.owner_id = p_user or (t.owner_id is null and t.created_by_user_id = p_user))
    for update
  ),
  moved as (
    update crm.tasks t
      set owner_id = p_actor,
          due_at = case
            when t.due_has_time and t.due_at is not null
            then date_trunc('day', t.due_at at time zone 'Europe/London') at time zone 'Europe/London'
            else t.due_at
          end,
          scheduled_by = case when t.due_has_time then null else t.scheduled_by end,
          remind_minutes = case when t.due_has_time then null else t.remind_minutes end,
          due_has_time = false
    from prior
    where t.id = prior.id
    returning t.id, t.due_at, t.scheduled_by, t.remind_minutes
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object(
    'kind', 'task',
    'id', moved.id,
    'changes', private.handover_changes(
      jsonb_build_object(
        'ownerId', prior.owner_id,
        'dueAt', private.handover_instant(prior.due_at),
        'dueHasTime', coalesce(prior.due_has_time and prior.due_at is not null, false),
        'scheduledBy', prior.scheduled_by,
        'remindMinutes', prior.remind_minutes
      ),
      jsonb_build_object(
        'ownerId', p_actor,
        'dueAt', private.handover_instant(moved.due_at),
        'dueHasTime', false,
        'scheduledBy', moved.scheduled_by,
        'remindMinutes', moved.remind_minutes
      ),
      array['ownerId', 'dueAt', 'dueHasTime', 'scheduledBy', 'remindMinutes']
    )
  )), '[]'::jsonb)
  into handed
  from moved
  join prior on prior.id = moved.id;

  with moved as (
    update crm.documents d set owner_id = p_actor
    where d.workspace_id = p_workspace and d.owner_id = p_user
    returning d.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'document', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  update crm.task_occurrence_changes c
  set due_at = date_trunc('day', c.due_at at time zone 'Europe/London') at time zone 'Europe/London',
      due_has_time = false
  from crm.task_series s
  where c.series_id = s.id
    and s.workspace_id = p_workspace
    and s.owner_id = p_user
    and c.due_has_time;
  insert into crm.task_participants (task_id, user_id, added_by)
  select s.current_task_id, p_actor, p_actor
  from crm.task_series s
  join crm.tasks t on t.id = s.current_task_id
  where s.workspace_id = p_workspace and (s.owner_id = p_user or (s.owner_id is null and s.created_by_user_id = p_user))
    and t.owner_id is distinct from p_actor and t.created_by_user_id is distinct from p_actor
  on conflict do nothing;
  with series_events as (
    insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, source, source_url, operation, changes)
    select p_workspace, 'task_series.updated', 'task', handed_series.anchor, 'user', p_actor, p_source, p_source_url, p_operation,
      jsonb_build_object(
        'series', jsonb_build_object('id', handed_series.id),
        'handedOver', jsonb_build_object('from', p_user, 'to', case when handed_series.owner_id is null or handed_series.owner_id = p_user then p_actor else handed_series.owner_id end, 'owner', handed_series.owner_id = p_user, 'creator', handed_series.created_by_user_id = p_user)
      )
    from (
      select s.id, s.owner_id, s.created_by_user_id, coalesce(s.current_task_id, private.series_anchor_task(s.id)) as anchor
      from crm.task_series s
      where s.workspace_id = p_workspace and (s.owner_id = p_user or s.created_by_user_id = p_user)
        and (s.current_task_id is not null or (s.split_from_id is not null and s.ended_at is null and s.archived_at is null))
    ) handed_series
    where handed_series.anchor is not null
    returning id, event_type, entity_type, entity_id, changes, created_at
  )
  insert into crm.webhook_deliveries (workspace_id, endpoint_id, event_id, event_type, payload)
  select p_workspace, endpoint.id, series_events.id, series_events.event_type, jsonb_build_object(
    'id', series_events.id,
    'type', series_events.event_type,
    'createdAt', private.handover_instant(series_events.created_at),
    'workspaceId', p_workspace,
    'entity', jsonb_build_object('type', series_events.entity_type, 'id', series_events.entity_id),
    'actor', jsonb_build_object('type', 'user', 'userId', p_actor, 'agentId', null),
    'source', p_source,
    'sourceUrl', p_source_url,
    'data', series_events.changes
  )
  from series_events
  join crm.webhook_endpoints endpoint
    on endpoint.workspace_id = p_workspace
   and endpoint.archived_at is null
   and endpoint.enabled
   and (series_events.event_type = any(endpoint.events) or '*' = any(endpoint.events));
  update crm.task_series s
  set owner_id = p_actor,
      at = null,
      remind_minutes = null,
      roll_pending = case when s.ended_at is null and s.archived_at is null then true else s.roll_pending end
  where s.workspace_id = p_workspace and s.owner_id = p_user;
  update crm.task_series s set created_by_user_id = coalesce(s.owner_id, p_actor)
  where s.workspace_id = p_workspace and s.created_by_user_id = p_user;

  with items as (
    select item ->> 'kind' as kind, (item ->> 'id')::uuid as id, item -> 'changes' as changes
    from jsonb_array_elements(handed) as item
  ),
  events as (
    insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, source, source_url, operation, changes)
    select p_workspace, items.kind || '.updated', items.kind, items.id, 'user', p_actor, p_source, p_source_url, p_operation, items.changes
    from items
    returning id, event_type, entity_type, entity_id, changes, created_at
  )
  insert into crm.webhook_deliveries (workspace_id, endpoint_id, event_id, event_type, payload)
  select p_workspace, endpoint.id, events.id, events.event_type, jsonb_build_object(
    'id', events.id,
    'type', events.event_type,
    'createdAt', private.handover_instant(events.created_at),
    'workspaceId', p_workspace,
    'entity', jsonb_build_object('type', events.entity_type, 'id', events.entity_id),
    'actor', jsonb_build_object('type', 'user', 'userId', p_actor, 'agentId', null),
    'source', p_source,
    'sourceUrl', p_source_url,
    'data', events.changes
  )
  from events
  join crm.webhook_endpoints endpoint
    on endpoint.workspace_id = p_workspace
   and endpoint.archived_at is null
   and endpoint.enabled
   and (events.event_type = any(endpoint.events) or '*' = any(endpoint.events));

  update crm.webhook_endpoints set created_by_user_id = p_actor
  where workspace_id = p_workspace and created_by_user_id = p_user;

  update crm.workflow_runs r
    set status = 'cancelled', waiting_for = null, resume_at = null, finished_at = now()
  where r.workspace_id = p_workspace and r.owner_id = p_user and r.status in ('queued', 'running', 'waiting');

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

  return query
    select item ->> 'kind', (item ->> 'id')::uuid
    from jsonb_array_elements(handed) as item;
end;
$$;

revoke all on function private.team_remove_records(uuid, uuid, uuid, text, text, text) from public;
grant execute on function private.team_remove_records(uuid, uuid, uuid, text, text, text) to crm_app;

reset lock_timeout;

alter table crm.workflow_runs validate constraint workflow_runs_parent_fk;
alter table crm.workflow_runs validate constraint workflow_runs_waiting;
alter table crm.workflow_runs validate constraint workflow_runs_child_fields;
alter table crm.workflow_runs validate constraint workflow_runs_skip_reason_length;
alter table crm.workflow_runs validate constraint workflow_runs_children_counts;

create unique index concurrently if not exists workflow_runs_child_key on crm.workflow_runs (parent_run_id, loop_step_id, item_index) where parent_run_id is not null;

create index concurrently if not exists workflow_runs_running_children_idx on crm.workflow_runs (parent_run_id) where parent_run_id is not null and status = 'running';
