create table if not exists crm.workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  owner_id uuid not null references crm.profiles (id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'draft',
  trigger_type text not null default 'manual',
  definition jsonb not null default '{}'::jsonb,
  is_template boolean not null default false,
  template_of uuid references crm.workflows (id) on delete set null,
  next_run_at timestamptz,
  last_run_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflows_name_length check (char_length(name) between 1 and 120),
  constraint workflows_description_length check (description is null or char_length(description) <= 2000),
  constraint workflows_status check (status in ('draft', 'active', 'paused')),
  constraint workflows_trigger_length check (char_length(trigger_type) between 1 and 60)
);

create index if not exists workflows_trigger_idx
  on crm.workflows (workspace_id, trigger_type)
  where status = 'active' and archived_at is null;
create index if not exists workflows_schedule_idx
  on crm.workflows (next_run_at)
  where status = 'active' and archived_at is null and trigger_type = 'schedule';
create index if not exists workflows_owner_idx on crm.workflows (workspace_id, owner_id);

drop trigger if exists workflows_set_updated_at on crm.workflows;
create trigger workflows_set_updated_at
  before update on crm.workflows
  for each row execute function private.set_updated_at();

create table if not exists crm.workflow_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  trigger_types text[] not null,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  data jsonb not null default '{}'::jsonb,
  actor_user_id uuid,
  source_workflow_id uuid,
  depth integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists workflow_events_created_idx on crm.workflow_events (created_at);

create table if not exists crm.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  workflow_id uuid not null references crm.workflows (id) on delete cascade,
  owner_id uuid not null references crm.profiles (id) on delete cascade,
  status text not null default 'queued',
  test boolean not null default false,
  definition jsonb not null,
  event jsonb not null default '{}'::jsonb,
  state jsonb not null default '{}'::jsonb,
  waiting_for text,
  resume_at timestamptz,
  company_id uuid references crm.companies (id) on delete set null,
  contact_id uuid references crm.contacts (id) on delete set null,
  depth integer not null default 0,
  error text,
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_runs_status check (status in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  constraint workflow_runs_waiting check (waiting_for is null or waiting_for in ('delay', 'approval')),
  constraint workflow_runs_error_length check (error is null or char_length(error) <= 2000)
);

create index if not exists workflow_runs_due_idx on crm.workflow_runs (status, resume_at);
create index if not exists workflow_runs_workflow_idx on crm.workflow_runs (workflow_id, created_at desc);
create index if not exists workflow_runs_owner_idx on crm.workflow_runs (owner_id, status);
create index if not exists workflow_runs_company_idx on crm.workflow_runs (company_id) where company_id is not null;

drop trigger if exists workflow_runs_set_updated_at on crm.workflow_runs;
create trigger workflow_runs_set_updated_at
  before update on crm.workflow_runs
  for each row execute function private.set_updated_at();

create table if not exists crm.workflow_run_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  run_id uuid not null references crm.workflow_runs (id) on delete cascade,
  owner_id uuid not null references crm.profiles (id) on delete cascade,
  step_id text not null,
  step_type text not null,
  label text,
  status text not null,
  input jsonb,
  output jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint workflow_run_steps_status check (status in ('succeeded', 'failed', 'skipped', 'waiting')),
  constraint workflow_run_steps_error_length check (error is null or char_length(error) <= 2000)
);

create index if not exists workflow_run_steps_run_idx on crm.workflow_run_steps (run_id, started_at);

create table if not exists crm.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  title text not null,
  body text,
  href text,
  source text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_title_length check (char_length(title) between 1 and 200),
  constraint notifications_body_length check (body is null or char_length(body) <= 4000),
  constraint notifications_href_length check (href is null or char_length(href) <= 500)
);

create index if not exists notifications_user_idx on crm.notifications (user_id, created_at desc);

alter table crm.workflows enable row level security;
alter table crm.workflows force row level security;
alter table crm.workflow_events enable row level security;
alter table crm.workflow_events force row level security;
alter table crm.workflow_runs enable row level security;
alter table crm.workflow_runs force row level security;
alter table crm.workflow_run_steps enable row level security;
alter table crm.workflow_run_steps force row level security;
alter table crm.notifications enable row level security;
alter table crm.notifications force row level security;

drop policy if exists workflows_select on crm.workflows;
create policy workflows_select on crm.workflows
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (owner_id = (select private.session_user_id()) or is_template or private.is_workspace_admin(workspace_id))
  );

drop policy if exists workflows_insert on crm.workflows;
create policy workflows_insert on crm.workflows
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()) and owner_id = (select private.session_user_id()));

drop policy if exists workflows_update on crm.workflows;
create policy workflows_update on crm.workflows
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and owner_id = (select private.session_user_id()))
  with check (workspace_id in (select private.user_workspace_ids()) and owner_id = (select private.session_user_id()));

drop policy if exists workflow_events_insert on crm.workflow_events;
create policy workflow_events_insert on crm.workflow_events
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists workflow_events_insert_agent on crm.workflow_events;
create policy workflow_events_insert_agent on crm.workflow_events
  for insert to crm_agent
  with check (workspace_id = (select private.request_workspace_id()));

drop policy if exists workflow_runs_select on crm.workflow_runs;
create policy workflow_runs_select on crm.workflow_runs
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (owner_id = (select private.session_user_id()) or private.is_workspace_admin(workspace_id))
  );

drop policy if exists workflow_runs_insert on crm.workflow_runs;
create policy workflow_runs_insert on crm.workflow_runs
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()) and owner_id = (select private.session_user_id()));

drop policy if exists workflow_runs_update on crm.workflow_runs;
create policy workflow_runs_update on crm.workflow_runs
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and owner_id = (select private.session_user_id()))
  with check (workspace_id in (select private.user_workspace_ids()) and owner_id = (select private.session_user_id()));

drop policy if exists workflow_runs_delete on crm.workflow_runs;
create policy workflow_runs_delete on crm.workflow_runs
  for delete to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and owner_id = (select private.session_user_id()));

drop policy if exists workflow_run_steps_select on crm.workflow_run_steps;
create policy workflow_run_steps_select on crm.workflow_run_steps
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (owner_id = (select private.session_user_id()) or private.is_workspace_admin(workspace_id))
  );

drop policy if exists workflow_run_steps_write on crm.workflow_run_steps;
create policy workflow_run_steps_write on crm.workflow_run_steps
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()) and owner_id = (select private.session_user_id()));

drop policy if exists workflow_run_steps_update on crm.workflow_run_steps;
create policy workflow_run_steps_update on crm.workflow_run_steps
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and owner_id = (select private.session_user_id()))
  with check (workspace_id in (select private.user_workspace_ids()) and owner_id = (select private.session_user_id()));

drop policy if exists notifications_select on crm.notifications;
create policy notifications_select on crm.notifications
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and user_id = (select private.session_user_id()));

drop policy if exists notifications_insert on crm.notifications;
create policy notifications_insert on crm.notifications
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and exists (
      select 1 from crm.workspace_members m
      where m.workspace_id = notifications.workspace_id and m.user_id = notifications.user_id
    )
  );

drop policy if exists notifications_update on crm.notifications;
create policy notifications_update on crm.notifications
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and user_id = (select private.session_user_id()))
  with check (workspace_id in (select private.user_workspace_ids()) and user_id = (select private.session_user_id()));

grant select, insert, update on crm.workflows to authenticated;
grant insert on crm.workflow_events to authenticated, crm_agent;
grant select, insert, update, delete on crm.workflow_runs to authenticated;
grant select, insert, update on crm.workflow_run_steps to authenticated;
grant select, insert, update on crm.notifications to authenticated;
revoke all on crm.workflows, crm.workflow_runs, crm.workflow_run_steps, crm.notifications from anon, crm_agent;
revoke all on crm.workflow_events from anon;

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
        and w.id is distinct from event.source_workflow_id;
      get diagnostics inserted = row_count;
      dispatched := dispatched + inserted;
    end if;
    delete from crm.workflow_events where id = event.id;
  end loop;
  return dispatched;
end;
$$;

create or replace function private.claim_workflow_runs(p_limit integer)
returns table (run_id uuid, workspace_id uuid, owner_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select r.id
    from crm.workflow_runs r
    where (r.status = 'queued'
       or (r.status = 'waiting' and r.waiting_for = 'delay' and r.resume_at <= now())
       or (r.status = 'running' and r.claimed_at < now() - interval '10 minutes'))
      and exists (select 1 from crm.workspace_members m where m.workspace_id = r.workspace_id and m.user_id = r.owner_id)
    order by coalesce(r.resume_at, r.created_at)
    limit greatest(1, least(p_limit, 50))
    for update skip locked
  )
  update crm.workflow_runs r
    set status = 'running', claimed_at = now(), started_at = coalesce(r.started_at, now()), waiting_for = null, resume_at = null
  from due
  where r.id = due.id
  returning r.id, r.workspace_id, r.owner_id;
end;
$$;

create or replace function private.claim_due_schedules(p_limit integer)
returns table (workflow_id uuid, workspace_id uuid, owner_id uuid, definition jsonb, next_run_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select w.id, w.next_run_at as was
    from crm.workflows w
    join crm.workspace_members m on m.workspace_id = w.workspace_id and m.user_id = w.owner_id
    where w.status = 'active' and w.archived_at is null and w.trigger_type = 'schedule'
      and w.next_run_at is not null and w.next_run_at <= now()
    order by w.next_run_at
    limit greatest(1, least(p_limit, 50))
    for update of w skip locked
  )
  update crm.workflows w
    set next_run_at = now() + interval '15 minutes'
  from due
  where w.id = due.id
  returning w.id, w.workspace_id, w.owner_id, w.definition, due.was;
end;
$$;

revoke all on function private.dispatch_workflow_events(integer) from public;
revoke all on function private.claim_workflow_runs(integer) from public;
revoke all on function private.claim_due_schedules(integer) from public;
grant execute on function private.dispatch_workflow_events(integer) to crm_app;
grant execute on function private.claim_workflow_runs(integer) to crm_app;
grant execute on function private.claim_due_schedules(integer) to crm_app;
