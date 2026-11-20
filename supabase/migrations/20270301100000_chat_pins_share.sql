set lock_timeout = '5s';

alter table crm.chat_messages add column if not exists quoted_message_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_quote_check' and conrelid = 'crm.chat_messages'::regclass) then
    alter table crm.chat_messages add constraint chat_messages_quote_check
      check (quoted_message_id is null or (kind = 'message' and parent_id is null)) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'chat_messages_body_present' and conrelid = 'crm.chat_messages'::regclass
      and pg_get_constraintdef(oid) like '%quoted_message_id%'
  ) then
    alter table crm.chat_messages drop constraint if exists chat_messages_body_present;
    alter table crm.chat_messages add constraint chat_messages_body_present
      check (deleted_at is not null or length(btrim(body, E' \t\n')) > 0 or attachment_count > 0 or quoted_message_id is not null) not valid;
  end if;
end;
$$;

alter table crm.chat_messages validate constraint chat_messages_quote_check;
alter table crm.chat_messages validate constraint chat_messages_body_present;

grant insert (quoted_message_id) on crm.chat_messages to authenticated;

create or replace function private.chat_can_quote(p_message uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from crm.chat_messages m
    join crm.chat_conversations c on c.id = m.conversation_id
    where m.id = p_message and m.kind = 'message' and m.deleted_at is null
      and (
        (c.kind in ('room', 'dm', 'group_dm') and exists (select 1 from crm.chat_members cm where cm.conversation_id = c.id and cm.user_id = p_user))
        or (c.kind in ('task', 'doc', 'mail_thread') and private.chat_subject_open_to(c.id, p_user))
      )
  )
$$;

revoke all on function private.chat_can_quote(uuid, uuid) from public;
grant execute on function private.chat_can_quote(uuid, uuid) to authenticated;

drop policy if exists chat_messages_insert_own on crm.chat_messages;
create policy chat_messages_insert_own on crm.chat_messages
  for insert to authenticated
  with check (
    author_user_id = (select private.session_user_id())
    and exists (select 1 from crm.chat_conversations c where c.id = chat_messages.conversation_id and c.archived_at is null)
    and (
      quoted_message_id is null
      or private.chat_can_quote(quoted_message_id, (select private.session_user_id()))
    )
  );

create table if not exists crm.chat_pins (
  message_id uuid primary key references crm.chat_messages (id) on delete cascade,
  conversation_id uuid not null references crm.chat_conversations (id) on delete cascade,
  pinned_by uuid references crm.profiles (id) on delete set null,
  pinned_at timestamptz not null default clock_timestamp()
);

create index if not exists chat_pins_conversation_idx on crm.chat_pins (conversation_id, pinned_at desc, message_id desc);
create index if not exists chat_pins_pinned_by_idx on crm.chat_pins (pinned_by) where pinned_by is not null;

alter table crm.chat_pins enable row level security;
alter table crm.chat_pins force row level security;

drop policy if exists chat_pins_select on crm.chat_pins;
create policy chat_pins_select on crm.chat_pins
  for select to authenticated
  using (exists (select 1 from crm.chat_messages m where m.id = chat_pins.message_id));

revoke all on crm.chat_pins from anon, authenticated, crm_agent;
grant select on crm.chat_pins to authenticated;

create or replace function private.chat_set_pin(p_user uuid, p_message uuid, p_pinned boolean)
returns table (changed boolean, pinned boolean, conversation_id uuid, line_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_conversation crm.chat_conversations;
  v_message crm.chat_messages;
  v_had boolean;
  v_line uuid;
begin
  if p_pinned is null then
    raise exception 'Choose pin or unpin.' using errcode = '22023';
  end if;
  select m.conversation_id into v_conversation_id from crm.chat_messages m where m.id = p_message;
  if not found then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  select c.* into v_conversation from crm.chat_conversations c
    where c.id = v_conversation_id and c.kind in ('room', 'dm', 'group_dm')
      and exists (select 1 from crm.chat_members m where m.conversation_id = c.id and m.user_id = p_user)
    for no key update;
  if not found then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  if v_conversation.archived_at is not null then
    raise exception 'This room is archived.' using errcode = '22023';
  end if;
  select m.* into v_message from crm.chat_messages m where m.id = p_message for share;
  if not found then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  if v_message.kind <> 'message' then
    raise exception 'That can''t be pinned.' using errcode = '22023';
  end if;
  v_had := exists (select 1 from crm.chat_pins p where p.message_id = p_message);
  if p_pinned then
    if v_message.deleted_at is not null then
      raise exception 'That message was deleted.' using errcode = '22023';
    end if;
    if v_had then
      return query select false, true, v_conversation_id, null::uuid;
      return;
    end if;
    if (select count(*) from crm.chat_pins p where p.conversation_id = v_conversation_id) >= 50 then
      raise exception 'A conversation can have up to 50 pinned messages. Unpin one first.' using errcode = '22023';
    end if;
    insert into crm.chat_pins (message_id, conversation_id, pinned_by) values (p_message, v_conversation_id, p_user);
    v_line := private.chat_post_event(p_user, v_conversation_id, 'pinned a message');
    return query select true, true, v_conversation_id, v_line;
    return;
  end if;
  if not v_had then
    return query select false, false, v_conversation_id, null::uuid;
    return;
  end if;
  delete from crm.chat_pins p where p.message_id = p_message;
  v_line := private.chat_post_event(p_user, v_conversation_id, 'unpinned a message');
  return query select true, false, v_conversation_id, v_line;
end;
$$;

revoke all on function private.chat_set_pin(uuid, uuid, boolean) from public;
grant execute on function private.chat_set_pin(uuid, uuid, boolean) to crm_app;

create or replace function private.chat_message_unpin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from crm.chat_pins p where p.message_id = new.id;
  return null;
end;
$$;

revoke all on function private.chat_message_unpin() from public;

drop trigger if exists chat_messages_unpin on crm.chat_messages;
create trigger chat_messages_unpin
  after update of deleted_at on crm.chat_messages
  for each row
  when (new.deleted_at is not null and old.deleted_at is null)
  execute function private.chat_message_unpin();

reset lock_timeout;
