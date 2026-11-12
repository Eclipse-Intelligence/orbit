set lock_timeout = '5s';

create table if not exists crm.mail_shares (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  thread_key text not null,
  created_at timestamptz not null default now(),
  constraint mail_shares_thread_key_check check (char_length(thread_key) between 1 and 450),
  constraint mail_shares_unique unique (owner_user_id, source_id, thread_key)
);

create index if not exists mail_shares_source_thread_idx on crm.mail_shares (source_id, thread_key);

create table if not exists crm.mail_share_members (
  share_id uuid not null references crm.mail_shares (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  added_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (share_id, user_id)
);

create index if not exists mail_share_members_user_idx on crm.mail_share_members (user_id);
create index if not exists mail_share_members_added_by_idx on crm.mail_share_members (added_by);
drop index if exists crm.mail_shares_owner_idx;

alter table crm.mail_shares enable row level security;
alter table crm.mail_shares force row level security;
alter table crm.mail_share_members enable row level security;
alter table crm.mail_share_members force row level security;

create or replace function private.my_mail_share_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from crm.mail_shares s where s.owner_user_id = (select auth.uid())
  union
  select m.share_id from crm.mail_share_members m where m.user_id = (select auth.uid())
$$;

revoke all on function private.my_mail_share_ids() from public;
grant execute on function private.my_mail_share_ids() to authenticated;

drop policy if exists mail_shares_select on crm.mail_shares;
create policy mail_shares_select on crm.mail_shares
  for select to authenticated
  using (id in (select private.my_mail_share_ids()));

drop policy if exists mail_share_members_select on crm.mail_share_members;
create policy mail_share_members_select on crm.mail_share_members
  for select to authenticated
  using (share_id in (select private.my_mail_share_ids()));

revoke all on crm.mail_shares, crm.mail_share_members from anon, authenticated, crm_agent;
grant select (id, owner_user_id, created_at) on crm.mail_shares to authenticated;
grant select on crm.mail_share_members to authenticated;

create or replace function private.mail_share_open_to(p_share uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from crm.mail_shares s where s.id = p_share and s.owner_user_id = p_user)
    or exists (select 1 from crm.mail_share_members m where m.share_id = p_share and m.user_id = p_user)
$$;

revoke all on function private.mail_share_open_to(uuid, uuid) from public;

create or replace function private.mail_share_messages(p_share uuid)
returns setof crm.mail_messages
language sql
stable
security definer
set search_path = ''
as $$
  select m.*
  from crm.mail_shares s
  join crm.mail_messages m on m.user_id = s.owner_user_id and m.source_id = s.source_id and m.thread_key = s.thread_key
  join crm.mail_folders f on f.id = m.folder_id
  where s.id = p_share and not m.is_draft and f.role not in ('drafts', 'trash', 'junk', 'outbox')
$$;

revoke all on function private.mail_share_messages(uuid) from public;

create or replace function private.mail_share_owner_addresses(p_owner uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(s.email) from crm.mail_sources s where s.user_id = p_owner
  union
  select lower(i.email) from crm.send_identities i where i.user_id = p_owner
  union
  select lower(p.email) from crm.profiles p where p.id = p_owner and p.email is not null
$$;

revoke all on function private.mail_share_owner_addresses(uuid) from public;

create or replace function private.mail_share_add(p_user uuid, p_source uuid, p_thread_key text, p_people uuid[])
returns table (share_id uuid, added uuid[], added_at timestamptz, others uuid[])
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_people uuid[];
  v_share uuid;
  v_added uuid[];
  v_others uuid[];
begin
  if p_user is null or not exists (select 1 from crm.mail_sources s where s.id = p_source and s.user_id = p_user) then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
    where m.user_id = p_user and m.source_id = p_source and m.thread_key = p_thread_key
      and not m.is_draft and f.role not in ('drafts', 'trash', 'junk', 'outbox')
  ) then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  v_people := array(select distinct x from unnest(coalesce(p_people, '{}')) as x where x is not null and x <> p_user);
  if cardinality(v_people) = 0 then
    raise exception 'Pick someone to share it with.' using errcode = '22023';
  end if;
  if cardinality(v_people) > 50 then
    raise exception 'Add up to 50 people at a time.' using errcode = '22023';
  end if;
  perform 1 from crm.workspace_members m
    where m.user_id = any(array[p_user] || v_people)
    order by m.workspace_id, m.user_id
    for share;
  if exists (select 1 from unnest(v_people) as x(id) where not private.chat_shares_workspace(p_user, x.id)) then
    raise exception 'Someone you picked doesn''t share a workspace with you.' using errcode = '22023';
  end if;
  insert into crm.mail_shares (owner_user_id, source_id, thread_key)
    values (p_user, p_source, p_thread_key)
    on conflict (owner_user_id, source_id, thread_key) do nothing;
  select s.id into v_share from crm.mail_shares s
    where s.owner_user_id = p_user and s.source_id = p_source and s.thread_key = p_thread_key;
  v_others := array(select m.user_id from crm.mail_share_members m where m.share_id = v_share and m.user_id <> all(v_people));
  with inserted as (
    insert into crm.mail_share_members (share_id, user_id, added_by)
      select v_share, x, p_user from unnest(v_people) as x
      on conflict (share_id, user_id) do nothing
      returning user_id
  )
  select coalesce(array_agg(i.user_id), '{}') into v_added from inserted i;
  return query select v_share, v_added, now(), v_others;
end;
$$;

revoke all on function private.mail_share_add(uuid, uuid, text, uuid[]) from public;
grant execute on function private.mail_share_add(uuid, uuid, text, uuid[]) to crm_app;

create or replace function private.mail_share_remove(p_user uuid, p_share uuid, p_member uuid)
returns table (removed boolean, others uuid[])
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_owner uuid;
  v_removed boolean;
begin
  select s.owner_user_id into v_owner from crm.mail_shares s where s.id = p_share;
  if v_owner is null or not private.mail_share_open_to(p_share, p_user) then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  if v_owner <> p_user then
    raise exception 'Only the person who shared this thread can remove people.' using errcode = '42501';
  end if;
  delete from crm.mail_share_members m where m.share_id = p_share and m.user_id = p_member;
  v_removed := found;
  return query select v_removed, array(select m.user_id from crm.mail_share_members m where m.share_id = p_share);
end;
$$;

revoke all on function private.mail_share_remove(uuid, uuid, uuid) from public;
grant execute on function private.mail_share_remove(uuid, uuid, uuid) to crm_app;

create or replace function private.mail_share_for_thread(p_user uuid, p_source uuid, p_thread_key text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from crm.mail_shares s
  where s.owner_user_id = p_user and s.source_id = p_source and s.thread_key = p_thread_key
$$;

revoke all on function private.mail_share_for_thread(uuid, uuid, text) from public;
grant execute on function private.mail_share_for_thread(uuid, uuid, text) to crm_app;

create or replace function private.mail_share_thread(p_user uuid, p_share uuid)
returns table (source_id uuid, thread_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.source_id, s.thread_key from crm.mail_shares s where s.id = p_share and s.owner_user_id = p_user
$$;

revoke all on function private.mail_share_thread(uuid, uuid) from public;
grant execute on function private.mail_share_thread(uuid, uuid) to crm_app;

create or replace function private.mail_share_people(p_user uuid, p_share uuid)
returns table (user_id uuid, name text, email text, owner boolean, added_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, coalesce(nullif(btrim(p.full_name), ''), 'Someone'),
    case when p.id = p_user or private.chat_shares_workspace(p_user, p.id) then p.email end,
    true, s.created_at
  from crm.mail_shares s join crm.profiles p on p.id = s.owner_user_id
  where s.id = p_share and private.mail_share_open_to(p_share, p_user)
  union all
  select p.id, coalesce(nullif(btrim(p.full_name), ''), 'Someone'),
    case when p.id = p_user or s.owner_user_id = p_user or private.chat_shares_workspace(p_user, p.id) then p.email end,
    false, m.created_at
  from crm.mail_share_members m
  join crm.mail_shares s on s.id = m.share_id
  join crm.profiles p on p.id = m.user_id
  where m.share_id = p_share and private.mail_share_open_to(p_share, p_user)
$$;

revoke all on function private.mail_share_people(uuid, uuid) from public;
grant execute on function private.mail_share_people(uuid, uuid) to crm_app;

create or replace function private.shared_threads(p_user uuid)
returns table (
  share_id uuid,
  owner_user_id uuid,
  owner_name text,
  shared_at timestamptz,
  subject text,
  latest_at timestamptz,
  snippet text,
  counterpart_name text,
  counterpart_email text,
  message_count integer,
  has_attachments boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.owner_user_id, coalesce(nullif(btrim(p.full_name), ''), p.email, 'Someone'), sm.created_at,
    latest.subject, latest.at, latest.snippet, coalesce(them.name, latest.to_name), coalesce(them.address, latest.to_address),
    stats.n, stats.attachments
  from crm.mail_share_members sm
  join crm.mail_shares s on s.id = sm.share_id
  join crm.profiles p on p.id = s.owner_user_id
  cross join lateral (
    select count(*)::integer as n, coalesce(bool_or(m.has_attachments), false) as attachments
    from private.mail_share_messages(s.id) m
  ) stats
  cross join lateral (
    select m.subject, m.snippet, coalesce(m.received_at, m.sent_at, m.created_at) as at,
      m.to_recipients -> 0 ->> 'name' as to_name, m.to_recipients -> 0 ->> 'address' as to_address
    from private.mail_share_messages(s.id) m
    order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.id desc
    limit 1
  ) latest
  left join lateral (
    select m.from_name as name, m.from_email as address
    from private.mail_share_messages(s.id) m
    where m.from_email is not null
      and lower(m.from_email) not in (select a from private.mail_share_owner_addresses(s.owner_user_id) a)
    order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.id desc
    limit 1
  ) them on true
  where sm.user_id = p_user and stats.n > 0
  order by latest.at desc, s.id
$$;

revoke all on function private.shared_threads(uuid) from public;
grant execute on function private.shared_threads(uuid) to crm_app;

create or replace function private.shared_thread(p_user uuid, p_share uuid)
returns table (
  id uuid,
  subject text,
  from_email text,
  from_name text,
  to_recipients jsonb,
  cc_recipients jsonb,
  at timestamptz,
  has_attachments boolean,
  snippet text,
  body_html text,
  body_text text,
  body_truncated boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select newest.* from (
    select m.id, m.subject, m.from_email, m.from_name, m.to_recipients, m.cc_recipients,
      coalesce(m.received_at, m.sent_at, m.created_at) as at, m.has_attachments, m.snippet, m.body_html, m.body_text, m.body_truncated
    from private.mail_share_messages(p_share) m
    where private.mail_share_open_to(p_share, p_user)
    order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.id desc
    limit 200
  ) newest
  order by newest.at, newest.id
$$;

revoke all on function private.shared_thread(uuid, uuid) from public;
grant execute on function private.shared_thread(uuid, uuid) to crm_app;

create or replace function private.shared_message_owner(p_user uuid, p_share uuid, p_message uuid)
returns table (owner_user_id uuid, source_id uuid, provider_message_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.owner_user_id, m.source_id, m.provider_message_id
  from crm.mail_shares s
  join private.mail_share_messages(p_share) m on m.id = p_message
  where s.id = p_share and private.mail_share_open_to(p_share, p_user)
$$;

revoke all on function private.shared_message_owner(uuid, uuid, uuid) from public;
grant execute on function private.shared_message_owner(uuid, uuid, uuid) to crm_app;

drop function if exists private.mail_shares_touched(uuid, uuid[]);

create or replace function private.mail_shares_touched(p_user uuid, p_source uuid, p_thread_keys text[])
returns table (share_id uuid, member_ids uuid[])
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, array(select sm.user_id from crm.mail_share_members sm where sm.share_id = s.id order by sm.user_id)
  from crm.mail_shares s
  where s.owner_user_id = p_user and s.source_id = p_source and s.thread_key = any(p_thread_keys)
    and exists (select 1 from crm.mail_share_members sm where sm.share_id = s.id)
$$;

revoke all on function private.mail_shares_touched(uuid, uuid, text[]) from public;
grant execute on function private.mail_shares_touched(uuid, uuid, text[]) to crm_app;

create or replace function private.mail_share_linked(p_owner uuid, p_member uuid, p_leaving uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.workspace_members a
    join crm.workspace_members b on b.workspace_id = a.workspace_id
    where a.user_id = p_owner and b.user_id = p_member
      and (p_leaving is null or a.workspace_id <> p_leaving)
  )
$$;

revoke all on function private.mail_share_linked(uuid, uuid, uuid) from public;

create or replace function private.mail_shares_leaving(p_workspace uuid, p_user uuid)
returns table (share_id uuid, user_id uuid, member_ids uuid[])
language sql
stable
security definer
set search_path = ''
as $$
  select lost.share_id, lost.user_id,
    array(select o.user_id from crm.mail_share_members o where o.share_id = lost.share_id and o.user_id <> lost.user_id)
      || array(select s.owner_user_id from crm.mail_shares s where s.id = lost.share_id and s.owner_user_id <> p_user)
  from (
    select m.share_id, m.user_id
    from crm.mail_share_members m
    join crm.mail_shares s on s.id = m.share_id
    where (m.user_id = p_user and not private.mail_share_linked(s.owner_user_id, p_user, p_workspace))
       or (s.owner_user_id = p_user and not private.mail_share_linked(p_user, m.user_id, p_workspace))
  ) lost
$$;

revoke all on function private.mail_shares_leaving(uuid, uuid) from public;
grant execute on function private.mail_shares_leaving(uuid, uuid) to crm_app;

create or replace function private.mail_share_leave_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from crm.mail_share_members m
    using crm.mail_shares s
    where m.user_id = old.user_id and s.id = m.share_id
      and not private.mail_share_linked(s.owner_user_id, old.user_id, null);
  delete from crm.mail_share_members m
    using crm.mail_shares s
    where s.owner_user_id = old.user_id and m.share_id = s.id
      and not private.mail_share_linked(old.user_id, m.user_id, null);
  return old;
end;
$$;

revoke all on function private.mail_share_leave_workspace() from public;

drop trigger if exists workspace_members_leave_mail_shares on crm.workspace_members;
create trigger workspace_members_leave_mail_shares
  after delete on crm.workspace_members
  for each row execute function private.mail_share_leave_workspace();

alter table crm.chat_conversations add column if not exists mail_share_id uuid references crm.mail_shares (id) on delete cascade;

create unique index if not exists chat_conversations_mail_share_idx on crm.chat_conversations (mail_share_id) where mail_share_id is not null;

alter table crm.chat_conversations drop constraint if exists chat_conversations_kind_check;
alter table crm.chat_conversations add constraint chat_conversations_kind_check check (kind in ('room', 'dm', 'task', 'doc', 'mail_thread'));

alter table crm.chat_conversations drop constraint if exists chat_conversations_shape_check;
alter table crm.chat_conversations add constraint chat_conversations_shape_check check (
  (kind = 'room' and name is not null and length(btrim(name)) between 1 and 80 and task_id is null and page_id is null and dm_key is null and mail_share_id is null)
  or (kind = 'dm' and dm_key is not null and workspace_id is null and task_id is null and page_id is null and mail_share_id is null)
  or (kind = 'task' and task_id is not null and workspace_id is null and page_id is null and dm_key is null and mail_share_id is null)
  or (kind = 'doc' and page_id is not null and workspace_id is null and task_id is null and dm_key is null and mail_share_id is null)
  or (kind = 'mail_thread' and mail_share_id is not null and workspace_id is null and task_id is null and page_id is null and dm_key is null)
);

drop policy if exists chat_conversations_select on crm.chat_conversations;
create policy chat_conversations_select on crm.chat_conversations
  for select to authenticated
  using (
    (kind in ('room', 'dm') and id in (select private.my_chat_ids()))
    or (kind = 'task' and exists (select 1 from crm.tasks t where t.id = chat_conversations.task_id))
    or (kind = 'doc' and exists (select 1 from crm.pages p where p.id = chat_conversations.page_id and p.effective_shared and p.kind = 'note'))
    or (kind = 'mail_thread' and mail_share_id in (select private.my_mail_share_ids()))
  );

drop policy if exists chat_conversations_insert_subject on crm.chat_conversations;
create policy chat_conversations_insert_subject on crm.chat_conversations
  for insert to authenticated
  with check (
    created_by = (select private.session_user_id())
    and workspace_id is null
    and name is null
    and dm_key is null
    and archived_at is null
    and (
      (kind = 'task' and page_id is null and mail_share_id is null and exists (select 1 from crm.tasks t where t.id = chat_conversations.task_id))
      or (kind = 'doc' and task_id is null and mail_share_id is null and exists (
        select 1 from crm.pages p where p.id = chat_conversations.page_id and p.effective_shared and p.kind = 'note'
      ))
      or (kind = 'mail_thread' and task_id is null and page_id is null and mail_share_id in (select private.my_mail_share_ids()))
    )
  );

grant insert (kind, task_id, page_id, mail_share_id, created_by) on crm.chat_conversations to authenticated;

create or replace function private.chat_subject_open_to(p_conversation uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from crm.chat_conversations c
    join crm.tasks t on t.id = c.task_id
    join crm.workspace_members wm on wm.workspace_id = t.workspace_id and wm.user_id = p_user
    where c.id = p_conversation and c.kind = 'task'
      and (
        t.owner_id = p_user
        or t.created_by_user_id = p_user
        or wm.role in ('owner', 'admin')
        or exists (select 1 from crm.task_participants tp where tp.task_id = t.id and tp.user_id = p_user)
      )
  ) or exists (
    select 1
    from crm.chat_conversations c
    join crm.pages p on p.id = c.page_id
    join crm.workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = p_user
    where c.id = p_conversation and c.kind = 'doc' and p.effective_shared and p.kind = 'note'
  ) or exists (
    select 1
    from crm.chat_conversations c
    where c.id = p_conversation and c.kind = 'mail_thread' and private.mail_share_open_to(c.mail_share_id, p_user)
  )
$$;

revoke all on function private.chat_subject_open_to(uuid, uuid) from public;

create or replace function private.chat_subject_followers(p_user uuid, p_root uuid)
returns table (user_id uuid, last_read_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.user_id, t.last_read_at
  from crm.chat_messages r
  join crm.chat_conversations c on c.id = r.conversation_id and c.kind in ('task', 'doc', 'mail_thread')
  join crm.chat_thread_reads t on t.message_id = r.id
  where r.id = p_root and r.parent_id is null
    and private.chat_subject_open_to(c.id, p_user)
    and private.chat_subject_open_to(c.id, t.user_id)
$$;

revoke all on function private.chat_subject_followers(uuid, uuid) from public;
grant execute on function private.chat_subject_followers(uuid, uuid) to crm_app;

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
          and (
            t.owner_id = u.id
            or t.created_by_user_id = u.id
            or wm.role in ('owner', 'admin')
            or exists (select 1 from crm.task_participants tp where tp.task_id = t.id and tp.user_id = u.id)
          )
      )
      when 'doc' then exists (
        select 1 from crm.pages p
        join crm.workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = u.id
        where p.id = v_conversation.page_id and p.effective_shared and p.kind = 'note'
      )
      when 'mail_thread' then private.mail_share_open_to(v_conversation.mail_share_id, u.id)
      else exists (select 1 from crm.chat_members cm where cm.conversation_id = v_conversation.id and cm.user_id = u.id)
    end
  on conflict (message_id, user_id) do nothing;
end;
$$;

revoke all on function private.chat_follow(uuid, uuid[], timestamptz) from public;

reset lock_timeout;
