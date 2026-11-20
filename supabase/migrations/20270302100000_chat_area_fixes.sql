set lock_timeout = '5s';

create or replace function private.chat_update_room(
  p_user uuid,
  p_room uuid,
  p_name text,
  p_set_workspace boolean,
  p_workspace uuid,
  p_set_topic boolean default false,
  p_topic text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room crm.chat_conversations;
  v_name text;
  v_workspace uuid;
  v_topic text;
  v_outside text;
  v_line uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('chat:' || p_room::text, 0));
  v_room := private.chat_room_for_member(p_user, p_room);
  v_name := case when p_name is null then v_room.name else private.chat_room_name(p_name) end;
  v_workspace := case when p_set_workspace then p_workspace else v_room.workspace_id end;
  v_topic := case when p_set_topic then private.chat_room_topic(p_topic) else v_room.topic end;
  if p_set_workspace and p_workspace is not null and p_workspace is distinct from v_room.workspace_id then
    perform 1 from crm.workspace_members m
      where m.workspace_id = p_workspace
        and (m.user_id = p_user or m.user_id in (select cm.user_id from crm.chat_members cm where cm.conversation_id = p_room))
      order by m.user_id
      for share;
    if not exists (select 1 from crm.workspace_members m where m.user_id = p_user and m.workspace_id = p_workspace) then
      raise exception 'Pick one of your workspaces.' using errcode = '42501';
    end if;
    select coalesce(nullif(btrim(p.full_name), ''), p.email, 'Someone') into v_outside
      from crm.chat_members cm
      left join crm.profiles p on p.id = cm.user_id
      where cm.conversation_id = p_room
        and not exists (select 1 from crm.workspace_members m where m.workspace_id = p_workspace and m.user_id = cm.user_id)
      limit 1;
    if found then
      raise exception '% isn''t in that workspace. Remove them first, or keep the room unlinked.', v_outside using errcode = '22023';
    end if;
  end if;
  update crm.chat_conversations set name = v_name, workspace_id = v_workspace, topic = v_topic where id = p_room;
  if v_topic is distinct from v_room.topic then
    v_line := private.chat_post_event(p_user, p_room, case when v_topic is null then 'cleared the topic' else 'set the topic: ' || v_topic end);
  end if;
  return v_line;
end;
$$;

revoke all on function private.chat_update_room(uuid, uuid, text, boolean, uuid, boolean, text) from public;
grant execute on function private.chat_update_room(uuid, uuid, text, boolean, uuid, boolean, text) to crm_app;

create or replace function private.chat_set_archived(p_user uuid, p_room uuid, p_archived boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room crm.chat_conversations;
  v_line uuid;
begin
  if p_archived is null then
    raise exception 'Choose archive or unarchive.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('chat:' || p_room::text, 0));
  v_room := private.chat_room_for_member(p_user, p_room, true);
  if v_room.created_by is distinct from p_user and not exists (
    select 1 from crm.workspace_members wm
    where wm.user_id = p_user and wm.role = 'owner'
      and v_room.workspace_id is not null and wm.workspace_id = v_room.workspace_id
  ) then
    raise exception 'Only the room''s creator or a workspace owner can %.', case when p_archived then 'archive it' else 'unarchive it' end using errcode = '42501';
  end if;
  if p_archived = (v_room.archived_at is not null) then
    return null;
  end if;
  if p_archived then
    v_line := private.chat_post_event(p_user, p_room, 'archived this room');
    update crm.chat_conversations set archived_at = now() where id = p_room;
  else
    update crm.chat_conversations set archived_at = null where id = p_room;
    v_line := private.chat_post_event(p_user, p_room, 'unarchived this room');
  end if;
  return v_line;
end;
$$;

revoke all on function private.chat_set_archived(uuid, uuid, boolean) from public;
grant execute on function private.chat_set_archived(uuid, uuid, boolean) to crm_app;

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
  perform pg_advisory_xact_lock(hashtextextended('chat:' || v_conversation_id::text, 0));
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

create or replace function private.chat_search(p_user uuid, p_conversation uuid, p_pattern text, p_limit integer)
returns table (id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from crm.chat_members m where m.conversation_id = p_conversation and m.user_id = p_user) then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  return query
    select x.id from crm.chat_messages x
    where x.conversation_id = p_conversation and x.kind = 'message' and x.deleted_at is null and x.body ilike p_pattern
    order by x.created_at desc, x.id desc
    limit greatest(1, least(coalesce(p_limit, 30), 50));
end;
$$;

revoke all on function private.chat_search(uuid, uuid, text, integer) from public;
grant execute on function private.chat_search(uuid, uuid, text, integer) to crm_app;

create or replace function private.chat_remove_attachments(p_user uuid, p_message uuid, p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message crm.chat_messages;
  v_keep uuid[];
begin
  select m.* into v_message from crm.chat_messages m where m.id = p_message for update;
  if v_message.id is null or v_message.author_user_id is distinct from p_user or v_message.deleted_at is not null
    or not private.chat_attachment_open_to(v_message.conversation_id, p_user) then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from crm.chat_conversations c where c.id = v_message.conversation_id and c.archived_at is not null) then
    raise exception 'This room is archived.' using errcode = '22023';
  end if;
  select coalesce(array_agg(t.x order by t.ord), '{}') into v_keep
    from unnest(v_message.attachment_ids) with ordinality as t(x, ord)
    where not (t.x = any(coalesce(p_ids, '{}')));
  if cardinality(v_keep) = cardinality(v_message.attachment_ids) then
    return v_message.attachment_count;
  end if;
  if cardinality(v_keep) = 0 and length(btrim(v_message.body, E' \t\n')) = 0 and v_message.quoted_message_id is null then
    raise exception 'Delete the message instead.' using errcode = '22023';
  end if;
  delete from crm.chat_attachments a where a.message_id = p_message and not (a.id = any(v_keep));
  update crm.chat_messages m
    set attachment_ids = v_keep,
        attachment_count = cardinality(v_keep),
        edited_at = clock_timestamp()
    where m.id = p_message;
  return cardinality(v_keep);
end;
$$;

revoke all on function private.chat_remove_attachments(uuid, uuid, uuid[]) from public;
grant execute on function private.chat_remove_attachments(uuid, uuid, uuid[]) to crm_app;

reset lock_timeout;
