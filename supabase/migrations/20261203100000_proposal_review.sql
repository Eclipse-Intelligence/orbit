drop policy if exists documents_delete_draft on crm.documents;
create policy documents_delete_draft on crm.documents as restrictive for delete to authenticated using (status = 'draft' and current_version_id is null);

update crm.documents d
set owner_id = o.user_id
from crm.workspace_members o
where o.workspace_id = d.workspace_id
  and o.role = 'owner'
  and not exists (select 1 from crm.workspace_members m where m.workspace_id = d.workspace_id and m.user_id = d.owner_id);

create or replace function private.document_link_owner(p_token_hash text)
returns table (
  document_id uuid,
  link_id uuid,
  version_id uuid,
  revoked boolean,
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select d.id, l.id, l.version_id, l.revoked_at is not null, w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.document_links l
  join crm.documents d on d.id = l.document_id
  join crm.workspaces w on w.id = d.workspace_id
  cross join lateral (
    select member.user_id, member.role
    from crm.workspace_members member
    where member.workspace_id = d.workspace_id
      and (member.user_id = d.owner_id or member.role = 'owner')
    order by member.user_id = d.owner_id desc
    limit 1
  ) m
  join crm.profiles p on p.id = m.user_id
  where l.token_hash = p_token_hash;
end;
$$;

revoke all on function private.document_link_owner(text) from public;
grant execute on function private.document_link_owner(text) to crm_app;

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
  update crm.ai_companions set revoked_at = now()
    where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  delete from crm.workspace_members where workspace_id = p_workspace and user_id = p_user;
end;
$$;

revoke all on function private.team_remove(uuid, uuid, uuid) from public;
grant execute on function private.team_remove(uuid, uuid, uuid) to crm_app;
