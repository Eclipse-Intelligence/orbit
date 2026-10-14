drop policy if exists agents_select_member on crm.agents;
create policy agents_select_member on crm.agents
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

drop policy if exists agents_select_agent on crm.agents;
create policy agents_select_agent on crm.agents
  for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));

revoke all on crm.agents from anon, authenticated, crm_agent;
grant select (id, workspace_id, name) on crm.agents to authenticated, crm_agent;
