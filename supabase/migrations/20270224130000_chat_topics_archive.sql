set lock_timeout = '5s';

alter table crm.chat_conversations add column if not exists topic text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_conversations_topic_check' and conrelid = 'crm.chat_conversations'::regclass) then
    alter table crm.chat_conversations add constraint chat_conversations_topic_check check (topic is null or (kind = 'room' and length(topic) between 1 and 250)) not valid;
  end if;
end;
$$;

alter table crm.chat_conversations validate constraint chat_conversations_topic_check;

alter table crm.chat_messages add column if not exists kind text not null default 'message';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_kind_check' and conrelid = 'crm.chat_messages'::regclass) then
    alter table crm.chat_messages add constraint chat_messages_kind_check check (
      kind = 'message'
      or (kind = 'event' and parent_id is null and hook is null and via_hook_id is null and via_workflow_id is null and cardinality(mentions) = 0)
    ) not valid;
  end if;
end;
$$;

alter table crm.chat_messages validate constraint chat_messages_kind_check;

create or replace function private.chat_event_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'That message can''t be changed.' using errcode = '22023';
  end if;
  if exists (select 1 from crm.chat_messages p where p.id = new.parent_id and p.kind = 'event') then
    raise exception 'Reply to a message in this conversation.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.chat_event_guard() from public;

drop trigger if exists chat_messages_event_edits on crm.chat_messages;
create trigger chat_messages_event_edits
  before update of body, mentions, deleted_at, format on crm.chat_messages
  for each row
  when (old.kind = 'event')
  execute function private.chat_event_guard();

drop trigger if exists chat_messages_event_replies on crm.chat_messages;
create trigger chat_messages_event_replies
  before insert on crm.chat_messages
  for each row
  when (new.parent_id is not null)
  execute function private.chat_event_guard();

create or replace function private.chat_post_event(p_user uuid, p_conversation uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into crm.chat_messages (conversation_id, author_user_id, client_key, body, kind)
    values (p_conversation, p_user, gen_random_uuid()::text, p_body, 'event')
    returning id into v_id;
  return v_id;
end;
$$;

revoke all on function private.chat_post_event(uuid, uuid, text) from public;

drop function if exists private.chat_room_for_member(uuid, uuid);

create or replace function private.chat_room_for_member(p_user uuid, p_room uuid, p_allow_archived boolean default false)
returns crm.chat_conversations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room crm.chat_conversations;
begin
  select c.* into v_room from crm.chat_conversations c
    where c.id = p_room and c.kind = 'room'
      and exists (select 1 from crm.chat_members m where m.conversation_id = c.id and m.user_id = p_user)
    for update;
  if not found then
    raise exception 'Room not found.' using errcode = 'P0002';
  end if;
  if v_room.archived_at is not null and not coalesce(p_allow_archived, false) then
    raise exception 'This room is archived.' using errcode = '22023';
  end if;
  return v_room;
end;
$$;

revoke all on function private.chat_room_for_member(uuid, uuid, boolean) from public;

create or replace function private.chat_room_topic(p_topic text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_topic text := regexp_replace(
    regexp_replace(
      regexp_replace(coalesce(p_topic, ''), E'[\\u0001-\\u001F\\u007F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]', ' ', 'g'),
      E'[[:space:]]+', ' ', 'g'
    ),
    E'^ | $', '', 'g'
  );
begin
  if v_topic = '' then
    return null;
  end if;
  if length(v_topic) > 250 then
    raise exception 'Keep the topic to 250 characters.' using errcode = '22023';
  end if;
  return v_topic;
end;
$$;

revoke all on function private.chat_room_topic(text) from public;

drop function if exists private.chat_update_room(uuid, uuid, text, boolean, uuid);

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
  v_room crm.chat_conversations := private.chat_room_for_member(p_user, p_room);
  v_name text := case when p_name is null then v_room.name else private.chat_room_name(p_name) end;
  v_workspace uuid := case when p_set_workspace then p_workspace else v_room.workspace_id end;
  v_topic text := case when p_set_topic then private.chat_room_topic(p_topic) else v_room.topic end;
  v_outside text;
  v_line uuid;
begin
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
  v_room crm.chat_conversations := private.chat_room_for_member(p_user, p_room, true);
  v_line uuid;
begin
  if v_room.created_by is distinct from p_user and not exists (
    select 1 from crm.workspace_members wm
    where wm.user_id = p_user and wm.role = 'owner'
      and (v_room.workspace_id is null or wm.workspace_id = v_room.workspace_id)
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

create or replace function private.chat_remove_member(p_user uuid, p_room uuid, p_member uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room crm.chat_conversations := private.chat_room_for_member(p_user, p_room, p_member = p_user);
begin
  delete from crm.chat_members m where m.conversation_id = v_room.id and m.user_id = p_member;
  if not found then
    raise exception 'They aren''t in this room.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from crm.chat_members m where m.conversation_id = v_room.id) then
    delete from crm.chat_conversations c where c.id = v_room.id;
    return true;
  end if;
  return false;
end;
$$;

revoke all on function private.chat_remove_member(uuid, uuid, uuid) from public;
grant execute on function private.chat_remove_member(uuid, uuid, uuid) to crm_app;

create or replace function private.chat_hook_post(
  p_hook uuid,
  p_secret_hash text,
  p_title text,
  p_text text,
  p_url text,
  p_block boolean,
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (
  status text,
  message_id uuid,
  conversation_id uuid,
  author_name text,
  body text,
  hook jsonb,
  created_at timestamptz,
  duplicate boolean,
  member_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_hook crm.chat_hooks;
  v_archived boolean;
  v_id uuid;
  v_key text := nullif(btrim(coalesce(p_key, '')), '');
  v_meta jsonb := jsonb_strip_nulls(jsonb_build_object(
    'title', nullif(btrim(coalesce(p_title, '')), ''),
    'url', nullif(btrim(coalesce(p_url, '')), ''),
    'block', case when p_block then true end
  ));
begin
  select h.* into v_hook
    from crm.chat_hooks h
    join crm.chat_conversations c on c.id = h.conversation_id and c.kind = 'room'
    where h.id = p_hook;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::text, null::text, null::jsonb, null::timestamptz, false, null::uuid[];
    return;
  end if;
  if p_secret_hash is null or v_hook.secret_hash <> p_secret_hash then
    return query select 'unauthorised'::text, null::uuid, null::uuid, null::text, null::text, null::jsonb, null::timestamptz, false, null::uuid[];
    return;
  end if;
  select c.archived_at is not null into v_archived from crm.chat_conversations c where c.id = v_hook.conversation_id;
  if v_archived then
    return query select 'archived'::text, null::uuid, null::uuid, null::text, null::text, null::jsonb, null::timestamptz, false, null::uuid[];
    return;
  end if;
  if v_hook.paused_at is not null then
    return query select 'paused'::text, null::uuid, null::uuid, null::text, null::text, null::jsonb, null::timestamptz, false, null::uuid[];
    return;
  end if;
  if v_key is not null then
    select m.id into v_id from crm.chat_messages m where m.via_hook_id = v_hook.id and m.client_key = v_key;
    if v_id is not null then
      return query
        select 'ok'::text, m.id, m.conversation_id, m.author_name, m.body, m.hook, m.created_at, true, array(select cm.user_id from crm.chat_members cm where cm.conversation_id = m.conversation_id)
        from crm.chat_messages m where m.id = v_id;
      return;
    end if;
  end if;
  if not private.consume_rate_limit('chat-hook:' || v_hook.id::text, greatest(1, coalesce(p_limit, 30)), greatest(1, coalesce(p_window_seconds, 60)), 1) then
    return query select 'rate_limited'::text, null::uuid, null::uuid, null::text, null::text, null::jsonb, null::timestamptz, false, null::uuid[];
    return;
  end if;
  insert into crm.chat_messages (conversation_id, author_user_id, client_key, body, mentions, via_hook_id, hook)
    values (v_hook.conversation_id, null, coalesce(v_key, gen_random_uuid()::text), p_text, '{}', v_hook.id, v_meta)
    on conflict (via_hook_id, client_key) where via_hook_id is not null do nothing
    returning id into v_id;
  if v_id is null then
    return query
      select 'ok'::text, m.id, m.conversation_id, m.author_name, m.body, m.hook, m.created_at, true, array(select cm.user_id from crm.chat_members cm where cm.conversation_id = m.conversation_id)
      from crm.chat_messages m where m.via_hook_id = v_hook.id and m.client_key = v_key;
    return;
  end if;
  update crm.chat_messages m set author_name = v_hook.name where m.id = v_id;
  update crm.chat_hooks h set last_used_at = now() where h.id = v_hook.id;
  return query
    select 'ok'::text, m.id, m.conversation_id, m.author_name, m.body, m.hook, m.created_at, false, array(select cm.user_id from crm.chat_members cm where cm.conversation_id = m.conversation_id)
    from crm.chat_messages m where m.id = v_id;
end;
$$;

revoke all on function private.chat_hook_post(uuid, text, text, text, text, boolean, text, integer, integer) from public;
grant execute on function private.chat_hook_post(uuid, text, text, text, text, boolean, text, integer, integer) to crm_app;

create or replace function private.chat_hook_auth(p_hook uuid, p_secret_hash text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when h.id is null then 'not_found'
    when p_secret_hash is null or h.secret_hash <> p_secret_hash then 'unauthorised'
    when h.archived then 'archived'
    when h.paused_at is not null then 'paused'
    else 'ok'
  end
  from (select 1) one
  left join lateral (
    select x.id, x.secret_hash, x.paused_at, c.archived_at is not null as archived
    from crm.chat_hooks x
    join crm.chat_conversations c on c.id = x.conversation_id and c.kind = 'room'
    where x.id = p_hook
  ) h on true
$$;

revoke all on function private.chat_hook_auth(uuid, text) from public;
grant execute on function private.chat_hook_auth(uuid, text) to crm_app;

reset lock_timeout;
