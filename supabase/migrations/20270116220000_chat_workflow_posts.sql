set lock_timeout = '5s';

alter table crm.chat_messages add column if not exists via_workflow_id uuid references crm.workflows (id) on delete set null;
alter table crm.chat_messages add column if not exists via_workflow_name text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_via_workflow_name_check' and conrelid = 'crm.chat_messages'::regclass) then
    alter table crm.chat_messages add constraint chat_messages_via_workflow_name_check check (via_workflow_name is null or length(via_workflow_name) <= 120);
  end if;
end;
$$;

create index if not exists chat_messages_via_workflow_idx on crm.chat_messages (via_workflow_id) where via_workflow_id is not null;

grant insert (via_workflow_id) on crm.chat_messages to authenticated;

create or replace function private.chat_message_via_workflow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if new.via_workflow_id is null then
    new.via_workflow_name := null;
    return new;
  end if;
  select w.name into v_name from crm.workflows w where w.id = new.via_workflow_id and w.owner_id = new.author_user_id;
  if v_name is null then
    raise exception 'Only the workflow''s owner can post from it.' using errcode = '42501';
  end if;
  new.via_workflow_name := v_name;
  return new;
end;
$$;

revoke all on function private.chat_message_via_workflow() from public;

drop trigger if exists chat_messages_via_workflow on crm.chat_messages;
create trigger chat_messages_via_workflow
  before insert on crm.chat_messages
  for each row execute function private.chat_message_via_workflow();

reset lock_timeout;
