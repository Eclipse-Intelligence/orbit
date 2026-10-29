create table if not exists crm.proof_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  created_by uuid references crm.profiles (id) on delete set null,
  client text not null,
  description text not null default '',
  product text not null default 'eclipse',
  used_for text not null default '',
  result text not null,
  measured text not null default '',
  permission text not null,
  approved_by text not null default '',
  review_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint proof_entries_client_length check (char_length(client) between 1 and 120),
  constraint proof_entries_description_length check (char_length(description) <= 300),
  constraint proof_entries_product check (product in ('eclipse', 'cntent')),
  constraint proof_entries_used_for_length check (char_length(used_for) <= 300),
  constraint proof_entries_result_length check (char_length(result) between 1 and 500),
  constraint proof_entries_measured_length check (char_length(measured) <= 300),
  constraint proof_entries_permission check (permission in ('named', 'described', 'reference')),
  constraint proof_entries_approved_by_length check (char_length(approved_by) <= 120)
);

create index if not exists proof_entries_workspace_idx
  on crm.proof_entries (workspace_id, updated_at desc)
  where archived_at is null;
create index if not exists proof_entries_created_by_idx on crm.proof_entries (created_by);

drop trigger if exists proof_entries_set_updated_at on crm.proof_entries;
create trigger proof_entries_set_updated_at
  before update on crm.proof_entries
  for each row execute function private.set_updated_at();

alter table crm.proof_entries enable row level security;
alter table crm.proof_entries force row level security;

drop policy if exists proof_entries_select_member on crm.proof_entries;
create policy proof_entries_select_member on crm.proof_entries
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

drop policy if exists proof_entries_insert_member on crm.proof_entries;
create policy proof_entries_insert_member on crm.proof_entries
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (created_by is null or created_by = (select private.session_user_id()))
  );

drop policy if exists proof_entries_update_member on crm.proof_entries;
create policy proof_entries_update_member on crm.proof_entries
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

revoke all on crm.proof_entries from anon, authenticated, crm_agent;
grant select, insert on crm.proof_entries to authenticated;
grant update (client, description, product, used_for, result, measured, permission, approved_by, review_on, archived_at) on crm.proof_entries to authenticated;
