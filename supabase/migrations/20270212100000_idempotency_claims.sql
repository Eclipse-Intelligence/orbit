set lock_timeout = '5s';

grant update (status_code, response, created_at) on crm.idempotency_keys to authenticated, crm_agent;

drop policy if exists idempotency_update_member on crm.idempotency_keys;
create policy idempotency_update_member on crm.idempotency_keys
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and actor_key = 'user:' || (select private.session_user_id())::text
  )
  with check (
    workspace_id in (select private.user_workspace_ids())
    and actor_key = 'user:' || (select private.session_user_id())::text
  );

drop policy if exists idempotency_update_agent on crm.idempotency_keys;
create policy idempotency_update_agent on crm.idempotency_keys
  for update to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and actor_key = 'agent:' || (select current_setting('app.agent_id', true))
  )
  with check (
    workspace_id = (select private.request_workspace_id())
    and actor_key = 'agent:' || (select current_setting('app.agent_id', true))
  );
