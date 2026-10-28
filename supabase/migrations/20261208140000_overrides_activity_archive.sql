alter table crm.companies add column if not exists relationship_override text;
alter table crm.companies add column if not exists relationship_override_reason text;
alter table crm.companies add column if not exists relationship_override_at timestamptz;
alter table crm.companies add column if not exists relationship_override_by uuid references crm.profiles (id) on delete set null;

alter table crm.companies drop constraint if exists companies_relationship_override;
alter table crm.companies add constraint companies_relationship_override
  check (relationship_override is null or relationship_override in ('strong', 'warm', 'cooling', 'one_sided', 'cold', 'new'));
alter table crm.companies drop constraint if exists companies_relationship_override_reason;
alter table crm.companies add constraint companies_relationship_override_reason
  check (relationship_override_reason is null or char_length(relationship_override_reason) <= 500);

alter table crm.contacts add column if not exists relationship_override text;
alter table crm.contacts add column if not exists relationship_override_reason text;
alter table crm.contacts add column if not exists relationship_override_at timestamptz;
alter table crm.contacts add column if not exists relationship_override_by uuid references crm.profiles (id) on delete set null;

alter table crm.contacts drop constraint if exists contacts_relationship_override;
alter table crm.contacts add constraint contacts_relationship_override
  check (relationship_override is null or relationship_override in ('strong', 'warm', 'cooling', 'one_sided', 'cold', 'new'));
alter table crm.contacts drop constraint if exists contacts_relationship_override_reason;
alter table crm.contacts add constraint contacts_relationship_override_reason
  check (relationship_override_reason is null or char_length(relationship_override_reason) <= 500);

alter table crm.activities add column if not exists archived_at timestamptz;

grant update (archived_at) on crm.activities to authenticated, crm_agent;

drop policy if exists activities_archive_member on crm.activities;
create policy activities_archive_member on crm.activities
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
create policy activities_archive_agent on crm.activities
  for update to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and actor_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
  )
  with check (workspace_id = (select private.request_workspace_id()));

create index if not exists audit_events_actor_idx
  on crm.audit_events (workspace_id, actor_user_id, created_at desc)
  where actor_user_id is not null;

create index if not exists audit_events_undoes_idx
  on crm.audit_events ((changes->>'undoes'))
  where event_type like '%.undone';

create or replace function private.claim_unjudged_calls(p_limit integer)
returns table (activity_id uuid, workspace_id uuid, user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select i.id, i.activity_id, i.workspace_id,
      coalesce(
        (select m.user_id from crm.workspace_members m where m.workspace_id = i.workspace_id and m.user_id = a.actor_user_id),
        (select m.user_id from crm.workspace_members m where m.workspace_id = i.workspace_id and m.role = 'owner' order by m.created_at limit 1)
      ) as user_id
    from crm.call_insights i
    join crm.activities a on a.id = i.activity_id
    where i.status = 'ready'
      and i.sentiment is null
      and i.sentiment_checked_at is null
      and a.archived_at is null
    order by a.occurred_at desc
    limit greatest(1, least(p_limit, 20))
    for update of i skip locked
  )
  update crm.call_insights i
    set sentiment_checked_at = now()
  from due
  where i.id = due.id and due.user_id is not null
  returning due.activity_id, due.workspace_id, due.user_id;
end;
$$;

revoke all on function private.claim_unjudged_calls(integer) from public;
grant execute on function private.claim_unjudged_calls(integer) to crm_app;
