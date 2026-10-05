create table crm.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  url text not null,
  secret text not null,
  description text,
  events text[] not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint webhook_endpoints_url_length check (char_length(url) between 8 and 500),
  constraint webhook_endpoints_events_present check (cardinality(events) > 0)
);

create table crm.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  endpoint_id uuid not null references crm.webhook_endpoints (id) on delete cascade,
  event_id uuid not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status_code integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  constraint webhook_deliveries_status check (status in ('pending', 'delivered', 'failed')),
  constraint webhook_deliveries_attempts check (attempts >= 0)
);

create index webhook_endpoints_workspace_idx
  on crm.webhook_endpoints (workspace_id)
  where archived_at is null;

create index webhook_deliveries_due_idx
  on crm.webhook_deliveries (next_attempt_at)
  where status = 'pending';

create trigger webhook_endpoints_set_updated_at
  before update on crm.webhook_endpoints
  for each row execute function private.set_updated_at();

alter table crm.webhook_endpoints enable row level security;
alter table crm.webhook_endpoints force row level security;
alter table crm.webhook_deliveries enable row level security;
alter table crm.webhook_deliveries force row level security;

create policy webhook_endpoints_select_member on crm.webhook_endpoints
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));
create policy webhook_endpoints_insert_member on crm.webhook_endpoints
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()));
create policy webhook_endpoints_update_member on crm.webhook_endpoints
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

create policy webhook_endpoints_select_agent on crm.webhook_endpoints
  for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));
create policy webhook_endpoints_insert_agent on crm.webhook_endpoints
  for insert to crm_agent
  with check (workspace_id = (select private.request_workspace_id()));
create policy webhook_endpoints_update_agent on crm.webhook_endpoints
  for update to crm_agent
  using (workspace_id = (select private.request_workspace_id()))
  with check (workspace_id = (select private.request_workspace_id()));

create policy webhook_deliveries_select_member on crm.webhook_deliveries
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));
create policy webhook_deliveries_insert_member on crm.webhook_deliveries
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()));

create policy webhook_deliveries_select_agent on crm.webhook_deliveries
  for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));
create policy webhook_deliveries_insert_agent on crm.webhook_deliveries
  for insert to crm_agent
  with check (workspace_id = (select private.request_workspace_id()));

grant select, insert, update on crm.webhook_endpoints to authenticated, crm_agent;
grant select, insert on crm.webhook_deliveries to authenticated, crm_agent;
revoke all on crm.webhook_endpoints, crm.webhook_deliveries from anon;
