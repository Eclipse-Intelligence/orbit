set lock_timeout = '5s';

alter table crm.chat_members add column if not exists notify text not null default 'default';
alter table crm.chat_members add column if not exists mute_mentions boolean not null default false;
alter table crm.chat_members add column if not exists starred boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_members_notify_check' and conrelid = 'crm.chat_members'::regclass) then
    alter table crm.chat_members add constraint chat_members_notify_check check (notify in ('default', 'all', 'mentions', 'mute')) not valid;
  end if;
end;
$$;

alter table crm.chat_members validate constraint chat_members_notify_check;

grant update (notify, mute_mentions, starred) on crm.chat_members to authenticated;

create or replace function private.chat_hook_listeners(p_message uuid)
returns table (user_id uuid, last_read_at timestamptz, room_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select cm.user_id, cm.last_read_at, c.name
  from crm.chat_messages m
  join crm.chat_conversations c on c.id = m.conversation_id and c.kind = 'room'
  join crm.chat_members cm on cm.conversation_id = c.id
  where m.id = p_message and m.hook is not null and m.parent_id is null and m.deleted_at is null and cm.notify = 'all'
$$;

revoke all on function private.chat_hook_listeners(uuid) from public;
grant execute on function private.chat_hook_listeners(uuid) to crm_app;

reset lock_timeout;
