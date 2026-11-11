set lock_timeout = '5s';

create table if not exists crm.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  workspace_id uuid references crm.workspaces (id) on delete set null,
  name text,
  task_id uuid references crm.tasks (id) on delete cascade,
  page_id uuid references crm.pages (id) on delete cascade,
  dm_key text,
  created_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint chat_conversations_kind_check check (kind in ('room', 'dm', 'task', 'doc')),
  constraint chat_conversations_shape_check check (
    (kind = 'room' and name is not null and length(btrim(name)) between 1 and 80 and task_id is null and page_id is null and dm_key is null)
    or (kind = 'dm' and dm_key is not null and workspace_id is null and task_id is null and page_id is null)
    or (kind = 'task' and task_id is not null and workspace_id is null and page_id is null and dm_key is null)
    or (kind = 'doc' and page_id is not null and workspace_id is null and task_id is null and dm_key is null)
  )
);

create unique index if not exists chat_conversations_dm_key_idx on crm.chat_conversations (dm_key) where dm_key is not null;
create unique index if not exists chat_conversations_task_idx on crm.chat_conversations (task_id) where task_id is not null;
create unique index if not exists chat_conversations_page_idx on crm.chat_conversations (page_id) where page_id is not null;
create index if not exists chat_conversations_workspace_idx on crm.chat_conversations (workspace_id) where workspace_id is not null;

create table if not exists crm.chat_members (
  conversation_id uuid not null references crm.chat_conversations (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  name text not null default '',
  opened boolean not null default false,
  last_read_at timestamptz not null default now(),
  added_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table crm.chat_members add column if not exists name text not null default '';
alter table crm.chat_members add column if not exists opened boolean not null default false;

create index if not exists chat_members_user_idx on crm.chat_members (user_id, conversation_id);

create table if not exists crm.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references crm.chat_conversations (id) on delete cascade,
  parent_id uuid references crm.chat_messages (id) on delete cascade,
  author_user_id uuid references crm.profiles (id) on delete set null,
  author_name text not null default '',
  client_key text,
  body text not null default '',
  mentions uuid[] not null default '{}',
  reply_count integer not null default 0,
  last_reply_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint chat_messages_client_key_check check (client_key is null or length(client_key) between 1 and 100),
  constraint chat_messages_body_check check (length(body) <= 10000),
  constraint chat_messages_body_present check (deleted_at is not null or length(btrim(body, E' \t\n')) > 0),
  constraint chat_messages_mentions_check check (cardinality(mentions) <= 50),
  constraint chat_messages_author_client_key unique (author_user_id, client_key)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_body_present' and conrelid = 'crm.chat_messages'::regclass) then
    alter table crm.chat_messages add constraint chat_messages_body_present check (deleted_at is not null or length(btrim(body, E' \t\n')) > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_mentions_check' and conrelid = 'crm.chat_messages'::regclass) then
    alter table crm.chat_messages add constraint chat_messages_mentions_check check (cardinality(mentions) <= 50);
  end if;
end;
$$;

create index if not exists chat_messages_conversation_idx on crm.chat_messages (conversation_id, created_at desc, id desc) where deleted_at is null;
create index if not exists chat_messages_roots_idx on crm.chat_messages (conversation_id, created_at desc, id desc) where parent_id is null;
create index if not exists chat_messages_parent_idx on crm.chat_messages (parent_id, created_at, id) where parent_id is not null;
create index if not exists chat_messages_body_trgm_idx on crm.chat_messages using gin (body gin_trgm_ops) where deleted_at is null;

create table if not exists crm.chat_thread_reads (
  message_id uuid not null references crm.chat_messages (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index if not exists chat_thread_reads_user_idx on crm.chat_thread_reads (user_id, last_read_at);

alter table crm.chat_conversations enable row level security;
alter table crm.chat_conversations force row level security;
alter table crm.chat_members enable row level security;
alter table crm.chat_members force row level security;
alter table crm.chat_messages enable row level security;
alter table crm.chat_messages force row level security;
alter table crm.chat_thread_reads enable row level security;
alter table crm.chat_thread_reads force row level security;

create or replace function private.my_chat_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.conversation_id from crm.chat_members m where m.user_id = (select auth.uid())
$$;

revoke all on function private.my_chat_ids() from public;
grant execute on function private.my_chat_ids() to authenticated;

drop policy if exists chat_conversations_select on crm.chat_conversations;
create policy chat_conversations_select on crm.chat_conversations
  for select to authenticated
  using (
    (kind in ('room', 'dm') and id in (select private.my_chat_ids()))
    or (kind = 'task' and exists (select 1 from crm.tasks t where t.id = chat_conversations.task_id))
    or (kind = 'doc' and exists (select 1 from crm.pages p where p.id = chat_conversations.page_id and p.effective_shared and p.kind = 'note'))
  );

drop policy if exists chat_members_select on crm.chat_members;
create policy chat_members_select on crm.chat_members
  for select to authenticated
  using (conversation_id in (select private.my_chat_ids()));

drop policy if exists chat_members_update_own on crm.chat_members;
create policy chat_members_update_own on crm.chat_members
  for update to authenticated
  using (user_id = (select private.session_user_id()))
  with check (user_id = (select private.session_user_id()));

drop policy if exists chat_messages_select on crm.chat_messages;
create policy chat_messages_select on crm.chat_messages
  for select to authenticated
  using (exists (select 1 from crm.chat_conversations c where c.id = chat_messages.conversation_id));

drop policy if exists chat_messages_insert_own on crm.chat_messages;
create policy chat_messages_insert_own on crm.chat_messages
  for insert to authenticated
  with check (
    author_user_id = (select private.session_user_id())
    and exists (select 1 from crm.chat_conversations c where c.id = chat_messages.conversation_id and c.archived_at is null)
  );

drop policy if exists chat_messages_update_own on crm.chat_messages;
create policy chat_messages_update_own on crm.chat_messages
  for update to authenticated
  using (
    author_user_id = (select private.session_user_id())
    and exists (select 1 from crm.chat_conversations c where c.id = chat_messages.conversation_id and c.archived_at is null)
  )
  with check (author_user_id = (select private.session_user_id()));

drop policy if exists chat_thread_reads_own on crm.chat_thread_reads;
create policy chat_thread_reads_own on crm.chat_thread_reads
  for all to authenticated
  using (user_id = (select private.session_user_id()))
  with check (
    user_id = (select private.session_user_id())
    and exists (select 1 from crm.chat_messages m where m.id = chat_thread_reads.message_id and m.parent_id is null)
  );

revoke all on crm.chat_conversations, crm.chat_members, crm.chat_messages, crm.chat_thread_reads from anon, authenticated, crm_agent;
grant select on crm.chat_conversations to authenticated;
grant select on crm.chat_members to authenticated;
grant update (last_read_at) on crm.chat_members to authenticated;
grant select on crm.chat_messages to authenticated;
grant insert (conversation_id, parent_id, author_user_id, client_key, body, mentions) on crm.chat_messages to authenticated;
grant update (body, mentions, deleted_at) on crm.chat_messages to authenticated;
grant select, insert, update, delete on crm.chat_thread_reads to authenticated;

create or replace function private.chat_message_prepare()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent record;
begin
  select coalesce(nullif(btrim(p.full_name), ''), p.email, 'Teammate') into new.author_name
    from crm.profiles p where p.id = new.author_user_id;
  new.author_name := coalesce(new.author_name, 'Teammate');
  if new.parent_id is not null then
    select m.conversation_id, m.parent_id, m.deleted_at into v_parent from crm.chat_messages m where m.id = new.parent_id;
    if not found or v_parent.conversation_id <> new.conversation_id or v_parent.parent_id is not null then
      raise exception 'Reply to a message in this conversation.' using errcode = '22023';
    end if;
    if v_parent.deleted_at is not null then
      raise exception 'That message was deleted.' using errcode = '22023';
    end if;
  end if;
  new.mentions := coalesce((select array_agg(distinct x) from unnest(new.mentions) as x where x is not null), '{}');
  if cardinality(new.mentions) > 50 then
    raise exception 'Tag up to 50 people in one message.' using errcode = '22023';
  end if;
  new.reply_count := 0;
  new.last_reply_at := null;
  new.edited_at := null;
  new.deleted_at := null;
  perform pg_advisory_xact_lock(hashtextextended('chat:' || new.conversation_id::text, 0));
  new.created_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function private.chat_message_prepare() from public;

drop trigger if exists chat_messages_prepare on crm.chat_messages;
create trigger chat_messages_prepare
  before insert on crm.chat_messages
  for each row execute function private.chat_message_prepare();

create or replace function private.chat_message_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null and (new.body is distinct from old.body or new.mentions is distinct from old.mentions or new.deleted_at is distinct from old.deleted_at) then
    raise exception 'That message was deleted.' using errcode = '22023';
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    new.deleted_at := clock_timestamp();
    new.body := '';
    new.mentions := '{}';
  elsif new.body is distinct from old.body or new.mentions is distinct from old.mentions then
    new.edited_at := clock_timestamp();
    new.mentions := coalesce((select array_agg(distinct x) from unnest(new.mentions) as x where x is not null), '{}');
    if cardinality(new.mentions) > 50 then
      raise exception 'Tag up to 50 people in one message.' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.chat_message_change() from public;

drop trigger if exists chat_messages_change on crm.chat_messages;
create trigger chat_messages_change
  before update of body, mentions, deleted_at on crm.chat_messages
  for each row execute function private.chat_message_change();

create or replace function private.chat_follow(p_root uuid, p_users uuid[], p_read_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation crm.chat_conversations;
begin
  select c.* into v_conversation
    from crm.chat_messages m join crm.chat_conversations c on c.id = m.conversation_id
    where m.id = p_root;
  if v_conversation.id is null then
    return;
  end if;
  insert into crm.chat_thread_reads (message_id, user_id, last_read_at)
    select p_root, u.id, p_read_at
    from (select distinct x as id from unnest(p_users) as x where x is not null) u
    where case v_conversation.kind
      when 'task' then exists (
        select 1 from crm.tasks t
        join crm.workspace_members wm on wm.workspace_id = t.workspace_id and wm.user_id = u.id
        where t.id = v_conversation.task_id
          and (t.owner_id = u.id or t.created_by_user_id = u.id or wm.role in ('owner', 'admin'))
      )
      when 'doc' then exists (
        select 1 from crm.pages p
        join crm.workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = u.id
        where p.id = v_conversation.page_id and p.effective_shared and p.kind = 'note'
      )
      else exists (select 1 from crm.chat_members cm where cm.conversation_id = v_conversation.id and cm.user_id = u.id)
    end
  on conflict (message_id, user_id) do nothing;
end;
$$;

revoke all on function private.chat_follow(uuid, uuid[], timestamptz) from public;

create or replace function private.chat_recount(p_root uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from crm.chat_messages r where r.id = p_root for update;
  update crm.chat_messages r
    set reply_count = s.replies, last_reply_at = s.latest
    from (
      select count(*)::integer as replies, max(m.created_at) as latest
      from crm.chat_messages m
      where m.parent_id = p_root and m.deleted_at is null
    ) s
    where r.id = p_root;
end;
$$;

revoke all on function private.chat_recount(uuid) from public;

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
    if exists (select 1 from crm.chat_conversations c where c.id = new.conversation_id and c.kind = 'dm') then
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

drop trigger if exists chat_messages_counts on crm.chat_messages;
create trigger chat_messages_counts
  after insert or delete or update of deleted_at, mentions on crm.chat_messages
  for each row execute function private.chat_message_counts();

create or replace function private.chat_shares_workspace(p_user uuid, p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.workspace_members a
    join crm.workspace_members b on b.workspace_id = a.workspace_id
    where a.user_id = p_user and b.user_id = p_other
  )
$$;

revoke all on function private.chat_shares_workspace(uuid, uuid) from public;
grant execute on function private.chat_shares_workspace(uuid, uuid) to crm_app;

create or replace function private.chat_check_people(p_user uuid, p_workspace uuid, p_people uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if cardinality(coalesce(p_people, '{}')) > 200 then
    raise exception 'Add up to 200 people at a time.' using errcode = '22023';
  end if;
  perform 1 from crm.workspace_members m
    where m.user_id = any(array[p_user] || coalesce(p_people, '{}'))
      and (p_workspace is null or m.workspace_id = p_workspace)
    order by m.workspace_id, m.user_id
    for share;
  if p_workspace is not null then
    if exists (
      select 1 from unnest(coalesce(p_people, '{}')) as x(id)
      where x.id is not null and not exists (select 1 from crm.workspace_members m where m.workspace_id = p_workspace and m.user_id = x.id)
    ) then
      raise exception 'Someone you picked isn''t in this room''s workspace. Only its members can join.' using errcode = '22023';
    end if;
    return;
  end if;
  if exists (
    select 1 from unnest(coalesce(p_people, '{}')) as x(id)
    where x.id is not null and x.id <> p_user and not private.chat_shares_workspace(p_user, x.id)
  ) then
    raise exception 'Someone you picked doesn''t share a workspace with you.' using errcode = '22023';
  end if;
end;
$$;

revoke all on function private.chat_check_people(uuid, uuid, uuid[]) from public;

create or replace function private.chat_member_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select coalesce(nullif(btrim(p.full_name), ''), p.email, '') into new.name from crm.profiles p where p.id = new.user_id;
  new.name := coalesce(new.name, '');
  return new;
end;
$$;

revoke all on function private.chat_member_name() from public;

drop trigger if exists chat_members_name on crm.chat_members;
create trigger chat_members_name
  before insert on crm.chat_members
  for each row execute function private.chat_member_name();

create or replace function private.chat_profile_renamed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update crm.chat_members m
    set name = coalesce(nullif(btrim(new.full_name), ''), new.email, '')
    where m.user_id = new.id;
  return null;
end;
$$;

revoke all on function private.chat_profile_renamed() from public;

drop trigger if exists profiles_chat_name on crm.profiles;
create trigger profiles_chat_name
  after update of full_name, email on crm.profiles
  for each row
  when (old.full_name is distinct from new.full_name or old.email is distinct from new.email)
  execute function private.chat_profile_renamed();

create or replace function private.chat_stranded(p_user uuid, p_conversation uuid, p_leaving uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from crm.chat_members o where o.conversation_id = p_conversation and o.user_id <> p_user)
    and not exists (
      select 1 from crm.chat_members o
      join crm.workspace_members theirs on theirs.user_id = o.user_id
      join crm.workspace_members mine on mine.workspace_id = theirs.workspace_id and mine.user_id = p_user
      where o.conversation_id = p_conversation and o.user_id <> p_user
        and (p_leaving is null or mine.workspace_id <> p_leaving)
    )
$$;

revoke all on function private.chat_stranded(uuid, uuid, uuid) from public;

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
    or (((c.kind = 'room' and c.workspace_id is null) or c.kind = 'dm') and private.chat_stranded(p_user, c.id, p_workspace))
$$;

revoke all on function private.chat_rooms_leaving(uuid, uuid) from public;
grant execute on function private.chat_rooms_leaving(uuid, uuid) to crm_app;

create or replace function private.chat_room_name(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text := regexp_replace(
    regexp_replace(coalesce(p_name, ''), E'[\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]', '', 'g'),
    E'^[[:space:]]+|[[:space:]]+$', '', 'g'
  );
begin
  if regexp_replace(v_name, E'[\\u115F\\u1160\\u3164\\uFFA0\\u2800]', '', 'g') !~ '[[:alnum:]]' then
    raise exception 'Give the room a name.' using errcode = '22023';
  end if;
  if length(v_name) > 80 then
    raise exception 'Keep the room name to 80 characters.' using errcode = '22023';
  end if;
  return v_name;
end;
$$;

revoke all on function private.chat_room_name(text) from public;

create or replace function private.chat_create_room(p_user uuid, p_name text, p_workspace uuid, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := private.chat_room_name(p_name);
  v_id uuid;
begin
  if p_user is null or not exists (select 1 from crm.workspace_members m where m.user_id = p_user) then
    raise exception 'Sign in again.' using errcode = '42501';
  end if;
  if p_workspace is not null and not exists (select 1 from crm.workspace_members m where m.user_id = p_user and m.workspace_id = p_workspace) then
    raise exception 'Pick one of your workspaces.' using errcode = '42501';
  end if;
  perform private.chat_check_people(p_user, p_workspace, p_members);
  insert into crm.chat_conversations (kind, workspace_id, name, created_by)
    values ('room', p_workspace, v_name, p_user)
    returning id into v_id;
  insert into crm.chat_members (conversation_id, user_id, added_by)
    select v_id, x.id, p_user
    from (select distinct y as id from unnest(array[p_user] || coalesce(p_members, '{}')) as y where y is not null) x
  on conflict do nothing;
  return v_id;
end;
$$;

revoke all on function private.chat_create_room(uuid, text, uuid, uuid[]) from public;
grant execute on function private.chat_create_room(uuid, text, uuid, uuid[]) to crm_app;

create or replace function private.chat_open_dm(p_user uuid, p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_id uuid;
  v_shared boolean;
begin
  if p_user is null or p_other is null then
    raise exception 'Pick a teammate.' using errcode = '22023';
  end if;
  if p_user = p_other then
    raise exception 'Pick a teammate other than yourself.' using errcode = '22023';
  end if;
  v_key := least(p_user::text, p_other::text) || ':' || greatest(p_user::text, p_other::text);
  perform 1 from crm.workspace_members m where m.user_id in (p_user, p_other) order by m.workspace_id, m.user_id for share;
  v_shared := private.chat_shares_workspace(p_user, p_other);
  select c.id into v_id from crm.chat_conversations c where c.dm_key = v_key;
  if v_id is null then
    if not v_shared then
      raise exception 'You can only message people who share a workspace with you.' using errcode = '42501';
    end if;
    insert into crm.chat_conversations (kind, dm_key, created_by)
      values ('dm', v_key, p_user)
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
      select v_id, x.id, p_user from unnest(array[p_user, p_other]) as x(id) order by x.id
      on conflict do nothing;
  end if;
  update crm.chat_members m set opened = true where m.conversation_id = v_id and m.user_id = p_user and not m.opened;
  return v_id;
end;
$$;

revoke all on function private.chat_open_dm(uuid, uuid) from public;
grant execute on function private.chat_open_dm(uuid, uuid) to crm_app;

create or replace function private.chat_room_for_member(p_user uuid, p_room uuid)
returns crm.chat_conversations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room crm.chat_conversations;
begin
  select c.* into v_room from crm.chat_conversations c
    where c.id = p_room and c.kind = 'room' and c.archived_at is null
      and exists (select 1 from crm.chat_members m where m.conversation_id = c.id and m.user_id = p_user)
    for update;
  if not found then
    raise exception 'Room not found.' using errcode = 'P0002';
  end if;
  return v_room;
end;
$$;

revoke all on function private.chat_room_for_member(uuid, uuid) from public;

create or replace function private.chat_update_room(p_user uuid, p_room uuid, p_name text, p_set_workspace boolean, p_workspace uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room crm.chat_conversations := private.chat_room_for_member(p_user, p_room);
  v_name text := case when p_name is null then v_room.name else private.chat_room_name(p_name) end;
  v_workspace uuid := case when p_set_workspace then p_workspace else v_room.workspace_id end;
  v_outside text;
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
  update crm.chat_conversations set name = v_name, workspace_id = v_workspace where id = p_room;
end;
$$;

revoke all on function private.chat_update_room(uuid, uuid, text, boolean, uuid) from public;
grant execute on function private.chat_update_room(uuid, uuid, text, boolean, uuid) to crm_app;

create or replace function private.chat_add_members(p_user uuid, p_room uuid, p_members uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room crm.chat_conversations := private.chat_room_for_member(p_user, p_room);
  v_added uuid[];
begin
  perform private.chat_check_people(p_user, v_room.workspace_id, p_members);
  with added as (
    insert into crm.chat_members (conversation_id, user_id, added_by)
      select p_room, x.id, p_user
      from (select distinct y as id from unnest(coalesce(p_members, '{}')) as y where y is not null) x
    on conflict do nothing
    returning user_id
  )
  select coalesce(array_agg(user_id), '{}') into v_added from added;
  return v_added;
end;
$$;

revoke all on function private.chat_add_members(uuid, uuid, uuid[]) from public;
grant execute on function private.chat_add_members(uuid, uuid, uuid[]) to crm_app;

create or replace function private.chat_remove_member(p_user uuid, p_room uuid, p_member uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room crm.chat_conversations := private.chat_room_for_member(p_user, p_room);
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

create or replace function private.chat_thread_followers(p_user uuid, p_root uuid)
returns table (user_id uuid, last_read_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.user_id, t.last_read_at
  from crm.chat_messages r
  join crm.chat_thread_reads t on t.message_id = r.id
  join crm.chat_members cm on cm.conversation_id = r.conversation_id and cm.user_id = t.user_id
  where r.id = p_root and r.parent_id is null
    and exists (select 1 from crm.chat_members me where me.conversation_id = r.conversation_id and me.user_id = p_user)
$$;

revoke all on function private.chat_thread_followers(uuid, uuid) from public;
grant execute on function private.chat_thread_followers(uuid, uuid) to crm_app;

create or replace function private.chat_message_followers(p_user uuid, p_message uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select f.user_id
  from crm.chat_messages m
  cross join lateral private.chat_thread_followers(p_user, m.parent_id) f
  where m.id = p_message and m.parent_id is not null
$$;

revoke all on function private.chat_message_followers(uuid, uuid) from public;
grant execute on function private.chat_message_followers(uuid, uuid) to crm_app;

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
    where x.conversation_id = p_conversation and x.deleted_at is null and x.body ilike p_pattern
    order by x.created_at desc, x.id desc
    limit greatest(1, least(coalesce(p_limit, 30), 50));
end;
$$;

revoke all on function private.chat_search(uuid, uuid, text, integer) from public;
grant execute on function private.chat_search(uuid, uuid, text, integer) to crm_app;

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
      and ((c.kind = 'room' and c.workspace_id is null) or c.kind = 'dm')
      and private.chat_stranded(old.user_id, c.id, null);
  delete from crm.chat_conversations c
    where c.kind = 'room' and c.workspace_id = old.workspace_id
      and not exists (select 1 from crm.chat_members m where m.conversation_id = c.id);
  return old;
end;
$$;

revoke all on function private.chat_leave_workspace() from public;

drop trigger if exists workspace_members_leave_chat on crm.workspace_members;
create trigger workspace_members_leave_chat
  after delete on crm.workspace_members
  for each row execute function private.chat_leave_workspace();

do $$
begin
  if to_regclass('realtime.messages') is null then
    return;
  end if;

  execute 'drop policy if exists chat_live_receive on realtime.messages';
  execute $policy$
    create policy chat_live_receive on realtime.messages
      for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and (
          case when (select realtime.topic()) ~ '^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then substr((select realtime.topic()), 6)::uuid
          end
        ) in (select private.my_chat_ids())
      )
  $policy$;

  execute 'drop policy if exists chat_live_send on realtime.messages';
  execute $policy$
    create policy chat_live_send on realtime.messages
      for insert to authenticated
      with check (
        realtime.messages.extension = 'broadcast'
        and (
          case when (select realtime.topic()) ~ '^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then substr((select realtime.topic()), 6)::uuid
          end
        ) in (select private.my_chat_ids())
      )
  $policy$;
end;
$$;

reset lock_timeout;
