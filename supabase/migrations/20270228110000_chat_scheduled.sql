set lock_timeout = '5s';

create table if not exists crm.chat_scheduled (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references crm.profiles (id) on delete cascade,
  conversation_id uuid not null references crm.chat_conversations (id) on delete cascade,
  parent_id uuid references crm.chat_messages (id) on delete cascade,
  body text not null default '',
  format text not null default 'markdown',
  attachment_ids uuid[] not null default '{}',
  send_at timestamptz not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  claim_token uuid,
  claimed_at timestamptz,
  failure text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint chat_scheduled_status_check check (status in ('pending', 'sending', 'failed')),
  constraint chat_scheduled_format_check check (format in ('plain', 'markdown')),
  constraint chat_scheduled_body_check check (char_length(body) <= 10000),
  constraint chat_scheduled_content_check check (length(btrim(body, E' \t\n')) > 0 or cardinality(attachment_ids) > 0),
  constraint chat_scheduled_files_check check (cardinality(attachment_ids) <= 10),
  constraint chat_scheduled_failure_check check (failure is null or char_length(failure) <= 300)
);

create index if not exists chat_scheduled_user_idx on crm.chat_scheduled (user_id, send_at, id);
create index if not exists chat_scheduled_due_idx on crm.chat_scheduled (send_at, id) where status <> 'failed';
create index if not exists chat_scheduled_failed_idx on crm.chat_scheduled (updated_at) where status = 'failed';
create index if not exists chat_scheduled_conversation_idx on crm.chat_scheduled (conversation_id);
create index if not exists chat_scheduled_parent_idx on crm.chat_scheduled (parent_id) where parent_id is not null;
create index if not exists chat_attachments_scheduled_idx on crm.chat_attachments (scheduled_id) where scheduled_id is not null;

alter table crm.chat_scheduled enable row level security;
alter table crm.chat_scheduled force row level security;

drop policy if exists chat_scheduled_select on crm.chat_scheduled;
create policy chat_scheduled_select on crm.chat_scheduled
  for select to authenticated
  using (user_id = (select private.session_user_id()));

revoke all on crm.chat_scheduled from anon, authenticated, crm_agent;
grant select on crm.chat_scheduled to authenticated;

create or replace function private.chat_scheduled_files_gone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from crm.chat_attachments a where a.scheduled_id = old.id and a.message_id is null;
  return old;
end;
$$;

revoke all on function private.chat_scheduled_files_gone() from public;

drop trigger if exists chat_scheduled_files_gone on crm.chat_scheduled;
create trigger chat_scheduled_files_gone
  before delete on crm.chat_scheduled
  for each row execute function private.chat_scheduled_files_gone();

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
  if new.author_user_id is null or new.via_hook_id is not null or new.via_workflow_id is not null or new.kind = 'event' then
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
      and (
        a.scheduled_id is null
        or (
          a.scheduled_id::text = new.client_key
          and exists (
            select 1 from crm.chat_scheduled s
            where s.id = a.scheduled_id and s.user_id = new.author_user_id and s.status = 'sending'
          )
        )
      );
  if v_valid <> cardinality(v_ids) then
    raise exception 'A file has expired. Attach it again.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.chat_message_claim() from public;

create or replace function private.chat_schedule_create(
  p_user uuid,
  p_id uuid,
  p_conversation uuid,
  p_parent uuid,
  p_body text,
  p_format text,
  p_attachments uuid[],
  p_send_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing crm.chat_scheduled;
  v_kind text;
  v_archived timestamptz;
  v_ids uuid[];
  v_valid integer;
begin
  if p_user is null or p_id is null or p_conversation is null then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('chat-scheduled:' || p_user::text, 0));
  select s.* into v_existing from crm.chat_scheduled s where s.id = p_id;
  if v_existing.id is not null then
    if v_existing.user_id <> p_user then
      raise exception 'That schedule key was already used for another message.' using errcode = '22023';
    end if;
    return false;
  end if;
  if not private.chat_attachment_open_to(p_conversation, p_user) then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  select c.kind, c.archived_at into v_kind, v_archived from crm.chat_conversations c where c.id = p_conversation;
  if v_kind not in ('room', 'dm') then
    raise exception 'Only rooms and direct messages can send later.' using errcode = '22023';
  end if;
  if v_archived is not null then
    raise exception 'This room is archived.' using errcode = '22023';
  end if;
  if p_parent is not null and not exists (
    select 1 from crm.chat_messages m
    where m.id = p_parent and m.conversation_id = p_conversation and m.parent_id is null and m.kind = 'message' and m.deleted_at is null
  ) then
    raise exception 'The thread was deleted.' using errcode = '22023';
  end if;
  if p_send_at is null or p_send_at <= now() then
    raise exception 'Pick a time in the future.' using errcode = '22023';
  end if;
  if p_send_at > now() + interval '1 year' then
    raise exception 'Pick a time within the next year.' using errcode = '22023';
  end if;
  if (select count(*) from crm.chat_scheduled s where s.user_id = p_user) >= 100 then
    raise exception 'You have 100 scheduled messages. Send or cancel some first.' using errcode = '22023';
  end if;
  select coalesce(array_agg(u.x order by u.first), '{}') into v_ids
    from (
      select t.x, min(t.ord) as first
      from unnest(coalesce(p_attachments, '{}')) with ordinality as t(x, ord)
      where t.x is not null
      group by t.x
    ) u;
  if cardinality(v_ids) > 10 then
    raise exception 'Attach up to 10 files to a message.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_body, ''), E' \t\n')) = 0 and cardinality(v_ids) = 0 then
    raise exception 'Write a message first.' using errcode = '22023';
  end if;
  perform 1 from crm.chat_attachments a where a.id = any(v_ids) order by a.id for update;
  select count(*) into v_valid
    from crm.chat_attachments a
    where a.id = any(v_ids)
      and a.uploaded_by = p_user
      and a.conversation_id = p_conversation
      and a.message_id is null
      and a.scheduled_id is null;
  if v_valid <> cardinality(v_ids) then
    raise exception 'A file has expired. Attach it again.' using errcode = '22023';
  end if;
  insert into crm.chat_scheduled (id, user_id, conversation_id, parent_id, body, format, attachment_ids, send_at)
    values (p_id, p_user, p_conversation, p_parent, coalesce(p_body, ''), coalesce(p_format, 'markdown'), v_ids, p_send_at);
  update crm.chat_attachments a set scheduled_id = p_id where a.id = any(v_ids);
  return true;
end;
$$;

revoke all on function private.chat_schedule_create(uuid, uuid, uuid, uuid, text, text, uuid[], timestamptz) from public;
grant execute on function private.chat_schedule_create(uuid, uuid, uuid, uuid, text, text, uuid[], timestamptz) to crm_app;

create or replace function private.chat_schedule_update(
  p_user uuid,
  p_id uuid,
  p_body text,
  p_format text,
  p_send_at timestamptz,
  p_remove uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row crm.chat_scheduled;
  v_body text;
  v_keep uuid[];
begin
  select s.* into v_row from crm.chat_scheduled s where s.id = p_id and s.user_id = p_user for update;
  if v_row.id is null then
    raise exception 'That message is no longer scheduled.' using errcode = 'P0002';
  end if;
  if v_row.status = 'sending' and v_row.claimed_at > clock_timestamp() - interval '6 minutes' then
    raise exception 'That message is being sent now.' using errcode = '22023';
  end if;
  if not private.chat_attachment_open_to(v_row.conversation_id, p_user) then
    raise exception 'You''re no longer in that conversation.' using errcode = 'P0002';
  end if;
  if exists (select 1 from crm.chat_conversations c where c.id = v_row.conversation_id and c.archived_at is not null) then
    raise exception 'This room is archived.' using errcode = '22023';
  end if;
  if p_send_at is not null then
    if p_send_at <= now() then
      raise exception 'Pick a time in the future.' using errcode = '22023';
    end if;
    if p_send_at > now() + interval '1 year' then
      raise exception 'Pick a time within the next year.' using errcode = '22023';
    end if;
  end if;
  v_body := coalesce(p_body, v_row.body);
  select coalesce(array_agg(t.x order by t.ord), '{}') into v_keep
    from unnest(v_row.attachment_ids) with ordinality as t(x, ord)
    where not (t.x = any(coalesce(p_remove, '{}')));
  if length(btrim(v_body, E' \t\n')) = 0 and cardinality(v_keep) = 0 then
    raise exception 'Cancel the scheduled message instead.' using errcode = '22023';
  end if;
  delete from crm.chat_attachments a
    where a.scheduled_id = p_id and a.message_id is null and not (a.id = any(v_keep));
  update crm.chat_scheduled s
    set body = v_body,
        format = coalesce(p_format, s.format),
        attachment_ids = v_keep,
        send_at = coalesce(p_send_at, s.send_at),
        status = 'pending',
        attempts = 0,
        claim_token = null,
        claimed_at = null,
        failure = null,
        updated_at = clock_timestamp()
    where s.id = p_id;
end;
$$;

revoke all on function private.chat_schedule_update(uuid, uuid, text, text, timestamptz, uuid[]) from public;
grant execute on function private.chat_schedule_update(uuid, uuid, text, text, timestamptz, uuid[]) to crm_app;

create or replace function private.chat_schedule_cancel(p_user uuid, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row crm.chat_scheduled;
begin
  select s.* into v_row from crm.chat_scheduled s where s.id = p_id and s.user_id = p_user for update;
  if v_row.id is null then
    return false;
  end if;
  if v_row.status = 'sending' and v_row.claimed_at > clock_timestamp() - interval '6 minutes' then
    raise exception 'That message is being sent now.' using errcode = '22023';
  end if;
  delete from crm.chat_scheduled s where s.id = p_id;
  return true;
end;
$$;

revoke all on function private.chat_schedule_cancel(uuid, uuid) from public;
grant execute on function private.chat_schedule_cancel(uuid, uuid) to crm_app;

create or replace function private.chat_schedule_claim_due(p_skip uuid[])
returns table (id uuid, user_id uuid, conversation_id uuid, parent_id uuid, body text, format text, attachment_ids uuid[], attempts integer, claim_token uuid)
language sql
security definer
set search_path = ''
as $$
  update crm.chat_scheduled s
    set status = 'sending', claimed_at = clock_timestamp(), claim_token = gen_random_uuid(), attempts = s.attempts + 1, updated_at = clock_timestamp()
    where s.id = (
      select x.id from crm.chat_scheduled x
      where x.send_at <= now() and not (x.id = any(coalesce(p_skip, '{}')))
        and (x.status = 'pending' or (x.status = 'sending' and x.claimed_at <= clock_timestamp() - interval '6 minutes'))
      order by x.send_at, x.id
      limit 1
      for update skip locked
    )
    returning s.id, s.user_id, s.conversation_id, s.parent_id, s.body, s.format, s.attachment_ids, s.attempts, s.claim_token
$$;

revoke all on function private.chat_schedule_claim_due(uuid[]) from public;
grant execute on function private.chat_schedule_claim_due(uuid[]) to crm_app;

create or replace function private.chat_schedule_claim_now(p_user uuid, p_id uuid)
returns table (id uuid, user_id uuid, conversation_id uuid, parent_id uuid, body text, format text, attachment_ids uuid[], attempts integer, claim_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row crm.chat_scheduled;
begin
  select s.* into v_row from crm.chat_scheduled s where s.id = p_id and s.user_id = p_user for update;
  if v_row.id is null then
    raise exception 'That message is no longer scheduled.' using errcode = 'P0002';
  end if;
  if v_row.status = 'sending' and v_row.claimed_at > clock_timestamp() - interval '6 minutes' then
    raise exception 'That message is being sent now.' using errcode = '22023';
  end if;
  return query
    update crm.chat_scheduled s
      set status = 'sending', claimed_at = clock_timestamp(), claim_token = gen_random_uuid(), attempts = 1, failure = null, updated_at = clock_timestamp()
      where s.id = p_id
      returning s.id, s.user_id, s.conversation_id, s.parent_id, s.body, s.format, s.attachment_ids, s.attempts, s.claim_token;
end;
$$;

revoke all on function private.chat_schedule_claim_now(uuid, uuid) from public;
grant execute on function private.chat_schedule_claim_now(uuid, uuid) to crm_app;

create or replace function private.chat_schedule_done(p_id uuid, p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from crm.chat_scheduled s where s.id = p_id and s.claim_token = p_token and s.status = 'sending';
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function private.chat_schedule_done(uuid, uuid) from public;
grant execute on function private.chat_schedule_done(uuid, uuid) to crm_app;

create or replace function private.chat_schedule_posted(p_id uuid, p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from crm.chat_scheduled s
    join crm.chat_messages m on m.author_user_id = s.user_id and m.client_key = s.id::text
    where s.id = p_id and s.claim_token = p_token and s.status = 'sending'
  ) then
    return false;
  end if;
  delete from crm.chat_scheduled s where s.id = p_id and s.claim_token = p_token and s.status = 'sending';
  return true;
end;
$$;

revoke all on function private.chat_schedule_posted(uuid, uuid) from public;
grant execute on function private.chat_schedule_posted(uuid, uuid) to crm_app;

create or replace function private.chat_schedule_release(p_id uuid, p_token uuid, p_failure text)
returns table (user_id uuid, failed boolean, failure text)
language sql
security definer
set search_path = ''
as $$
  update crm.chat_scheduled s
    set status = case when p_failure is not null or s.attempts >= 5 then 'failed' else 'pending' end,
        failure = case
          when p_failure is not null then left(p_failure, 300)
          when s.attempts >= 5 then 'Couldn''t send. Try again.'
          else null
        end,
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where s.id = p_id and s.claim_token = p_token and s.status = 'sending'
    returning s.user_id, s.status = 'failed', s.failure
$$;

revoke all on function private.chat_schedule_release(uuid, uuid, text) from public;
grant execute on function private.chat_schedule_release(uuid, uuid, text) to crm_app;

create or replace function private.chat_sweep_scheduled(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from crm.chat_scheduled s
  where s.id in (
    select x.id from crm.chat_scheduled x
    where x.status = 'failed' and x.updated_at < now() - interval '30 days'
    order by x.updated_at
    limit greatest(1, least(coalesce(p_limit, 200), 500))
    for update skip locked
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.chat_sweep_scheduled(integer) from public;
grant execute on function private.chat_sweep_scheduled(integer) to crm_app;

reset lock_timeout;
