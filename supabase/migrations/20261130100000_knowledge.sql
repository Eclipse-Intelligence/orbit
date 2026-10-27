create schema if not exists extensions;
create extension if not exists vector with schema extensions;
grant usage on schema extensions to authenticated, crm_app;

create table if not exists crm.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  scope text not null,
  company_id uuid references crm.companies (id) on delete cascade,
  kind text not null,
  title text not null,
  source_url text,
  source_ref text,
  file_path text,
  mime_type text,
  size_bytes integer,
  status text not null default 'pending',
  error text,
  summary text,
  content text,
  char_count integer not null default 0,
  chunk_count integer not null default 0,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  indexed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_items_scope check (scope in ('company', 'eclipse')),
  constraint knowledge_items_company check ((scope = 'company') = (company_id is not null)),
  constraint knowledge_items_kind check (kind in ('file', 'link', 'youtube', 'podcast', 'transcript', 'attachment')),
  constraint knowledge_items_status check (status in ('pending', 'indexing', 'ready', 'failed')),
  constraint knowledge_items_title check (char_length(title) between 1 and 300),
  constraint knowledge_items_error check (error is null or char_length(error) <= 500),
  constraint knowledge_items_summary check (summary is null or char_length(summary) <= 2000),
  constraint knowledge_items_content check (content is null or char_length(content) <= 600000)
);

create index if not exists knowledge_items_company_idx on crm.knowledge_items (workspace_id, company_id, created_at desc) where archived_at is null;
create index if not exists knowledge_items_scope_idx on crm.knowledge_items (workspace_id, scope, created_at desc) where archived_at is null;
create index if not exists knowledge_items_status_idx on crm.knowledge_items (workspace_id, status) where archived_at is null and status in ('pending', 'indexing');
create unique index if not exists knowledge_items_source_ref_key on crm.knowledge_items (workspace_id, source_ref) where source_ref is not null and archived_at is null;
create index if not exists knowledge_items_created_by_idx on crm.knowledge_items (created_by_user_id);

create table if not exists crm.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  item_id uuid not null references crm.knowledge_items (id) on delete cascade,
  position integer not null,
  content text not null,
  embedding extensions.vector(1536),
  search tsvector generated always as (to_tsvector('english', content)) stored,
  constraint knowledge_chunks_content check (char_length(content) between 1 and 4000)
);

create index if not exists knowledge_chunks_item_idx on crm.knowledge_chunks (item_id, position);
create index if not exists knowledge_chunks_workspace_idx on crm.knowledge_chunks (workspace_id);
create index if not exists knowledge_chunks_search_idx on crm.knowledge_chunks using gin (search);
create index if not exists knowledge_chunks_embedding_idx on crm.knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops);

drop trigger if exists knowledge_items_set_updated_at on crm.knowledge_items;
create trigger knowledge_items_set_updated_at
  before update on crm.knowledge_items
  for each row execute function private.set_updated_at();

alter table crm.knowledge_items enable row level security;
alter table crm.knowledge_items force row level security;
alter table crm.knowledge_chunks enable row level security;
alter table crm.knowledge_chunks force row level security;

drop policy if exists knowledge_items_member on crm.knowledge_items;
create policy knowledge_items_member on crm.knowledge_items
  for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (company_id is null or company_id in (select c.id from crm.companies c where c.workspace_id = knowledge_items.workspace_id))
  );

drop policy if exists knowledge_chunks_member on crm.knowledge_chunks;
create policy knowledge_chunks_member on crm.knowledge_chunks
  for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (
    workspace_id in (select private.user_workspace_ids())
    and item_id in (select i.id from crm.knowledge_items i where i.workspace_id = knowledge_chunks.workspace_id)
  );

revoke all on crm.knowledge_items from anon, authenticated, crm_agent;
revoke all on crm.knowledge_chunks from anon, authenticated, crm_agent;
grant select, insert, update on crm.knowledge_items to authenticated;
grant select, insert, delete on crm.knowledge_chunks to authenticated;
