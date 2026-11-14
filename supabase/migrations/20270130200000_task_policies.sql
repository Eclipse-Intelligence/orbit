set lock_timeout = '5s';

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

drop policy if exists tasks_insert_member on crm.tasks;
create policy tasks_insert_member on crm.tasks
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and created_by_user_id = (select private.session_user_id())
    and created_by_agent_id is null
  );

drop policy if exists tasks_insert_agent on crm.tasks;
create policy tasks_insert_agent on crm.tasks
  for insert to crm_agent
  with check (
    workspace_id = (select private.request_workspace_id())
    and created_by_user_id is null
    and created_by_agent_id::text = (select current_setting('app.agent_id', true))
  );

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

drop trigger if exists tasks_keep_workspace on crm.tasks;
create trigger tasks_keep_workspace
  before update of workspace_id on crm.tasks
  for each row
  when (old.workspace_id is distinct from new.workspace_id)
  execute function private.tasks_keep_workspace();

reset lock_timeout;
