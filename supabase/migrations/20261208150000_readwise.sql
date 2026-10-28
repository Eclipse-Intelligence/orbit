create table if not exists crm.readwise_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  token_cipher text not null,
  token_hint text,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_after timestamptz,
  full_sync_at timestamptz,
  scan_cursor text,
  scan_since timestamptz,
  scan_started_at timestamptz,
  scan_full boolean not null default false,
  sync_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint readwise_keys_owner unique (workspace_id, user_id),
  constraint readwise_keys_hint_length check (token_hint is null or char_length(token_hint) <= 12),
  constraint readwise_keys_error_length check (last_error is null or char_length(last_error) <= 500),
  constraint readwise_keys_cursor_length check (scan_cursor is null or char_length(scan_cursor) <= 2000)
);

drop trigger if exists readwise_keys_set_updated_at on crm.readwise_keys;
create trigger readwise_keys_set_updated_at
  before update on crm.readwise_keys
  for each row execute function private.set_updated_at();

alter table crm.readwise_keys enable row level security;
alter table crm.readwise_keys force row level security;

drop policy if exists readwise_keys_owner on crm.readwise_keys;
create policy readwise_keys_owner on crm.readwise_keys
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.readwise_keys from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.readwise_keys to authenticated;

create table if not exists crm.readwise_documents (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references crm.readwise_keys (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  document_id text not null,
  knowledge_item_id uuid references crm.knowledge_items (id) on delete set null,
  highlights jsonb not null default '{}'::jsonb,
  content_hash text,
  dirty boolean not null default true,
  backfill_from timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint readwise_documents_owner unique (workspace_id, user_id, document_id),
  constraint readwise_documents_id_length check (char_length(document_id) between 1 and 200)
);

create index if not exists readwise_documents_key_idx on crm.readwise_documents (key_id);
create index if not exists readwise_documents_item_idx on crm.readwise_documents (knowledge_item_id);
create index if not exists readwise_documents_dirty_idx on crm.readwise_documents (workspace_id, user_id) where dirty;

drop trigger if exists readwise_documents_set_updated_at on crm.readwise_documents;
create trigger readwise_documents_set_updated_at
  before update on crm.readwise_documents
  for each row execute function private.set_updated_at();

alter table crm.readwise_documents enable row level security;
alter table crm.readwise_documents force row level security;

drop policy if exists readwise_documents_owner on crm.readwise_documents;
create policy readwise_documents_owner on crm.readwise_documents
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and key_id in (select k.id from crm.readwise_keys k where k.workspace_id = readwise_documents.workspace_id and k.user_id = readwise_documents.user_id)
  );

revoke all on crm.readwise_documents from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.readwise_documents to authenticated;

alter table crm.knowledge_items drop constraint if exists knowledge_items_kind;
alter table crm.knowledge_items add constraint knowledge_items_kind
  check (kind in ('file', 'link', 'youtube', 'podcast', 'transcript', 'attachment', 'reader'));

create or replace function private.readwise_key_members()
returns table (workspace_id uuid, user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select k.workspace_id, k.user_id
  from crm.readwise_keys k
  join crm.workspace_members m on m.workspace_id = k.workspace_id and m.user_id = k.user_id;
$$;

revoke all on function private.readwise_key_members() from public;
grant execute on function private.readwise_key_members() to crm_app;

create or replace function private.team_remove(p_workspace uuid, p_actor uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := private.team_role(p_workspace, p_actor);
  target_role text := private.team_role(p_workspace, p_user);
begin
  if coalesce(actor_role, '') not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can remove people.' using errcode = '42501';
  end if;
  if target_role is null then
    raise exception 'They are not in this workspace.' using errcode = '22023';
  end if;
  if target_role = 'owner' then
    raise exception 'The owner can''t be removed.' using errcode = '42501';
  end if;
  if p_user = p_actor then
    raise exception 'You can''t remove yourself.' using errcode = '42501';
  end if;
  if target_role = 'admin' and actor_role <> 'owner' then
    raise exception 'Only the owner can remove an admin.' using errcode = '42501';
  end if;
  update crm.companies set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.contacts set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.opportunities set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.tasks set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.documents set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.mailbox_connections
    set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
    where workspace_id = p_workspace and user_id = p_user;
  update crm.calendar_accounts
    set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
    where workspace_id = p_workspace and user_id = p_user;
  delete from crm.ai_accounts where workspace_id = p_workspace and user_id = p_user;
  delete from crm.granola_keys where workspace_id = p_workspace and user_id = p_user;
  delete from crm.readwise_keys where workspace_id = p_workspace and user_id = p_user;
  update crm.ai_companions set revoked_at = now()
    where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  delete from crm.workspace_members where workspace_id = p_workspace and user_id = p_user;
end;
$$;

revoke all on function private.team_remove(uuid, uuid, uuid) from public;
grant execute on function private.team_remove(uuid, uuid, uuid) to crm_app;
