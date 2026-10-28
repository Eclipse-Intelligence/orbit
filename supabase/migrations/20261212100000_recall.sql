create table if not exists crm.recall_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  key_cipher text not null,
  key_hint text,
  connected_at timestamptz not null default now(),
  tags_path text,
  tags_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recall_keys_owner unique (workspace_id, user_id),
  constraint recall_keys_hint_length check (key_hint is null or char_length(key_hint) <= 12),
  constraint recall_keys_tags_path_length check (tags_path is null or char_length(tags_path) <= 100)
);

drop trigger if exists recall_keys_set_updated_at on crm.recall_keys;
create trigger recall_keys_set_updated_at
  before update on crm.recall_keys
  for each row execute function private.set_updated_at();

alter table crm.recall_keys enable row level security;
alter table crm.recall_keys force row level security;

drop policy if exists recall_keys_owner on crm.recall_keys;
create policy recall_keys_owner on crm.recall_keys
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.recall_keys from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.recall_keys to authenticated;

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
  delete from crm.recall_keys where workspace_id = p_workspace and user_id = p_user;
  update crm.ai_companions set revoked_at = now()
    where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  delete from crm.workspace_members where workspace_id = p_workspace and user_id = p_user;
end;
$$;

revoke all on function private.team_remove(uuid, uuid, uuid) from public;
grant execute on function private.team_remove(uuid, uuid, uuid) to crm_app;
