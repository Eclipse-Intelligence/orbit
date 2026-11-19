set lock_timeout = '5s';

create table if not exists private.storage_tombstones (
  bucket text not null,
  path text not null,
  created_at timestamptz not null default now(),
  primary key (bucket, path)
);

create index if not exists storage_tombstones_created_idx on private.storage_tombstones (created_at);

alter table private.storage_tombstones enable row level security;
alter table private.storage_tombstones force row level security;
revoke all on private.storage_tombstones from public, anon, authenticated, crm_agent;

do $$
begin
  execute 'drop policy if exists storage_tombstones_definer on private.storage_tombstones';
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    execute format('create policy storage_tombstones_definer on private.storage_tombstones for all to %I using (true) with check (true)', current_user);
  end if;
end;
$$;

create table if not exists crm.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references crm.chat_conversations (id) on delete cascade,
  message_id uuid references crm.chat_messages (id) on delete cascade,
  scheduled_id uuid,
  uploaded_by uuid references crm.profiles (id) on delete set null,
  name text not null,
  content_type text not null default 'application/octet-stream',
  size integer not null,
  width integer,
  height integer,
  created_at timestamptz not null default now(),
  constraint chat_attachments_name_check check (char_length(name) between 1 and 200),
  constraint chat_attachments_type_check check (char_length(content_type) between 1 and 200),
  constraint chat_attachments_size_check check (size between 1 and 26214400),
  constraint chat_attachments_width_check check (width is null or width between 1 and 100000),
  constraint chat_attachments_height_check check (height is null or height between 1 and 100000)
);

create index if not exists chat_attachments_message_idx on crm.chat_attachments (message_id) where message_id is not null;
create index if not exists chat_attachments_conversation_idx on crm.chat_attachments (conversation_id);
create index if not exists chat_attachments_pending_idx on crm.chat_attachments (uploaded_by, created_at) where message_id is null;
create index if not exists chat_attachments_stale_idx on crm.chat_attachments (created_at) where message_id is null and scheduled_id is null;

alter table crm.chat_attachments enable row level security;
alter table crm.chat_attachments force row level security;

drop policy if exists chat_attachments_select on crm.chat_attachments;
create policy chat_attachments_select on crm.chat_attachments
  for select to authenticated
  using (
    (message_id is null and uploaded_by = (select private.session_user_id()))
    or (message_id is not null and exists (select 1 from crm.chat_messages m where m.id = chat_attachments.message_id and m.deleted_at is null))
  );

revoke all on crm.chat_attachments from anon, authenticated, crm_agent;
grant select on crm.chat_attachments to authenticated;

alter table crm.chat_messages add column if not exists attachment_ids uuid[] not null default '{}';
alter table crm.chat_messages add column if not exists attachment_count integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_attachment_count_check' and conrelid = 'crm.chat_messages'::regclass) then
    alter table crm.chat_messages add constraint chat_messages_attachment_count_check check (attachment_count between 0 and 10) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'chat_messages_body_present' and conrelid = 'crm.chat_messages'::regclass
      and pg_get_constraintdef(oid) like '%attachment_count%'
  ) then
    alter table crm.chat_messages drop constraint if exists chat_messages_body_present;
    alter table crm.chat_messages add constraint chat_messages_body_present
      check (deleted_at is not null or length(btrim(body, E' \t\n')) > 0 or attachment_count > 0) not valid;
  end if;
end;
$$;

alter table crm.chat_messages validate constraint chat_messages_attachment_count_check;
alter table crm.chat_messages validate constraint chat_messages_body_present;

grant insert (attachment_ids) on crm.chat_messages to authenticated;

create or replace function private.chat_attachment_key(p_conversation uuid, p_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'team-chat/' || p_conversation::text || '/' || p_id::text
$$;

revoke all on function private.chat_attachment_key(uuid, uuid) from public;

create or replace function private.chat_attachment_open_to(p_conversation uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.chat_conversations c
    where c.id = p_conversation and c.archived_at is null
      and (
        (c.kind in ('room', 'dm') and exists (select 1 from crm.chat_members m where m.conversation_id = c.id and m.user_id = p_user))
        or (c.kind in ('task', 'doc', 'mail_thread') and private.chat_subject_open_to(c.id, p_user))
      )
  )
$$;

revoke all on function private.chat_attachment_open_to(uuid, uuid) from public;

create or replace function private.chat_attachment_tombstone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.storage_tombstones (bucket, path)
    values ('email-attachments', private.chat_attachment_key(old.conversation_id, old.id))
    on conflict (bucket, path) do nothing;
  return old;
end;
$$;

revoke all on function private.chat_attachment_tombstone() from public;

drop trigger if exists chat_attachments_tombstone on crm.chat_attachments;
create trigger chat_attachments_tombstone
  before delete on crm.chat_attachments
  for each row execute function private.chat_attachment_tombstone();

create or replace function private.chat_prepare_attachments(p_user uuid, p_conversation uuid, p_files jsonb)
returns table (id uuid, name text, content_type text, size integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_count integer := case when jsonb_typeof(p_files) = 'array' then jsonb_array_length(p_files) else 0 end;
begin
  if p_user is null or not private.chat_attachment_open_to(p_conversation, p_user) then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  if v_count < 1 then
    raise exception 'Choose a file to attach.' using errcode = '22023';
  end if;
  if v_count > 10 then
    raise exception 'Attach up to 10 files to a message.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('chat-uploads:' || p_user::text, 0));
  if (select count(*) from crm.chat_attachments a where a.uploaded_by = p_user and a.message_id is null and a.scheduled_id is null) + v_count > 50 then
    raise exception 'Too many files are waiting to send. Send or remove some first.' using errcode = '22023';
  end if;
  return query
    insert into crm.chat_attachments as a (conversation_id, uploaded_by, name, content_type, size, width, height)
    select p_conversation, p_user, f.name, f.content_type, f.size, f.width, f.height
    from rows from (jsonb_to_recordset(p_files) as (name text, content_type text, size integer, width integer, height integer)) with ordinality as f(name, content_type, size, width, height, ord)
    order by f.ord
    returning a.id, a.name, a.content_type, a.size;
end;
$$;

revoke all on function private.chat_prepare_attachments(uuid, uuid, jsonb) from public;
grant execute on function private.chat_prepare_attachments(uuid, uuid, jsonb) to crm_app;

create or replace function private.chat_discard_attachments(p_user uuid, p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from crm.chat_attachments a
    where a.id = any(coalesce(p_ids, '{}')) and a.uploaded_by = p_user and a.message_id is null and a.scheduled_id is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.chat_discard_attachments(uuid, uuid[]) from public;
grant execute on function private.chat_discard_attachments(uuid, uuid[]) to crm_app;

create or replace function private.chat_message_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_valid integer;
begin
  select coalesce(array_agg(u.x order by u.first), '{}') into v_ids
    from (
      select t.x, min(t.ord) as first
      from unnest(coalesce(new.attachment_ids, '{}')) with ordinality as t(x, ord)
      where t.x is not null
      group by t.x
    ) u;
  new.attachment_ids := v_ids;
  new.attachment_count := cardinality(v_ids);
  if new.attachment_count = 0 then
    return new;
  end if;
  if new.attachment_count > 10 then
    raise exception 'Attach up to 10 files to a message.' using errcode = '22023';
  end if;
  if new.author_user_id is null or new.via_hook_id is not null or new.via_workflow_id is not null then
    raise exception 'Only people can attach files.' using errcode = '22023';
  end if;
  perform 1 from crm.chat_attachments a where a.id = any(v_ids) order by a.id for update;
  if new.client_key is not null and exists (
    select 1 from crm.chat_messages m where m.author_user_id = new.author_user_id and m.client_key = new.client_key
  ) then
    return null;
  end if;
  select count(*) into v_valid
    from crm.chat_attachments a
    where a.id = any(v_ids)
      and a.uploaded_by = new.author_user_id
      and a.conversation_id = new.conversation_id
      and a.message_id is null
      and (a.scheduled_id is null or a.scheduled_id::text = new.client_key);
  if v_valid <> cardinality(v_ids) then
    raise exception 'A file has expired. Attach it again.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.chat_message_claim() from public;

drop trigger if exists chat_messages_claim on crm.chat_messages;
create trigger chat_messages_claim
  before insert on crm.chat_messages
  for each row execute function private.chat_message_claim();

create or replace function private.chat_message_attach()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update crm.chat_attachments a set message_id = new.id where a.id = any(new.attachment_ids) and a.message_id is null;
  return null;
end;
$$;

revoke all on function private.chat_message_attach() from public;

drop trigger if exists chat_messages_attach on crm.chat_messages;
create trigger chat_messages_attach
  after insert on crm.chat_messages
  for each row when (new.attachment_count > 0) execute function private.chat_message_attach();

create or replace function private.chat_message_files_gone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from crm.chat_attachments a where a.message_id = new.id;
    new.attachment_ids := '{}';
    new.attachment_count := 0;
  end if;
  return new;
end;
$$;

revoke all on function private.chat_message_files_gone() from public;

drop trigger if exists chat_messages_files_gone on crm.chat_messages;
create trigger chat_messages_files_gone
  before update of deleted_at on crm.chat_messages
  for each row when (old.attachment_count > 0) execute function private.chat_message_files_gone();

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
  select coalesce(array_agg(t.x order by t.ord), '{}') into v_keep
    from unnest(v_message.attachment_ids) with ordinality as t(x, ord)
    where not (t.x = any(coalesce(p_ids, '{}')));
  if cardinality(v_keep) = cardinality(v_message.attachment_ids) then
    return v_message.attachment_count;
  end if;
  if cardinality(v_keep) = 0 and length(btrim(v_message.body, E' \t\n')) = 0 then
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

create or replace function private.chat_sweep_attachments(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from crm.chat_attachments a
  where a.message_id is null and a.scheduled_id is null
    and a.id in (
      select s.id from crm.chat_attachments s
      where s.message_id is null and s.scheduled_id is null and s.created_at < now() - interval '1 day'
      order by s.created_at
      limit greatest(1, least(coalesce(p_limit, 200), 500))
      for update skip locked
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.chat_sweep_attachments(integer) from public;
grant execute on function private.chat_sweep_attachments(integer) to crm_app;

create or replace function private.storage_tombstones_due(p_limit integer)
returns table (bucket text, path text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.bucket, t.path from private.storage_tombstones t
  order by t.created_at, t.path
  limit greatest(1, least(coalesce(p_limit, 500), 1000))
$$;

revoke all on function private.storage_tombstones_due(integer) from public;
grant execute on function private.storage_tombstones_due(integer) to crm_app;

create or replace function private.storage_tombstones_done(p_bucket text, p_paths text[])
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.storage_tombstones t where t.bucket = p_bucket and t.path = any(coalesce(p_paths, '{}'))
$$;

revoke all on function private.storage_tombstones_done(text, text[]) from public;
grant execute on function private.storage_tombstones_done(text, text[]) to crm_app;

reset lock_timeout;
