alter table crm.workflow_events add column if not exists owner_user_id uuid references crm.profiles (id) on delete cascade;

drop policy if exists workflow_events_insert on crm.workflow_events;
create policy workflow_events_insert on crm.workflow_events
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (owner_user_id is null or owner_user_id = (select private.session_user_id()))
  );

drop policy if exists workflow_events_insert_agent on crm.workflow_events;
create policy workflow_events_insert_agent on crm.workflow_events
  for insert to crm_agent
  with check (workspace_id = (select private.request_workspace_id()) and owner_user_id is null);

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
        and (event.owner_user_id is null or w.owner_id = event.owner_user_id);
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

create table if not exists crm.workflow_record_marks (
  workflow_id uuid not null references crm.workflows (id) on delete cascade,
  record_id uuid not null,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  owner_id uuid not null references crm.profiles (id) on delete cascade,
  marked_at timestamptz not null default now(),
  primary key (workflow_id, record_id)
);

create index if not exists workflow_record_marks_owner_idx on crm.workflow_record_marks (owner_id);

alter table crm.workflow_record_marks enable row level security;
alter table crm.workflow_record_marks force row level security;

drop policy if exists workflow_record_marks_owner on crm.workflow_record_marks;
create policy workflow_record_marks_owner on crm.workflow_record_marks
  for all to authenticated
  using (owner_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (owner_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.workflow_record_marks from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.workflow_record_marks to authenticated;
