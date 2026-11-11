set lock_timeout = '5s';

alter table crm.conversation_imports add column if not exists dismissed_at timestamptz;

update crm.conversation_imports
set dismissed_at = updated_at
where status = 'ignored' and dismissed_at is null;

create or replace function private.stamp_dismissed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'ignored' and (tg_op = 'INSERT' or old.status is distinct from 'ignored') then
    new.dismissed_at = now();
  elsif new.status <> 'ignored' then
    new.dismissed_at = null;
  end if;
  return new;
end;
$$;

revoke all on function private.stamp_dismissed_at() from public;

drop trigger if exists conversation_imports_stamp_dismissed on crm.conversation_imports;
create trigger conversation_imports_stamp_dismissed
  before insert or update of status on crm.conversation_imports
  for each row execute function private.stamp_dismissed_at();

create or replace function private.move_conversation_import(p_user uuid, p_import uuid, p_workspace uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import crm.conversation_imports;
  v_existing crm.conversation_imports;
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
    raise exception 'This conversation is already filed or ignored.' using errcode = '55000';
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

  select * into v_existing from crm.conversation_imports i
  where i.workspace_id = p_workspace and i.source = v_import.source and i.external_id = v_import.external_id
    and (v_import.source = 'granola' or i.user_id = p_user)
  limit 1
  for update;
  if v_existing.id is not null then
    if v_existing.user_id is not distinct from p_user and v_existing.status = 'filed' then
      delete from crm.conversation_imports i where i.id = v_import.id;
      return v_existing.id;
    end if;
    if v_existing.user_id is distinct from p_user and v_existing.status = 'ignored' then
      raise exception 'A colleague dismissed this conversation in that workspace.' using errcode = 'OR409';
    end if;
    if v_existing.user_id is distinct from p_user and v_existing.status in ('filed', 'unfiled') then
      raise exception 'A colleague already has this conversation in that workspace.' using errcode = '23505';
    end if;
    delete from crm.conversation_imports i where i.id = v_existing.id;
  end if;

  update crm.conversation_imports i
  set workspace_id = p_workspace, activity_id = null, contact_id = null, company_id = null,
      unfiled_at = case when i.status = 'unfiled' then now() else i.unfiled_at end
  where i.id = v_import.id;
  return v_import.id;
end;
$$;

revoke all on function private.move_conversation_import(uuid, uuid, uuid) from public;
grant execute on function private.move_conversation_import(uuid, uuid, uuid) to crm_app;

reset lock_timeout;
