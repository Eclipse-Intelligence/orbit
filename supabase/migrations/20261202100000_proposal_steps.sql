create table if not exists crm.document_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  document_id uuid not null references crm.documents (id) on delete cascade,
  position integer not null default 0,
  title text not null,
  side text not null default 'client',
  due_date date,
  done_at timestamptz,
  done_by text,
  done_name text,
  created_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_steps_title check (char_length(title) between 1 and 300),
  constraint document_steps_side check (side in ('client', 'us')),
  constraint document_steps_done_by check (done_by is null or done_by in ('client', 'user')),
  constraint document_steps_done_name check (done_name is null or char_length(done_name) <= 200)
);

create index if not exists document_steps_document_idx on crm.document_steps (document_id, position);

drop trigger if exists document_steps_set_updated_at on crm.document_steps;
create trigger document_steps_set_updated_at
  before update on crm.document_steps
  for each row execute function private.set_updated_at();

alter table crm.document_steps enable row level security;
alter table crm.document_steps force row level security;

drop policy if exists document_steps_member on crm.document_steps;
create policy document_steps_member on crm.document_steps
  for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (
    workspace_id in (select private.user_workspace_ids())
    and document_id in (select d.id from crm.documents d where d.workspace_id = document_steps.workspace_id)
  );

drop policy if exists document_steps_agent on crm.document_steps;
create policy document_steps_agent on crm.document_steps
  for all to crm_agent
  using (workspace_id = (select private.request_workspace_id()))
  with check (workspace_id = (select private.request_workspace_id()));

revoke all on crm.document_steps from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.document_steps to authenticated, crm_agent;
