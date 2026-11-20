set lock_timeout = '5s';

alter table crm.chat_conversations drop constraint if exists chat_conversations_kind_check;
alter table crm.chat_conversations add constraint chat_conversations_kind_check check (kind in ('room', 'dm', 'group_dm', 'task', 'doc', 'mail_thread')) not valid;
alter table crm.chat_conversations validate constraint chat_conversations_kind_check;

alter table crm.chat_conversations drop constraint if exists chat_conversations_shape_check;
alter table crm.chat_conversations add constraint chat_conversations_shape_check check (
  (kind = 'room' and name is not null and length(btrim(name)) between 1 and 80 and task_id is null and page_id is null and dm_key is null and mail_share_id is null)
  or (kind = 'dm' and dm_key is not null and workspace_id is null and task_id is null and page_id is null and mail_share_id is null)
  or (kind = 'group_dm' and name is null and dm_key is not null and cardinality(string_to_array(dm_key, ':')) between 3 and 8 and workspace_id is null and task_id is null and page_id is null and mail_share_id is null)
  or (kind = 'task' and task_id is not null and workspace_id is null and page_id is null and dm_key is null and mail_share_id is null)
  or (kind = 'doc' and page_id is not null and workspace_id is null and task_id is null and dm_key is null and mail_share_id is null)
  or (kind = 'mail_thread' and mail_share_id is not null and workspace_id is null and task_id is null and page_id is null and dm_key is null)
) not valid;
alter table crm.chat_conversations validate constraint chat_conversations_shape_check;

drop policy if exists chat_conversations_select on crm.chat_conversations;
create policy chat_conversations_select on crm.chat_conversations
  for select to authenticated
  using (
    (kind in ('room', 'dm', 'group_dm') and id in (select private.my_chat_ids()))
    or (kind = 'task' and exists (select 1 from crm.tasks t where t.id = chat_conversations.task_id))
    or (kind = 'doc' and exists (select 1 from crm.pages p where p.id = chat_conversations.page_id and p.effective_shared and p.kind = 'note'))
    or (kind = 'mail_thread' and mail_share_id in (select private.my_mail_share_ids()))
  );

create or replace function private.chat_open_group(p_user uuid, p_others uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_people uuid[];
  v_key text;
  v_id uuid;
  v_shared boolean;
begin
  if p_user is null then
    raise exception 'Sign in again.' using errcode = '42501';
  end if;
  v_people := array(
    select distinct x.id from unnest(array[p_user] || coalesce(p_others, '{}')) as x(id) where x.id is not null order by x.id
  );
  if cardinality(v_people) < 2 then
    raise exception 'Pick a teammate.' using errcode = '22023';
  end if;
  if cardinality(v_people) = 2 then
    return private.chat_open_dm(p_user, (select x.id from unnest(v_people) as x(id) where x.id <> p_user));
  end if;
  if cardinality(v_people) > 8 then
    raise exception 'A group message is for up to 8 people, including you.' using errcode = '22023';
  end if;
  v_key := array_to_string(v_people, ':');
  perform 1 from crm.workspace_members m where m.user_id = any(v_people) order by m.workspace_id, m.user_id for share;
  v_shared := not exists (
    select 1 from unnest(v_people) as x(id) where x.id <> p_user and not private.chat_shares_workspace(p_user, x.id)
  );
  select c.id into v_id from crm.chat_conversations c where c.dm_key = v_key;
  if v_id is null then
    if not v_shared then
      raise exception 'You can only message people who share a workspace with you.' using errcode = '42501';
    end if;
    insert into crm.chat_conversations (kind, dm_key, created_by)
      values ('group_dm', v_key, p_user)
      on conflict (dm_key) where dm_key is not null do nothing
      returning id into v_id;
    if v_id is null then
      select c.id into v_id from crm.chat_conversations c where c.dm_key = v_key;
    end if;
  elsif not v_shared and not exists (select 1 from crm.chat_members m where m.conversation_id = v_id and m.user_id = p_user) then
    raise exception 'You can only message people who share a workspace with you.' using errcode = '42501';
  end if;
  if v_shared then
    insert into crm.chat_members (conversation_id, user_id, added_by)
      select v_id, x.id, p_user from unnest(v_people) as x(id) order by x.id
      on conflict do nothing;
  end if;
  update crm.chat_members m set opened = true where m.conversation_id = v_id and m.user_id = p_user and not m.opened;
  return v_id;
end;
$$;

revoke all on function private.chat_open_group(uuid, uuid[]) from public;
grant execute on function private.chat_open_group(uuid, uuid[]) to crm_app;

create or replace function private.chat_message_counts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_root record;
  v_followers uuid[];
begin
  if tg_op = 'INSERT' then
    if new.parent_id is null then
      if cardinality(new.mentions) > 0 then
        perform private.chat_follow(new.id, new.mentions, new.created_at);
      end if;
      return null;
    end if;
    update crm.chat_messages r
      set reply_count = r.reply_count + 1,
          last_reply_at = greatest(coalesce(r.last_reply_at, new.created_at), new.created_at)
      where r.id = new.parent_id
      returning r.author_user_id, r.created_at into v_root;
    v_followers := array[v_root.author_user_id] || new.mentions;
    if exists (select 1 from crm.chat_conversations c where c.id = new.conversation_id and c.kind in ('dm', 'group_dm')) then
      v_followers := v_followers || array(select cm.user_id from crm.chat_members cm where cm.conversation_id = new.conversation_id);
    end if;
    perform private.chat_follow(new.parent_id, array_remove(v_followers, new.author_user_id), v_root.created_at);
    insert into crm.chat_thread_reads (message_id, user_id, last_read_at)
      values (new.parent_id, new.author_user_id, new.created_at)
      on conflict (message_id, user_id) do update set last_read_at = greatest(crm.chat_thread_reads.last_read_at, excluded.last_read_at);
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.parent_id is not null and new.deleted_at is not null and old.deleted_at is null then
      perform private.chat_recount(new.parent_id);
    end if;
    if new.deleted_at is null and new.mentions is distinct from old.mentions then
      v_followers := array(select unnest(new.mentions) except select unnest(old.mentions));
      v_followers := array_remove(v_followers, new.author_user_id);
      if cardinality(v_followers) > 0 then
        if new.parent_id is null then
          perform private.chat_follow(new.id, v_followers, new.created_at);
        else
          perform private.chat_follow(new.parent_id, v_followers, (select r.created_at from crm.chat_messages r where r.id = new.parent_id));
        end if;
      end if;
    end if;
    return null;
  end if;
  if old.parent_id is not null and old.deleted_at is null then
    perform private.chat_recount(old.parent_id);
  end if;
  return null;
end;
$$;

revoke all on function private.chat_message_counts() from public;

create or replace function private.chat_rooms_leaving(p_workspace uuid, p_user uuid)
returns table (conversation_id uuid, member_ids uuid[])
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, array(select o.user_id from crm.chat_members o where o.conversation_id = c.id and o.user_id <> p_user)
  from crm.chat_conversations c
  join crm.chat_members m on m.conversation_id = c.id and m.user_id = p_user
  where (c.kind = 'room' and c.workspace_id = p_workspace)
    or (((c.kind = 'room' and c.workspace_id is null) or c.kind in ('dm', 'group_dm')) and private.chat_stranded(p_user, c.id, p_workspace))
$$;

revoke all on function private.chat_rooms_leaving(uuid, uuid) from public;
grant execute on function private.chat_rooms_leaving(uuid, uuid) to crm_app;

create or replace function private.chat_leave_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from crm.chat_members m
    using crm.chat_conversations c
    where c.id = m.conversation_id and c.kind = 'room' and c.workspace_id = old.workspace_id and m.user_id = old.user_id;
  delete from crm.chat_members m
    using crm.chat_conversations c
    where c.id = m.conversation_id and m.user_id = old.user_id
      and ((c.kind = 'room' and c.workspace_id is null) or c.kind in ('dm', 'group_dm'))
      and private.chat_stranded(old.user_id, c.id, null);
  delete from crm.chat_conversations c
    where c.kind = 'room' and c.workspace_id = old.workspace_id
      and not exists (select 1 from crm.chat_members m where m.conversation_id = c.id);
  return old;
end;
$$;

revoke all on function private.chat_leave_workspace() from public;

create or replace function private.chat_toggle_reaction(p_user uuid, p_message uuid, p_emoji text, p_want boolean)
returns table (present boolean, changed boolean, conversation_id uuid, parent_id uuid, changed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message crm.chat_messages;
  v_conversation crm.chat_conversations;
  v_had boolean;
  v_want boolean;
begin
  select m.* into v_message from crm.chat_messages m where m.id = p_message for no key update;
  if not found or v_message.kind = 'event' then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  select c.* into v_conversation from crm.chat_conversations c where c.id = v_message.conversation_id;
  if not found
    or (v_conversation.kind in ('room', 'dm', 'group_dm') and not exists (
      select 1 from crm.chat_members cm where cm.conversation_id = v_conversation.id and cm.user_id = p_user
    ))
    or (v_conversation.kind not in ('room', 'dm', 'group_dm') and not private.chat_subject_open_to(v_conversation.id, p_user)) then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  if v_conversation.archived_at is not null then
    raise exception 'This room is archived.' using errcode = '22023';
  end if;
  if v_message.deleted_at is not null then
    raise exception 'That message was deleted.' using errcode = '22023';
  end if;

  v_had := exists (select 1 from crm.chat_reactions r where r.message_id = p_message and r.user_id = p_user and r.emoji = p_emoji);
  v_want := coalesce(p_want, not v_had);
  if v_want = v_had then
    return query select v_had, false, v_message.conversation_id, v_message.parent_id, clock_timestamp();
    return;
  end if;
  if v_want then
    if not exists (select 1 from crm.chat_reactions r where r.message_id = p_message and r.emoji = p_emoji)
      and (select count(distinct r.emoji) from crm.chat_reactions r where r.message_id = p_message) >= 20 then
      raise exception 'A message can have up to 20 different reactions.' using errcode = '22023';
    end if;
    insert into crm.chat_reactions (message_id, user_id, emoji) values (p_message, p_user, p_emoji);
  else
    delete from crm.chat_reactions r where r.message_id = p_message and r.user_id = p_user and r.emoji = p_emoji;
  end if;

  return query select v_want, true, v_message.conversation_id, v_message.parent_id, clock_timestamp();
end;
$$;

revoke all on function private.chat_toggle_reaction(uuid, uuid, text, boolean) from public;
grant execute on function private.chat_toggle_reaction(uuid, uuid, text, boolean) to crm_app;

create or replace function private.chat_attachment_open_to(p_conversation uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.chat_conversations c
    where c.id = p_conversation
      and (
        (c.kind in ('room', 'dm', 'group_dm') and exists (select 1 from crm.chat_members m where m.conversation_id = c.id and m.user_id = p_user))
        or (c.kind in ('task', 'doc', 'mail_thread') and private.chat_subject_open_to(c.id, p_user))
      )
  )
$$;

revoke all on function private.chat_attachment_open_to(uuid, uuid) from public;

create or replace function private.chat_search_all(p_user uuid, p_text text, p_filters jsonb, p_limit integer, p_cursor jsonb)
returns table (
  id uuid,
  conversation_id uuid,
  parent_id uuid,
  created_at timestamptz,
  created_key text,
  author_user_id uuid,
  author_name text,
  body text,
  format text,
  conversation_kind text,
  conversation_name text,
  workspace_name text,
  archived boolean,
  subject_id uuid,
  subject_title text,
  files jsonb
)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_text text := left(btrim(coalesce(p_text, '')), 200);
  v_pattern text;
  v_in uuid := nullif(p_filters->>'in', '')::uuid;
  v_from uuid := nullif(p_filters->>'from', '')::uuid;
  v_has_file boolean := coalesce((p_filters->>'has_file')::boolean, false);
  v_before timestamptz := nullif(p_filters->>'before', '')::timestamptz;
  v_after timestamptz := nullif(p_filters->>'after', '')::timestamptz;
  v_agent boolean := coalesce((p_filters->>'agent')::boolean, false);
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 100));
  v_cursor_at timestamptz := nullif(p_cursor->>'t', '')::timestamptz;
  v_cursor_id uuid := nullif(p_cursor->>'id', '')::uuid;
begin
  if p_user is null or char_length(v_text) < 3 then
    return;
  end if;
  v_pattern := '%' || regexp_replace(v_text, '([\\%_])', '\\\1', 'g') || '%';
  return query
    with hits as materialized (
      select m.id, m.conversation_id, m.created_at
      from crm.chat_messages m
      where m.deleted_at is null
        and m.kind = 'message'
        and m.body ilike v_pattern
        and (v_in is null or m.conversation_id = v_in)
        and (v_from is null or m.author_user_id = v_from)
        and (not v_has_file or m.attachment_count > 0)
        and (v_before is null or m.created_at < v_before)
        and (v_after is null or m.created_at > v_after)
        and (v_cursor_at is null or v_cursor_id is null or (m.created_at, m.id) < (v_cursor_at, v_cursor_id))
      union all
      select m.id, m.conversation_id, m.created_at
      from crm.chat_messages m
      where m.id = any (array(select a.message_id from crm.chat_attachments a where a.name ilike v_pattern and a.message_id is not null))
        and not (m.body ilike v_pattern)
        and m.deleted_at is null
        and m.kind = 'message'
        and (v_in is null or m.conversation_id = v_in)
        and (v_from is null or m.author_user_id = v_from)
        and (v_before is null or m.created_at < v_before)
        and (v_after is null or m.created_at > v_after)
        and (v_cursor_at is null or v_cursor_id is null or (m.created_at, m.id) < (v_cursor_at, v_cursor_id))
    ),
    matched as materialized (
      select distinct h.conversation_id from hits h
    ),
    open as materialized (
      select c.id
      from matched x
      join crm.chat_conversations c on c.id = x.conversation_id
      where (
          c.kind in ('room', 'dm', 'group_dm')
          and (not v_agent or c.archived_at is null)
          and exists (select 1 from crm.chat_members me where me.conversation_id = c.id and me.user_id = p_user)
        )
        or (not v_agent and c.kind in ('task', 'doc', 'mail_thread') and private.chat_subject_open_to(c.id, p_user))
    ),
    top as (
      select h.id, h.created_at
      from hits h
      where h.conversation_id in (select o.id from open o)
      order by h.created_at desc, h.id desc
      limit v_limit
    )
    select
      m.id,
      m.conversation_id,
      m.parent_id,
      m.created_at,
      to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      m.author_user_id,
      m.author_name,
      m.body,
      m.format,
      c.kind,
      case c.kind
        when 'room' then c.name
        when 'dm' then coalesce(nullif(btrim(o.name), ''), nullif(btrim(op.full_name), ''), op.email)
      end,
      w.name,
      c.archived_at is not null,
      coalesce(c.task_id, c.page_id, c.mail_share_id),
      case c.kind
        when 'task' then (select t.title from crm.tasks t where t.id = c.task_id)
        when 'doc' then (select pg.title from crm.pages pg where pg.id = c.page_id)
        when 'mail_thread' then (select s.subject from private.mail_share_messages(c.mail_share_id) s order by s.received_at limit 1)
      end,
      case when m.attachment_count > 0 then coalesce((
        select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name) order by array_position(m.attachment_ids, f.id))
        from crm.chat_attachments f
        where f.message_id = m.id
      ), '[]'::jsonb) else '[]'::jsonb end
    from top t
    join crm.chat_messages m on m.id = t.id
    join crm.chat_conversations c on c.id = m.conversation_id
    left join crm.workspaces w on w.id = c.workspace_id
    left join lateral (
      select (case when split_part(c.dm_key, ':', 1) = p_user::text then split_part(c.dm_key, ':', 2) else split_part(c.dm_key, ':', 1) end)::uuid as id
      where c.kind = 'dm'
    ) partner on true
    left join crm.chat_members o on o.conversation_id = c.id and o.user_id = partner.id
    left join crm.profiles op on op.id = partner.id
    order by m.created_at desc, m.id desc;
end;
$$;

revoke all on function private.chat_search_all(uuid, text, jsonb, integer, jsonb) from public;
grant execute on function private.chat_search_all(uuid, text, jsonb, integer, jsonb) to crm_app;

reset lock_timeout;
