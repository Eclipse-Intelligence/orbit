set lock_timeout = '5s';

drop policy if exists tasks_select_member on crm.tasks;
create policy tasks_select_member on crm.tasks
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      owner_id = (select private.session_user_id())
      or created_by_user_id = (select private.session_user_id())
      or id in (select private.my_task_ids())
    )
  );

drop policy if exists tasks_update_member on crm.tasks;
create policy tasks_update_member on crm.tasks
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      owner_id = (select private.session_user_id())
      or created_by_user_id = (select private.session_user_id())
    )
  )
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists tasks_insert_member on crm.tasks;
create policy tasks_insert_member on crm.tasks
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and created_by_user_id = (select private.session_user_id())
    and created_by_agent_id is null
  );

drop policy if exists tasks_select_agent on crm.tasks;
create policy tasks_select_agent on crm.tasks
  for select to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and created_by_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
  );

drop policy if exists tasks_insert_agent on crm.tasks;
create policy tasks_insert_agent on crm.tasks
  for insert to crm_agent
  with check (
    workspace_id = (select private.request_workspace_id())
    and created_by_user_id is null
    and created_by_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
  );

drop policy if exists tasks_update_agent on crm.tasks;
create policy tasks_update_agent on crm.tasks
  for update to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and created_by_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
  )
  with check (
    workspace_id = (select private.request_workspace_id())
    and created_by_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
  );

drop policy if exists task_participants_delete on crm.task_participants;
create policy task_participants_delete on crm.task_participants
  for delete to authenticated
  using (
    task_id in (select t.id from crm.tasks t)
    and (
      user_id = (select private.session_user_id())
      or exists (
        select 1 from crm.tasks t
        where t.id = task_participants.task_id
          and (
            t.owner_id = (select private.session_user_id())
            or t.created_by_user_id = (select private.session_user_id())
          )
      )
    )
  );

drop policy if exists task_outcomes_insert on crm.task_outcomes;
create policy task_outcomes_insert on crm.task_outcomes
  for insert to authenticated
  with check (
    created_by = (select private.session_user_id())
    and exists (
      select 1 from crm.tasks t
      where t.id = task_outcomes.task_id
        and t.workspace_id in (select private.user_workspace_ids())
        and (
          t.owner_id = (select private.session_user_id())
          or t.created_by_user_id = (select private.session_user_id())
        )
    )
  );

drop policy if exists audit_select_member on crm.audit_events;
create policy audit_select_member on crm.audit_events
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      entity_type <> 'task'
      or actor_user_id = (select private.session_user_id())
      or exists (select 1 from crm.tasks t where t.id = audit_events.entity_id)
    )
  );

drop policy if exists audit_insert_member on crm.audit_events;
create policy audit_insert_member on crm.audit_events
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and actor_type = 'user'
    and actor_user_id = (select private.session_user_id())
    and actor_agent_id is null
  );

drop policy if exists audit_insert_agent on crm.audit_events;
create policy audit_insert_agent on crm.audit_events
  for insert to crm_agent
  with check (
    workspace_id = (select private.request_workspace_id())
    and actor_type = 'agent'
    and actor_user_id is null
    and actor_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
  );

drop policy if exists webhook_deliveries_insert_member on crm.webhook_deliveries;
create policy webhook_deliveries_insert_member on crm.webhook_deliveries
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and exists (
      select 1 from crm.audit_events e
      join crm.webhook_endpoints endpoint on endpoint.id = webhook_deliveries.endpoint_id and endpoint.workspace_id = e.workspace_id
      where e.id = webhook_deliveries.event_id
        and e.workspace_id = webhook_deliveries.workspace_id
        and e.actor_user_id = (select private.session_user_id())
        and e.event_type = webhook_deliveries.event_type
        and webhook_deliveries.payload ->> 'id' = e.id::text
        and webhook_deliveries.payload ->> 'type' = e.event_type
        and webhook_deliveries.payload -> 'entity' ->> 'type' = e.entity_type
        and webhook_deliveries.payload -> 'entity' ->> 'id' = e.entity_id::text
    )
  );

drop policy if exists webhook_deliveries_insert_agent on crm.webhook_deliveries;
create policy webhook_deliveries_insert_agent on crm.webhook_deliveries
  for insert to crm_agent
  with check (
    workspace_id = (select private.request_workspace_id())
    and exists (
      select 1 from crm.audit_events e
      join crm.webhook_endpoints endpoint on endpoint.id = webhook_deliveries.endpoint_id and endpoint.workspace_id = e.workspace_id
      where e.id = webhook_deliveries.event_id
        and e.workspace_id = webhook_deliveries.workspace_id
        and e.actor_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
        and e.event_type = webhook_deliveries.event_type
        and webhook_deliveries.payload ->> 'id' = e.id::text
        and webhook_deliveries.payload ->> 'type' = e.event_type
        and webhook_deliveries.payload -> 'entity' ->> 'type' = e.entity_type
        and webhook_deliveries.payload -> 'entity' ->> 'id' = e.entity_id::text
    )
  );

drop policy if exists audit_select_agent on crm.audit_events;
create policy audit_select_agent on crm.audit_events
  for select to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and (
      entity_type <> 'task'
      or actor_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
      or exists (select 1 from crm.tasks t where t.id = audit_events.entity_id)
    )
  );

drop policy if exists idempotency_select_member on crm.idempotency_keys;
create policy idempotency_select_member on crm.idempotency_keys
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and actor_key = 'user:' || (select private.session_user_id())::text
  );

drop policy if exists idempotency_insert_member on crm.idempotency_keys;
create policy idempotency_insert_member on crm.idempotency_keys
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and actor_key = 'user:' || (select private.session_user_id())::text
  );

drop policy if exists idempotency_select_agent on crm.idempotency_keys;
create policy idempotency_select_agent on crm.idempotency_keys
  for select to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and actor_key = 'agent:' || (select current_setting('app.agent_id', true))
  );

drop policy if exists idempotency_insert_agent on crm.idempotency_keys;
create policy idempotency_insert_agent on crm.idempotency_keys
  for insert to crm_agent
  with check (
    workspace_id = (select private.request_workspace_id())
    and actor_key = 'agent:' || (select current_setting('app.agent_id', true))
  );

drop policy if exists webhook_deliveries_select_member on crm.webhook_deliveries;
create policy webhook_deliveries_select_member on crm.webhook_deliveries
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      payload -> 'entity' ->> 'type' is distinct from 'task'
      or exists (
        select 1 from crm.tasks t
        where t.id = case when webhook_deliveries.payload -> 'entity' ->> 'type' = 'task' then (webhook_deliveries.payload -> 'entity' ->> 'id')::uuid end
      )
    )
  );

drop policy if exists webhook_deliveries_select_agent on crm.webhook_deliveries;
create policy webhook_deliveries_select_agent on crm.webhook_deliveries
  for select to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and (
      payload -> 'entity' ->> 'type' is distinct from 'task'
      or exists (
        select 1 from crm.tasks t
        where t.id = case when webhook_deliveries.payload -> 'entity' ->> 'type' = 'task' then (webhook_deliveries.payload -> 'entity' ->> 'id')::uuid end
      )
    )
  );

alter table crm.webhook_endpoints add column if not exists created_by_user_id uuid references crm.profiles (id) on delete set null;
alter table crm.webhook_endpoints add column if not exists created_by_agent_id uuid references crm.agents (id) on delete set null;

drop policy if exists webhook_endpoints_insert_member on crm.webhook_endpoints;
create policy webhook_endpoints_insert_member on crm.webhook_endpoints
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (select private.is_workspace_admin(workspace_id))
    and created_by_user_id = (select private.session_user_id())
    and created_by_agent_id is null
  );

drop policy if exists webhook_endpoints_update_member on crm.webhook_endpoints;
create policy webhook_endpoints_update_member on crm.webhook_endpoints
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and (select private.is_workspace_admin(workspace_id)))
  with check (workspace_id in (select private.user_workspace_ids()) and (select private.is_workspace_admin(workspace_id)));

drop policy if exists webhook_endpoints_insert_agent on crm.webhook_endpoints;
create policy webhook_endpoints_insert_agent on crm.webhook_endpoints
  for insert to crm_agent
  with check (
    workspace_id = (select private.request_workspace_id())
    and created_by_user_id is null
    and created_by_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
  );

create or replace function private.webhook_endpoints_keep_creator()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid;
  v_agent uuid := nullif(current_setting('app.agent_id', true), '')::uuid;
begin
  if current_user not in ('authenticated', 'crm_agent') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.created_by_user_id is null and new.created_by_agent_id is null then
      if current_user = 'authenticated' then
        new.created_by_user_id := v_user;
      else
        new.created_by_agent_id := v_agent;
      end if;
    end if;
    return new;
  end if;
  new.created_by_user_id := old.created_by_user_id;
  new.created_by_agent_id := old.created_by_agent_id;
  if (new.url, new.secret, new.events) is distinct from (old.url, old.secret, old.events)
    and not (
      (current_user = 'authenticated' and old.created_by_user_id is not distinct from v_user and v_user is not null)
      or (current_user = 'crm_agent' and old.created_by_agent_id is not distinct from v_agent and v_agent is not null)
    ) then
    raise exception 'Only whoever made this webhook can change where it sends or what it sends.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.webhook_endpoints_keep_creator() from public;

drop trigger if exists webhook_endpoints_keep_creator on crm.webhook_endpoints;
create trigger webhook_endpoints_keep_creator
  before insert or update on crm.webhook_endpoints
  for each row execute function private.webhook_endpoints_keep_creator();

update crm.webhook_endpoints e
set created_by_user_id = (
  select m.user_id from crm.workspace_members m
  where m.workspace_id = e.workspace_id and m.role = 'owner'
  order by m.created_at, m.user_id
  limit 1
)
where e.created_by_user_id is null and e.created_by_agent_id is null;

with owners as (
  select distinct on (m.workspace_id) m.workspace_id, m.user_id
  from crm.workspace_members m
  where m.role = 'owner'
  order by m.workspace_id, m.created_at, m.user_id
),
assigned as (
  update crm.tasks t
  set owner_id = owners.user_id
  from owners
  where owners.workspace_id = t.workspace_id
    and t.owner_id is null and t.created_by_user_id is null
    and t.archived_at is null and t.completed_at is null
  returning t.id, t.workspace_id, t.owner_id
)
insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, operation, source, changes)
select assigned.workspace_id, 'task.updated', 'task', assigned.id, 'system', 'assign_agent_task_to_owner', 'migration',
  jsonb_build_object('fields', jsonb_build_array('ownerId'), 'before', jsonb_build_object('ownerId', null), 'after', jsonb_build_object('ownerId', assigned.owner_id))
from assigned;

create or replace function private.webhook_delivery_audience()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task text := new.payload -> 'entity' ->> 'id';
  v_user uuid;
  v_agent uuid;
begin
  if new.payload -> 'entity' ->> 'type' is distinct from 'task' then
    return new;
  end if;
  if v_task is null or v_task !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  select e.created_by_user_id, e.created_by_agent_id into v_user, v_agent
  from crm.webhook_endpoints e
  where e.id = new.endpoint_id;
  if exists (
    select 1 from crm.tasks t
    where t.id = v_task::uuid
      and t.workspace_id = new.workspace_id
      and (
        (
          v_user is not null
          and exists (select 1 from crm.workspace_members m where m.workspace_id = t.workspace_id and m.user_id = v_user)
          and (
            t.owner_id = v_user
            or t.created_by_user_id = v_user
            or exists (select 1 from crm.task_participants p where p.task_id = t.id and p.user_id = v_user)
          )
        )
        or (v_agent is not null and t.created_by_agent_id = v_agent)
      )
  ) then
    return new;
  end if;
  return null;
end;
$$;

revoke all on function private.webhook_delivery_audience() from public;

drop trigger if exists webhook_deliveries_audience on crm.webhook_deliveries;
create trigger webhook_deliveries_audience
  before insert on crm.webhook_deliveries
  for each row execute function private.webhook_delivery_audience();

create or replace function private.tasks_keep_workspace()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'crm_agent') then
    raise exception 'Move tasks to another workspace with Move to.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.tasks_keep_workspace() from public;

create or replace function private.tasks_keep_creator()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'crm_agent') then
    raise exception 'A task''s creator can''t be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.tasks_keep_creator() from public;

drop trigger if exists tasks_keep_creator on crm.tasks;
create trigger tasks_keep_creator
  before update of created_by_user_id, created_by_agent_id on crm.tasks
  for each row
  when (old.created_by_user_id is distinct from new.created_by_user_id or old.created_by_agent_id is distinct from new.created_by_agent_id)
  execute function private.tasks_keep_creator();

drop trigger if exists tasks_keep_workspace on crm.tasks;
create trigger tasks_keep_workspace
  before update of workspace_id on crm.tasks
  for each row
  when (old.workspace_id is distinct from new.workspace_id)
  execute function private.tasks_keep_workspace();

create or replace function private.dispatch_workflow_events(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer := 0;
  inserted integer := 0;
  event crm.workflow_events%rowtype;
begin
  for event in
    select * from crm.workflow_events order by created_at limit greatest(1, least(p_limit, 500)) for update skip locked
  loop
    if event.depth < 3 then
      insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, definition, event, company_id, contact_id, depth)
      select
        w.workspace_id,
        w.id,
        w.owner_id,
        w.definition,
        jsonb_build_object(
          'type', event.event_type,
          'entityType', event.entity_type,
          'entityId', event.entity_id,
          'data', event.data,
          'actorUserId', event.actor_user_id,
          'at', event.created_at
        ),
        case when event.entity_type = 'company' then event.entity_id else null end,
        case when event.entity_type = 'contact' then event.entity_id else null end,
        event.depth
      from crm.workflows w
      join crm.workspace_members m on m.workspace_id = w.workspace_id and m.user_id = w.owner_id
      where w.workspace_id = event.workspace_id
        and w.status = 'active'
        and w.archived_at is null
        and w.trigger_type = any(event.trigger_types)
        and w.id is distinct from event.source_workflow_id
        and (event.owner_user_id is null or w.owner_id = event.owner_user_id)
        and (
          event.entity_type is distinct from 'task'
          or exists (
            select 1 from crm.tasks t
            where t.id = event.entity_id
              and (
                t.owner_id = w.owner_id
                or t.created_by_user_id = w.owner_id
                or exists (select 1 from crm.task_participants tp where tp.task_id = t.id and tp.user_id = w.owner_id)
              )
          )
        );
      get diagnostics inserted = row_count;
      dispatched := dispatched + inserted;
    end if;
    delete from crm.workflow_events where id = event.id;
  end loop;
  return dispatched;
end;
$$;

revoke all on function private.dispatch_workflow_events(integer) from public;
grant execute on function private.dispatch_workflow_events(integer) to crm_app;

create or replace function private.waiting_approvals_of_others(p_user uuid, p_workspace uuid)
returns table (
  id uuid,
  workflow_id uuid,
  workflow_name text,
  title text,
  owner_name text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select null::uuid, null::uuid, null::text, null::text, null::text, null::timestamptz
  where false;
$$;

create or replace function private.clickup_keepers(p_workspace uuid, p_tasks uuid[], p_prefer uuid)
returns table (task_id uuid, workspace_id uuid, workspace_name text, user_id uuid, role text, email text, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, w.id, w.name, keeper.user_id, keeper.role, p.email, p.full_name
  from crm.tasks t
  join crm.workspaces w on w.id = t.workspace_id
  join lateral (
    select m.user_id, m.role
    from crm.workspace_members m
    where m.workspace_id = t.workspace_id and m.user_id in (t.owner_id, t.created_by_user_id)
    order by (m.user_id = p_prefer) desc, (m.user_id = t.owner_id) desc
    limit 1
  ) keeper on true
  join crm.profiles p on p.id = keeper.user_id
  where t.workspace_id = p_workspace and t.id = any(p_tasks)
  order by t.id;
$$;

revoke all on function private.clickup_keepers(uuid, uuid[], uuid) from public;
grant execute on function private.clickup_keepers(uuid, uuid[], uuid) to crm_app;

create or replace function private.clickup_member(p_workspace uuid, p_user uuid)
returns table (workspace_id uuid, workspace_name text, user_id uuid, role text, email text, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.workspace_members m
  join crm.workspaces w on w.id = m.workspace_id
  join crm.profiles p on p.id = m.user_id
  where m.workspace_id = p_workspace and m.user_id = p_user;
$$;

revoke all on function private.clickup_member(uuid, uuid) from public;
grant execute on function private.clickup_member(uuid, uuid) to crm_app;

create or replace function private.clickup_matching_tasks(p_workspace uuid, p_clickup_task text, p_list text, p_title text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from crm.tasks t
  where t.workspace_id = p_workspace and t.clickup_task_id = p_clickup_task
  union all
  select t.id from crm.tasks t
  where t.workspace_id = p_workspace and t.clickup_task_id is null and t.archived_at is null
    and p_list is not null
    and (
      (t.clickup_sync -> 'unconfirmed' ->> 'listId' = p_list and t.clickup_sync -> 'unconfirmed' ->> 'title' = p_title)
      or (t.clickup_list_id = p_list and t.title = p_title and t.clickup_sync ? 'creatingAt')
    )
  order by 1;
$$;

revoke all on function private.clickup_matching_tasks(uuid, text, text, text) from public;
grant execute on function private.clickup_matching_tasks(uuid, text, text, text) to crm_app;

create or replace function private.clickup_linked_lists(p_workspace uuid, p_limit integer)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select distinct t.clickup_list_id from crm.tasks t
  where t.workspace_id = p_workspace and t.clickup_task_id is not null and t.clickup_list_id is not null and t.archived_at is null
  order by t.clickup_list_id
  limit p_limit;
$$;

revoke all on function private.clickup_linked_lists(uuid, integer) from public;
grant execute on function private.clickup_linked_lists(uuid, integer) to crm_app;

create or replace function private.clickup_push_queue(p_workspace uuid, p_limit integer)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from crm.tasks t
  where t.workspace_id = p_workspace and t.archived_at is null and t.clickup_list_id is not null
    and exists (
      select 1 from crm.workspace_members m
      where m.workspace_id = t.workspace_id and m.user_id in (t.owner_id, t.created_by_user_id)
    )
    and (
      t.clickup_task_id is null
      or t.title is distinct from t.clickup_sync ->> 'title'
      or t.due_at is distinct from (t.clickup_sync ->> 'dueAt')::timestamptz
      or (t.clickup_sync ? 'dueHasTime' and t.due_has_time is distinct from (t.clickup_sync ->> 'dueHasTime')::boolean)
      or (t.completed_at is not null) is distinct from (t.clickup_sync ->> 'done')::boolean
    )
  order by t.clickup_synced_at asc nulls first, t.updated_at asc
  limit p_limit;
$$;

revoke all on function private.clickup_push_queue(uuid, integer) from public;
grant execute on function private.clickup_push_queue(uuid, integer) to crm_app;

create or replace function private.clickup_stale_tasks(p_workspace uuid, p_seconds double precision, p_limit integer)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from crm.tasks t
  where t.workspace_id = p_workspace and t.archived_at is null and t.completed_at is null
    and t.clickup_task_id is not null
    and exists (
      select 1 from crm.workspace_members m
      where m.workspace_id = t.workspace_id and m.user_id in (t.owner_id, t.created_by_user_id)
    )
    and (t.clickup_synced_at is null or t.clickup_synced_at < now() - make_interval(secs => p_seconds))
  order by t.clickup_synced_at asc nulls first
  limit p_limit;
$$;

revoke all on function private.clickup_stale_tasks(uuid, double precision, integer) from public;
grant execute on function private.clickup_stale_tasks(uuid, double precision, integer) to crm_app;

create or replace function private.approval_waits_on_other(p_run uuid, p_user uuid, p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.workflow_runs r
    where r.id = p_run
      and r.workspace_id = p_workspace
      and r.owner_id <> p_user
      and r.status = 'waiting'
      and r.waiting_for = 'approval'
      and exists (
        select 1 from crm.workspace_members m
        where m.workspace_id = p_workspace and m.user_id = p_user and m.role in ('owner', 'admin')
      )
  );
$$;

revoke all on function private.approval_waits_on_other(uuid, uuid, uuid) from public;
grant execute on function private.approval_waits_on_other(uuid, uuid, uuid) to crm_app;

create or replace function private.chat_subject_open_to(p_conversation uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from crm.chat_conversations c
    join crm.tasks t on t.id = c.task_id
    join crm.workspace_members wm on wm.workspace_id = t.workspace_id and wm.user_id = p_user
    where c.id = p_conversation and c.kind = 'task'
      and (
        t.owner_id = p_user
        or t.created_by_user_id = p_user
        or exists (select 1 from crm.task_participants tp where tp.task_id = t.id and tp.user_id = p_user)
      )
  ) or exists (
    select 1
    from crm.chat_conversations c
    join crm.pages p on p.id = c.page_id
    join crm.workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = p_user
    where c.id = p_conversation and c.kind = 'doc' and p.effective_shared and p.kind = 'note'
  ) or exists (
    select 1
    from crm.chat_conversations c
    where c.id = p_conversation and c.kind = 'mail_thread' and private.mail_share_open_to(c.mail_share_id, p_user)
  )
$$;

create or replace function private.chat_follow(p_root uuid, p_users uuid[], p_read_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation crm.chat_conversations;
begin
  select c.* into v_conversation
    from crm.chat_messages m join crm.chat_conversations c on c.id = m.conversation_id
    where m.id = p_root;
  if v_conversation.id is null then
    return;
  end if;
  insert into crm.chat_thread_reads (message_id, user_id, last_read_at)
    select p_root, u.id, p_read_at
    from (select distinct x as id from unnest(p_users) as x where x is not null) u
    where case v_conversation.kind
      when 'task' then exists (
        select 1 from crm.tasks t
        join crm.workspace_members wm on wm.workspace_id = t.workspace_id and wm.user_id = u.id
        where t.id = v_conversation.task_id
          and (
            t.owner_id = u.id
            or t.created_by_user_id = u.id
            or exists (select 1 from crm.task_participants tp where tp.task_id = t.id and tp.user_id = u.id)
          )
      )
      when 'doc' then exists (
        select 1 from crm.pages p
        join crm.workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = u.id
        where p.id = v_conversation.page_id and p.effective_shared and p.kind = 'note'
      )
      when 'mail_thread' then private.mail_share_open_to(v_conversation.mail_share_id, u.id)
      else exists (select 1 from crm.chat_members cm where cm.conversation_id = v_conversation.id and cm.user_id = u.id)
    end
  on conflict (message_id, user_id) do nothing;
end;
$$;

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

create index concurrently if not exists webhook_deliveries_workspace_created_idx on crm.webhook_deliveries (workspace_id, created_at desc);
create index concurrently if not exists tasks_created_by_user_idx on crm.tasks (created_by_user_id) where created_by_user_id is not null;
create index concurrently if not exists tasks_created_by_agent_idx on crm.tasks (created_by_agent_id) where created_by_agent_id is not null;
