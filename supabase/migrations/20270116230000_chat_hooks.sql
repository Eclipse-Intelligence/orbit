set lock_timeout = '5s';

create table if not exists crm.chat_hooks (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references crm.chat_conversations (id) on delete cascade,
  name text not null,
  secret_hash text not null,
  created_by uuid references crm.profiles (id) on delete set null,
  paused_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint chat_hooks_name_check check (length(btrim(name)) between 1 and 80),
  constraint chat_hooks_secret_hash_check check (secret_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists chat_hooks_conversation_idx on crm.chat_hooks (conversation_id, created_at);

alter table crm.chat_hooks enable row level security;
alter table crm.chat_hooks force row level security;

alter table crm.chat_messages add column if not exists via_hook_id uuid references crm.chat_hooks (id) on delete set null;
alter table crm.chat_messages add column if not exists hook jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_hook_check' and conrelid = 'crm.chat_messages'::regclass) then
    alter table crm.chat_messages add constraint chat_messages_hook_check check (
      (hook is null and via_hook_id is null)
      or (hook is not null and jsonb_typeof(hook) = 'object' and author_user_id is null and parent_id is null and cardinality(mentions) = 0)
    );
  end if;
end;
$$;

create unique index if not exists chat_messages_hook_client_key_idx on crm.chat_messages (via_hook_id, client_key) where via_hook_id is not null;

drop policy if exists chat_hooks_select on crm.chat_hooks;
create policy chat_hooks_select on crm.chat_hooks
  for select to authenticated
  using (
    conversation_id in (select private.my_chat_ids())
    and exists (select 1 from crm.chat_conversations c where c.id = chat_hooks.conversation_id and c.kind = 'room' and c.archived_at is null)
  );

drop policy if exists chat_hooks_insert on crm.chat_hooks;
create policy chat_hooks_insert on crm.chat_hooks
  for insert to authenticated
  with check (
    created_by = (select private.session_user_id())
    and conversation_id in (select private.my_chat_ids())
    and exists (select 1 from crm.chat_conversations c where c.id = chat_hooks.conversation_id and c.kind = 'room' and c.archived_at is null)
  );

drop policy if exists chat_hooks_update on crm.chat_hooks;
create policy chat_hooks_update on crm.chat_hooks
  for update to authenticated
  using (conversation_id in (select private.my_chat_ids()))
  with check (
    conversation_id in (select private.my_chat_ids())
    and exists (select 1 from crm.chat_conversations c where c.id = chat_hooks.conversation_id and c.kind = 'room' and c.archived_at is null)
  );

drop policy if exists chat_hooks_delete on crm.chat_hooks;
create policy chat_hooks_delete on crm.chat_hooks
  for delete to authenticated
  using (conversation_id in (select private.my_chat_ids()));

revoke all on crm.chat_hooks from anon, authenticated, crm_agent;
grant select (id, conversation_id, name, created_by, paused_at, last_used_at, created_at) on crm.chat_hooks to authenticated;
grant insert (conversation_id, name, secret_hash, created_by) on crm.chat_hooks to authenticated;
grant update (secret_hash, paused_at) on crm.chat_hooks to authenticated;
grant delete on crm.chat_hooks to authenticated;

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
    join crm.chat_conversations c on c.id = h.conversation_id and c.kind = 'room' and c.archived_at is null
    where h.id = p_hook;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::text, null::text, null::jsonb, null::timestamptz, false, null::uuid[];
    return;
  end if;
  if p_secret_hash is null or v_hook.secret_hash <> p_secret_hash then
    return query select 'unauthorised'::text, null::uuid, null::uuid, null::text, null::text, null::jsonb, null::timestamptz, false, null::uuid[];
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
    when h.paused_at is not null then 'paused'
    else 'ok'
  end
  from (select 1) one
  left join lateral (
    select x.id, x.secret_hash, x.paused_at
    from crm.chat_hooks x
    join crm.chat_conversations c on c.id = x.conversation_id and c.kind = 'room' and c.archived_at is null
    where x.id = p_hook
  ) h on true
$$;

revoke all on function private.chat_hook_auth(uuid, text) from public;
grant execute on function private.chat_hook_auth(uuid, text) to crm_app;

create or replace function private.chat_delete_hook_message(p_user uuid, p_message uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation uuid;
begin
  select m.conversation_id into v_conversation
    from crm.chat_messages m
    join crm.chat_conversations c on c.id = m.conversation_id and c.kind = 'room' and c.archived_at is null
    where m.id = p_message and m.hook is not null and m.deleted_at is null
      and exists (select 1 from crm.chat_members cm where cm.conversation_id = m.conversation_id and cm.user_id = p_user)
    for update of m;
  if v_conversation is null then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  update crm.chat_messages m set deleted_at = now() where m.id = p_message;
  return v_conversation;
end;
$$;

revoke all on function private.chat_delete_hook_message(uuid, uuid) from public;
grant execute on function private.chat_delete_hook_message(uuid, uuid) to crm_app;

reset lock_timeout;
