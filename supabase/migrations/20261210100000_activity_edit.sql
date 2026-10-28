alter table crm.activities enable row level security;
alter table crm.activities force row level security;

revoke update on crm.activities from authenticated, crm_agent;
grant update (archived_at, type, title, body, occurred_at, company_id, contact_id, opportunity_id)
  on crm.activities to authenticated, crm_agent;

drop policy if exists activities_archive_member on crm.activities;
drop policy if exists activities_change_member on crm.activities;
create policy activities_change_member on crm.activities
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      actor_user_id = (select private.session_user_id())
      or private.is_workspace_admin(workspace_id)
    )
  )
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists activities_archive_agent on crm.activities;
drop policy if exists activities_change_agent on crm.activities;
create policy activities_change_agent on crm.activities
  for update to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and actor_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
  )
  with check (workspace_id = (select private.request_workspace_id()));

grant update (contact_id, company_id) on crm.call_insights to authenticated, crm_agent;
