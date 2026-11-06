drop index if exists crm.conversation_imports_teams_key;
create unique index if not exists conversation_imports_teams_workspace_key
  on crm.conversation_imports (workspace_id, user_id, external_id)
  where source = 'teams';
create index if not exists conversation_imports_user_external_idx
  on crm.conversation_imports (user_id, source, external_id);

grant update (workspace_id) on crm.call_records to authenticated;

create index if not exists call_records_connection_call_idx
  on crm.call_records (connection_id, provider_call_id);

create or replace function private.move_conversation_import(p_user uuid, p_import uuid, p_workspace uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import crm.conversation_imports;
  v_existing uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_import from crm.conversation_imports i
  where i.id = p_import and i.user_id = p_user
  for update;
  if v_import.id is null then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  if v_import.status not in ('pending', 'unfiled') then
    raise exception 'This conversation is already filed.' using errcode = '55000';
  end if;
  if not exists (
    select 1 from crm.workspace_members m where m.user_id = p_user and m.workspace_id = p_workspace
  ) or not exists (
    select 1 from crm.workspace_members m where m.user_id = p_user and m.workspace_id = v_import.workspace_id
  ) then
    raise exception 'Choose a workspace you''re in.' using errcode = '42501';
  end if;
  if v_import.workspace_id = p_workspace then
    return v_import.id;
  end if;

  select i.id into v_existing from crm.conversation_imports i
  where i.workspace_id = p_workspace and i.source = v_import.source and i.external_id = v_import.external_id
    and (v_import.source = 'granola' or i.user_id = p_user)
  limit 1;
  if v_existing is not null then
    delete from crm.conversation_imports i where i.id = v_import.id;
    return v_existing;
  end if;

  update crm.conversation_imports i
  set workspace_id = p_workspace, activity_id = null, contact_id = null, company_id = null
  where i.id = v_import.id;
  return v_import.id;
end;
$$;

revoke all on function private.move_conversation_import(uuid, uuid, uuid) from public;
grant execute on function private.move_conversation_import(uuid, uuid, uuid) to crm_app;

create or replace function private.agent_mailbox_address_taken(p_address text, p_workspace uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return exists (
    select 1 from crm.agent_mailboxes b
    where b.address = lower(btrim(p_address)) and b.workspace_id <> p_workspace
  );
end;
$$;

revoke all on function private.agent_mailbox_address_taken(text, uuid) from public;
grant execute on function private.agent_mailbox_address_taken(text, uuid) to crm_app;
