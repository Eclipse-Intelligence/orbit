create table if not exists crm.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  email text not null,
  role text not null default 'member',
  token_hash text not null,
  invited_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references crm.profiles (id) on delete set null,
  revoked_at timestamptz,
  constraint workspace_invites_role check (role in ('member', 'admin')),
  constraint workspace_invites_email check (position('@' in email) > 1 and char_length(email) <= 320),
  constraint workspace_invites_token_unique unique (token_hash)
);

create index if not exists workspace_invites_workspace_idx on crm.workspace_invites (workspace_id);

alter table crm.workspace_invites enable row level security;
alter table crm.workspace_invites force row level security;

drop policy if exists workspace_invites_select_member on crm.workspace_invites;
create policy workspace_invites_select_member on crm.workspace_invites
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

grant select on crm.workspace_invites to authenticated;
revoke all on crm.workspace_invites from anon, crm_agent;

create or replace function private.team_role(p_workspace uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from crm.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user;
$$;

create or replace function private.team_invite(
  p_workspace uuid,
  p_actor uuid,
  p_email text,
  p_role text,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := private.team_role(p_workspace, p_actor);
  address text := lower(trim(coalesce(p_email, '')));
  created uuid;
begin
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can invite people.' using errcode = '42501';
  end if;
  if p_role not in ('member', 'admin') then
    raise exception 'Choose member or admin.' using errcode = '22023';
  end if;
  if p_role = 'admin' and actor_role <> 'owner' then
    raise exception 'Only the owner can invite an admin.' using errcode = '42501';
  end if;
  if position('@' in address) < 2 then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  if exists (
    select 1 from crm.workspace_members m join crm.profiles p on p.id = m.user_id
    where m.workspace_id = p_workspace and lower(p.email) = address
  ) then
    raise exception '% is already in this workspace.', address using errcode = '23505';
  end if;
  update crm.workspace_invites
    set revoked_at = now()
    where workspace_id = p_workspace and lower(email) = address and accepted_at is null and revoked_at is null;
  insert into crm.workspace_invites (workspace_id, email, role, token_hash, invited_by)
  values (p_workspace, address, p_role, p_token_hash, p_actor)
  returning id into created;
  return created;
end;
$$;

create or replace function private.team_revoke_invite(p_workspace uuid, p_actor uuid, p_invite uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(private.team_role(p_workspace, p_actor), '') not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can cancel invites.' using errcode = '42501';
  end if;
  update crm.workspace_invites
    set revoked_at = now()
    where id = p_invite and workspace_id = p_workspace and accepted_at is null and revoked_at is null;
end;
$$;

create or replace function private.invite_preview(p_token_hash text)
returns table (
  invite_id uuid,
  workspace_id uuid,
  workspace_name text,
  email text,
  role text,
  invited_by_name text,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    i.id,
    i.workspace_id,
    w.name,
    i.email,
    i.role,
    coalesce(nullif(p.full_name, ''), p.email),
    case
      when i.accepted_at is not null then 'accepted'
      when i.revoked_at is not null then 'revoked'
      when i.expires_at < now() then 'expired'
      else 'pending'
    end
  from crm.workspace_invites i
  join crm.workspaces w on w.id = i.workspace_id
  left join crm.profiles p on p.id = i.invited_by
  where i.token_hash = p_token_hash;
$$;

create or replace function private.accept_invite(p_token_hash text, p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite crm.workspace_invites%rowtype;
  address text;
begin
  select * into invite from crm.workspace_invites where token_hash = p_token_hash for update;
  if not found or invite.revoked_at is not null then
    raise exception 'This invite is no longer valid.' using errcode = '22023';
  end if;
  if invite.accepted_at is not null then
    if invite.accepted_by = p_user then
      return invite.workspace_id;
    end if;
    raise exception 'This invite has already been used.' using errcode = '22023';
  end if;
  if invite.expires_at < now() then
    raise exception 'This invite has expired. Ask for a new one.' using errcode = '22023';
  end if;
  select lower(p.email) into address from crm.profiles p where p.id = p_user;
  if address is null or address <> lower(invite.email) then
    raise exception 'This invite is for %.', invite.email using errcode = '42501';
  end if;
  insert into crm.workspace_members (workspace_id, user_id, role)
  values (invite.workspace_id, p_user, invite.role)
  on conflict (workspace_id, user_id) do nothing;
  update crm.workspace_invites set accepted_at = now(), accepted_by = p_user where id = invite.id;
  return invite.workspace_id;
end;
$$;

create or replace function private.team_set_role(p_workspace uuid, p_actor uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_role text := private.team_role(p_workspace, p_user);
begin
  if coalesce(private.team_role(p_workspace, p_actor), '') <> 'owner' then
    raise exception 'Only the owner can change roles.' using errcode = '42501';
  end if;
  if target_role is null then
    raise exception 'They are not in this workspace.' using errcode = '22023';
  end if;
  if target_role = 'owner' then
    raise exception 'The owner''s role can''t be changed.' using errcode = '42501';
  end if;
  if p_role not in ('member', 'admin') then
    raise exception 'Choose member or admin.' using errcode = '22023';
  end if;
  update crm.workspace_members set role = p_role where workspace_id = p_workspace and user_id = p_user;
end;
$$;

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
  update crm.mailbox_connections
    set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
    where workspace_id = p_workspace and user_id = p_user;
  update crm.calendar_accounts
    set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
    where workspace_id = p_workspace and user_id = p_user;
  delete from crm.ai_accounts where workspace_id = p_workspace and user_id = p_user;
  update crm.ai_companions set revoked_at = now()
    where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  delete from crm.workspace_members where workspace_id = p_workspace and user_id = p_user;
end;
$$;

revoke all on function private.team_role(uuid, uuid) from public;
revoke all on function private.team_invite(uuid, uuid, text, text, text) from public;
revoke all on function private.team_revoke_invite(uuid, uuid, uuid) from public;
revoke all on function private.invite_preview(text) from public;
revoke all on function private.accept_invite(text, uuid) from public;
revoke all on function private.team_set_role(uuid, uuid, uuid, text) from public;
revoke all on function private.team_remove(uuid, uuid, uuid) from public;

grant execute on function private.team_invite(uuid, uuid, text, text, text) to crm_app;
grant execute on function private.team_revoke_invite(uuid, uuid, uuid) to crm_app;
grant execute on function private.invite_preview(text) to crm_app;
grant execute on function private.accept_invite(text, uuid) to crm_app;
grant execute on function private.team_set_role(uuid, uuid, uuid, text) to crm_app;
grant execute on function private.team_remove(uuid, uuid, uuid) to crm_app;

create or replace function private.crm_calendar(p_calendar uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c.use_for_crm from crm.calendars c where c.id = p_calendar), false);
$$;

revoke all on function private.crm_calendar(uuid) from public;
grant execute on function private.crm_calendar(uuid) to authenticated;

drop policy if exists calendar_events_select_crm on crm.calendar_events;
create policy calendar_events_select_crm on crm.calendar_events
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (cardinality(contact_ids) > 0 or cardinality(company_ids) > 0)
    and private.crm_calendar(calendar_id)
  );

drop policy if exists conversation_imports_select_member on crm.conversation_imports;
create policy conversation_imports_select_member on crm.conversation_imports
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (source <> 'teams' or status = 'filed' or user_id = (select private.session_user_id()))
  );

create or replace function private.is_workspace_admin(p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.workspace_members m
    where m.workspace_id = p_workspace
      and m.user_id = (select private.session_user_id())
      and m.role in ('owner', 'admin')
  );
$$;

revoke all on function private.is_workspace_admin(uuid) from public;
grant execute on function private.is_workspace_admin(uuid) to authenticated;

drop policy if exists tasks_select_member on crm.tasks;
create policy tasks_select_member on crm.tasks
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      owner_id = (select private.session_user_id())
      or created_by_user_id = (select private.session_user_id())
      or private.is_workspace_admin(workspace_id)
    )
  );

drop policy if exists tasks_update_member on crm.tasks;
create policy tasks_update_member on crm.tasks
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      owner_id = (select private.session_user_id())
      or created_by_user_id = (select private.session_user_id())
      or private.is_workspace_admin(workspace_id)
    )
  )
  with check (workspace_id in (select private.user_workspace_ids()));
