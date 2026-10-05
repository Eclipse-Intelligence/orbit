grant delete on crm.pipeline_stages to authenticated, crm_agent;

create policy pipeline_stages_delete_member on crm.pipeline_stages
  for delete to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

create policy pipeline_stages_delete_agent on crm.pipeline_stages
  for delete to crm_agent
  using (workspace_id = (select private.request_workspace_id()));
