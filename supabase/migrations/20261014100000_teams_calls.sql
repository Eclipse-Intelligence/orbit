create or replace function private.session_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid()
$$;

revoke all on function private.session_user_id() from public;
grant execute on function private.session_user_id() to authenticated;

create table if not exists crm.call_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  connection_id uuid not null references crm.mailbox_connections (id) on delete cascade,
  provider_call_id text not null,
  direction text not null,
  counterpart_number text,
  started_at timestamptz,
  duration_seconds integer,
  contact_id uuid references crm.contacts (id) on delete set null,
  company_id uuid references crm.companies (id) on delete set null,
  activity_id uuid references crm.activities (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint call_records_direction check (direction in ('inbound', 'outbound')),
  constraint call_records_provider_id_length check (char_length(provider_call_id) between 1 and 400),
  constraint call_records_number_length check (counterpart_number is null or char_length(counterpart_number) <= 64),
  constraint call_records_duration check (duration_seconds is null or duration_seconds >= 0),
  constraint call_records_unique unique (workspace_id, provider_call_id)
);

create index if not exists call_records_connection_started_idx
  on crm.call_records (connection_id, started_at desc);

create index if not exists call_records_unmatched_idx
  on crm.call_records (connection_id)
  where contact_id is null and company_id is null and activity_id is null;

create table if not exists crm.call_sync_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  connection_id uuid not null references crm.mailbox_connections (id) on delete cascade,
  tenant_id text,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  constraint call_sync_state_connection unique (connection_id),
  constraint call_sync_state_tenant_length check (tenant_id is null or char_length(tenant_id) <= 255),
  constraint call_sync_state_error_length check (last_error is null or char_length(last_error) <= 500)
);

drop trigger if exists call_sync_state_set_updated_at on crm.call_sync_state;
create trigger call_sync_state_set_updated_at
  before update on crm.call_sync_state
  for each row execute function private.set_updated_at();

alter table crm.call_records enable row level security;
alter table crm.call_records force row level security;
alter table crm.call_sync_state enable row level security;
alter table crm.call_sync_state force row level security;

drop policy if exists call_records_select_owner on crm.call_records;
create policy call_records_select_owner on crm.call_records
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select private.session_user_id())
    )
  );

drop policy if exists call_records_insert_owner on crm.call_records;
create policy call_records_insert_owner on crm.call_records
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select private.session_user_id())
    )
  );

drop policy if exists call_records_update_owner on crm.call_records;
create policy call_records_update_owner on crm.call_records
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select private.session_user_id())
    )
  )
  with check (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select private.session_user_id())
    )
  );

drop policy if exists call_sync_state_select_owner on crm.call_sync_state;
create policy call_sync_state_select_owner on crm.call_sync_state
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select private.session_user_id())
    )
  );

drop policy if exists call_sync_state_insert_owner on crm.call_sync_state;
create policy call_sync_state_insert_owner on crm.call_sync_state
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select private.session_user_id())
    )
  );

drop policy if exists call_sync_state_update_owner on crm.call_sync_state;
create policy call_sync_state_update_owner on crm.call_sync_state
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select private.session_user_id())
    )
  )
  with check (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select private.session_user_id())
    )
  );

grant select, insert on crm.call_records to authenticated;
grant update (contact_id, company_id, activity_id) on crm.call_records to authenticated;
grant select, insert on crm.call_sync_state to authenticated;
grant update (tenant_id, last_synced_at, last_attempt_at, last_error) on crm.call_sync_state to authenticated;
revoke all on crm.call_records, crm.call_sync_state from anon, crm_agent;
