create table if not exists crm.agent_mailboxes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references crm.workspaces (id) on delete cascade,
  address text not null,
  display_name text not null default 'Orbit',
  webhook_id text,
  webhook_secret text,
  webhook_url text,
  set_up_by uuid references crm.profiles (id) on delete set null,
  set_up_at timestamptz,
  last_received_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_mailboxes_address check (address = lower(address) and address ~ '^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,}$'),
  constraint agent_mailboxes_display_name check (char_length(display_name) between 1 and 120),
  constraint agent_mailboxes_error_length check (last_error is null or char_length(last_error) <= 1000)
);

create unique index if not exists agent_mailboxes_address_idx on crm.agent_mailboxes (address);

create table if not exists crm.agent_mailbox_senders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  mailbox_id uuid not null references crm.agent_mailboxes (id) on delete cascade,
  address text not null,
  user_id uuid not null,
  created_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint agent_mailbox_senders_member foreign key (workspace_id, user_id)
    references crm.workspace_members (workspace_id, user_id) on delete cascade,
  constraint agent_mailbox_senders_address check (address = lower(address) and address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(address) <= 320),
  constraint agent_mailbox_senders_unique unique (workspace_id, address)
);

create index if not exists agent_mailbox_senders_user_idx on crm.agent_mailbox_senders (user_id);
create index if not exists agent_mailbox_senders_mailbox_idx on crm.agent_mailbox_senders (mailbox_id);

create table if not exists crm.agent_mail_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  mailbox_id uuid not null references crm.agent_mailboxes (id) on delete cascade,
  inbox_id text not null,
  message_id text not null,
  thread_id text,
  event_id text,
  event_type text,
  direction text not null default 'inbound',
  from_address text,
  from_name text,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text,
  received_at timestamptz not null default now(),
  text text,
  text_cleaned boolean not null default true,
  trust_level text,
  authentication jsonb,
  attachments jsonb not null default '[]'::jsonb,
  user_id uuid references crm.profiles (id) on delete set null,
  conversation_id uuid references crm.assistant_conversations (id) on delete set null,
  user_message_id uuid references crm.assistant_messages (id) on delete set null,
  status text not null default 'received',
  status_reason text,
  confirm_message_id uuid references crm.assistant_messages (id) on delete set null,
  confirm_action_ids text[],
  turn_started_at timestamptz,
  rounds integer not null default 0,
  notice_sent_at timestamptz,
  reply_claimed_at timestamptz,
  reply_attempts integer not null default 0,
  replied_at timestamptz,
  reply_message_id text,
  advancing_until timestamptz,
  error text,
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(from_name, '') || ' ' || coalesce(from_address, '')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(text, ''), 200000)), 'C')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_mail_messages_direction check (direction in ('inbound', 'outbound')),
  constraint agent_mail_messages_status check (status in ('received', 'ignored', 'refused', 'working', 'replied', 'superseded', 'failed', 'sent')),
  constraint agent_mail_messages_attachments_array check (jsonb_typeof(attachments) = 'array'),
  constraint agent_mail_messages_text_length check (text is null or char_length(text) <= 1000000),
  constraint agent_mail_messages_subject_length check (subject is null or char_length(subject) <= 2000),
  constraint agent_mail_messages_reason_length check (status_reason is null or char_length(status_reason) <= 1000),
  constraint agent_mail_messages_error_length check (error is null or char_length(error) <= 2000),
  constraint agent_mail_messages_unique unique (mailbox_id, message_id)
);

create index if not exists agent_mail_messages_thread_idx on crm.agent_mail_messages (mailbox_id, thread_id, received_at);
create index if not exists agent_mail_messages_user_idx on crm.agent_mail_messages (user_id, received_at desc);
create index if not exists agent_mail_messages_workspace_idx on crm.agent_mail_messages (workspace_id, received_at desc);
create index if not exists agent_mail_messages_conversation_idx on crm.agent_mail_messages (conversation_id);
drop index if exists crm.agent_mail_messages_working_idx;
create index if not exists agent_mail_messages_open_idx on crm.agent_mail_messages (updated_at)
  where status in ('working', 'received') and replied_at is null;
create index if not exists agent_mail_messages_search_idx on crm.agent_mail_messages using gin (search);

create table if not exists crm.agent_mail_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  mailbox_id uuid not null references crm.agent_mailboxes (id) on delete cascade,
  thread_id text not null,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  conversation_id uuid not null references crm.assistant_conversations (id) on delete cascade,
  rounds integer not null default 0,
  created_at timestamptz not null default now(),
  constraint agent_mail_threads_unique unique (mailbox_id, thread_id, user_id)
);

create index if not exists agent_mail_threads_conversation_idx on crm.agent_mail_threads (conversation_id);
create index if not exists agent_mail_threads_user_idx on crm.agent_mail_threads (user_id);

create table if not exists crm.agent_mail_events (
  event_id text primary key,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  received_at timestamptz not null default now(),
  constraint agent_mail_events_id_length check (char_length(event_id) between 1 and 200)
);

create index if not exists agent_mail_events_received_idx on crm.agent_mail_events (workspace_id, received_at);

alter table crm.agent_mail_messages add column if not exists text_cleaned boolean not null default true;
alter table crm.agent_mail_messages add column if not exists confirm_message_id uuid references crm.assistant_messages (id) on delete set null;
alter table crm.agent_mail_messages add column if not exists confirm_action_ids text[];
alter table crm.agent_mail_threads add column if not exists rounds integer not null default 0;

alter table crm.ai_companion_jobs add column if not exists agent_mail_id uuid references crm.agent_mail_messages (id) on delete set null;
create index if not exists ai_companion_jobs_agent_mail_idx on crm.ai_companion_jobs (agent_mail_id) where agent_mail_id is not null;

drop trigger if exists agent_mailboxes_set_updated_at on crm.agent_mailboxes;
create trigger agent_mailboxes_set_updated_at
  before update on crm.agent_mailboxes
  for each row execute function private.set_updated_at();

drop trigger if exists agent_mail_messages_set_updated_at on crm.agent_mail_messages;
create trigger agent_mail_messages_set_updated_at
  before update on crm.agent_mail_messages
  for each row execute function private.set_updated_at();

alter table crm.agent_mailboxes enable row level security;
alter table crm.agent_mailboxes force row level security;
alter table crm.agent_mailbox_senders enable row level security;
alter table crm.agent_mailbox_senders force row level security;
alter table crm.agent_mail_messages enable row level security;
alter table crm.agent_mail_messages force row level security;
alter table crm.agent_mail_threads enable row level security;
alter table crm.agent_mail_threads force row level security;
alter table crm.agent_mail_events enable row level security;
alter table crm.agent_mail_events force row level security;

drop policy if exists agent_mailboxes_read on crm.agent_mailboxes;
create policy agent_mailboxes_read on crm.agent_mailboxes
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

drop policy if exists agent_mailboxes_admin_insert on crm.agent_mailboxes;
create policy agent_mailboxes_admin_insert on crm.agent_mailboxes
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));

drop policy if exists agent_mailboxes_admin_update on crm.agent_mailboxes;
create policy agent_mailboxes_admin_update on crm.agent_mailboxes
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id))
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));

drop policy if exists agent_mailbox_senders_read on crm.agent_mailbox_senders;
create policy agent_mailbox_senders_read on crm.agent_mailbox_senders
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (user_id = (select private.session_user_id()) or private.is_workspace_admin(workspace_id))
  );

drop policy if exists agent_mailbox_senders_admin_write on crm.agent_mailbox_senders;
create policy agent_mailbox_senders_admin_write on crm.agent_mailbox_senders
  for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id))
  with check (
    workspace_id in (select private.user_workspace_ids())
    and private.is_workspace_admin(workspace_id)
    and mailbox_id in (select b.id from crm.agent_mailboxes b where b.workspace_id = agent_mailbox_senders.workspace_id)
  );

drop policy if exists agent_mail_messages_read on crm.agent_mail_messages;
create policy agent_mail_messages_read on crm.agent_mail_messages
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (user_id = (select private.session_user_id()) or private.is_workspace_admin(workspace_id))
  );

drop policy if exists agent_mail_messages_send on crm.agent_mail_messages;

drop policy if exists agent_mail_messages_own_update on crm.agent_mail_messages;
create policy agent_mail_messages_own_update on crm.agent_mail_messages
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and user_id = (select private.session_user_id()))
  with check (
    workspace_id in (select private.user_workspace_ids())
    and user_id = (select private.session_user_id())
    and (
      conversation_id is null
      or conversation_id in (select c.id from crm.assistant_conversations c where c.user_id = (select private.session_user_id()))
    )
  );

drop policy if exists agent_mail_threads_owner on crm.agent_mail_threads;
create policy agent_mail_threads_owner on crm.agent_mail_threads
  for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and user_id = (select private.session_user_id()))
  with check (
    workspace_id in (select private.user_workspace_ids())
    and user_id = (select private.session_user_id())
    and conversation_id in (select c.id from crm.assistant_conversations c where c.user_id = (select private.session_user_id()))
  );

revoke all on crm.agent_mailboxes from anon, authenticated, crm_agent;
revoke all on crm.agent_mailbox_senders from anon, authenticated, crm_agent;
revoke all on crm.agent_mail_messages from anon, authenticated, crm_agent;
revoke all on crm.agent_mail_threads from anon, authenticated, crm_agent;
revoke all on crm.agent_mail_events from anon, authenticated, crm_agent;

grant select (id, workspace_id, address, display_name, webhook_id, webhook_url, set_up_by, set_up_at, last_received_at, last_error, last_error_at, created_at, updated_at)
  on crm.agent_mailboxes to authenticated;
grant insert (workspace_id, address, display_name) on crm.agent_mailboxes to authenticated;
grant update (address, display_name, webhook_id, webhook_secret, webhook_url, set_up_by, set_up_at, last_error, last_error_at)
  on crm.agent_mailboxes to authenticated;

grant select, insert, delete on crm.agent_mailbox_senders to authenticated;
grant update (address, user_id) on crm.agent_mailbox_senders to authenticated;

grant select (
  id, workspace_id, mailbox_id, inbox_id, message_id, thread_id, event_id, event_type, direction, from_address, from_name,
  to_addresses, cc_addresses, subject, received_at, text, text_cleaned, trust_level, authentication, attachments, user_id, conversation_id,
  user_message_id, status, status_reason, confirm_message_id, confirm_action_ids, turn_started_at, rounds, notice_sent_at, reply_claimed_at,
  reply_attempts, replied_at, reply_message_id, advancing_until, error, search, created_at, updated_at
) on crm.agent_mail_messages to authenticated;
grant update (
  conversation_id, user_message_id, status, status_reason, confirm_message_id, confirm_action_ids, turn_started_at, rounds, notice_sent_at,
  reply_claimed_at, reply_attempts, replied_at, reply_message_id, advancing_until, error
) on crm.agent_mail_messages to authenticated;

grant select, insert, delete on crm.agent_mail_threads to authenticated;
grant update (rounds) on crm.agent_mail_threads to authenticated;

create or replace function private.agent_mailbox_targets()
returns table (mailbox_id uuid, workspace_id uuid, address text, webhook_secret text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select b.id, b.workspace_id, b.address, b.webhook_secret
  from crm.agent_mailboxes b
  where b.webhook_secret is not null;
end;
$$;

create or replace function private.agent_mail_receive(p_mailbox uuid, p_event_id text, p_message jsonb, p_actionable boolean, p_reason text)
returns table (id uuid, user_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mailbox crm.agent_mailboxes;
  v_from text := lower(trim(coalesce(p_message->>'from_address', '')));
  v_user uuid;
  v_status text;
  v_reason text;
  v_id uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_mailbox from crm.agent_mailboxes b where b.id = p_mailbox;
  if v_mailbox.id is null then
    return;
  end if;

  delete from crm.agent_mail_events e
  where e.workspace_id = v_mailbox.workspace_id and e.received_at < now() - interval '30 days';

  insert into crm.agent_mail_events (event_id, workspace_id)
  values (left(p_event_id, 200), v_mailbox.workspace_id)
  on conflict (event_id) do nothing;
  if not found then
    return;
  end if;

  select s.user_id into v_user
  from crm.agent_mailbox_senders s
  join crm.workspace_members m on m.workspace_id = s.workspace_id and m.user_id = s.user_id
  where s.workspace_id = v_mailbox.workspace_id and s.address = v_from;

  if v_user is null then
    v_status := 'ignored';
    v_reason := 'The sender is not on the list of who can give it work.';
  elsif not p_actionable then
    v_status := 'refused';
    v_reason := coalesce(nullif(left(p_reason, 1000), ''), 'Not acted on.');
  else
    v_status := 'received';
    v_reason := null;
  end if;

  insert into crm.agent_mail_messages (
    workspace_id, mailbox_id, inbox_id, message_id, thread_id, event_id, event_type, direction, from_address, from_name,
    to_addresses, cc_addresses, subject, received_at, text, text_cleaned, trust_level, authentication, attachments, user_id, status, status_reason
  )
  values (
    v_mailbox.workspace_id,
    v_mailbox.id,
    v_mailbox.address,
    left(p_message->>'message_id', 200),
    left(p_message->>'thread_id', 200),
    left(p_event_id, 200),
    left(p_message->>'event_type', 80),
    'inbound',
    nullif(v_from, ''),
    left(p_message->>'from_name', 300),
    coalesce(array(select left(value, 320) from jsonb_array_elements_text(coalesce(p_message->'to', '[]'::jsonb)) limit 100), '{}'),
    coalesce(array(select left(value, 320) from jsonb_array_elements_text(coalesce(p_message->'cc', '[]'::jsonb)) limit 100), '{}'),
    left(p_message->>'subject', 2000),
    coalesce((p_message->>'received_at')::timestamptz, now()),
    left(p_message->>'text', 1000000),
    coalesce((p_message->>'text_cleaned')::boolean, false),
    left(p_message->>'trust_level', 40),
    p_message->'authentication',
    coalesce(p_message->'attachments', '[]'::jsonb),
    case when v_status = 'received' then v_user else null end,
    v_status,
    v_reason
  )
  on conflict (mailbox_id, message_id) do nothing
  returning agent_mail_messages.id into v_id;

  update crm.agent_mailboxes set last_received_at = now() where crm.agent_mailboxes.id = v_mailbox.id;

  if v_id is null then
    return;
  end if;

  return query select v_id, case when v_status = 'received' then v_user else null end, v_status;
end;
$$;

create or replace function private.agent_mail_working(p_limit integer)
returns table (id uuid, workspace_id uuid, user_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select m.id, m.workspace_id, m.user_id, m.status
  from crm.agent_mail_messages m
  where m.status in ('working', 'received')
    and m.user_id is not null
    and m.replied_at is null
    and m.updated_at < now() - interval '1 minute'
    and (m.advancing_until is null or m.advancing_until < now())
  order by m.updated_at
  limit greatest(1, least(p_limit, 50));
end;
$$;

create or replace function private.agent_mailbox_note_error(p_mailbox uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.agent_mailboxes
  set last_error = nullif(left(p_error, 1000), ''), last_error_at = case when nullif(p_error, '') is null then null else now() end
  where id = p_mailbox;
end;
$$;

create or replace function private.agent_mail_record_sent(
  p_mailbox uuid, p_user uuid, p_message_id text, p_thread_id text, p_to text[], p_cc text[], p_subject text, p_text text, p_sent_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mailbox crm.agent_mailboxes;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_mailbox from crm.agent_mailboxes b where b.id = p_mailbox;
  if v_mailbox.id is null then
    return;
  end if;
  if not exists (select 1 from crm.workspace_members m where m.workspace_id = v_mailbox.workspace_id and m.user_id = p_user) then
    raise exception 'They are not in this workspace.' using errcode = '42501';
  end if;
  insert into crm.agent_mail_messages (
    workspace_id, mailbox_id, inbox_id, message_id, thread_id, direction, from_address, from_name, to_addresses, cc_addresses,
    subject, received_at, text, user_id, status
  )
  values (
    v_mailbox.workspace_id, v_mailbox.id, v_mailbox.address, left(p_message_id, 200), left(p_thread_id, 200), 'outbound',
    v_mailbox.address, v_mailbox.display_name, coalesce(p_to[1:100], '{}'), coalesce(p_cc[1:100], '{}'), left(p_subject, 2000),
    coalesce(p_sent_at, now()), left(p_text, 1000000), p_user, 'sent'
  )
  on conflict (mailbox_id, message_id) do nothing;
end;
$$;

create or replace function private.agent_mail_fail(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.agent_mail_messages
  set status = 'failed', status_reason = left(p_reason, 1000), advancing_until = null
  where id = p_id and status in ('received', 'working') and replied_at is null;
end;
$$;

create or replace function private.team_remove(p_workspace uuid, p_actor uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := private.team_role(p_workspace, p_actor);
  target_role text := private.team_role(p_workspace, p_user);
begin
  if coalesce(actor_role, '') not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can remove people.' using errcode = '42501';
  end if;
  if target_role is null then
    raise exception 'They are not in this workspace.' using errcode = '22023';
  end if;
  if target_role = 'owner' then
    raise exception 'The owner can''t be removed.' using errcode = '42501';
  end if;
  if p_user = p_actor then
    raise exception 'You can''t remove yourself.' using errcode = '42501';
  end if;
  if target_role = 'admin' and actor_role <> 'owner' then
    raise exception 'Only the owner can remove an admin.' using errcode = '42501';
  end if;
  update crm.companies set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.contacts set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.opportunities set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.tasks set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.documents set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.mailbox_connections
    set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
    where workspace_id = p_workspace and user_id = p_user;
  update crm.calendar_accounts
    set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
    where workspace_id = p_workspace and user_id = p_user;
  delete from crm.ai_accounts where workspace_id = p_workspace and user_id = p_user;
  delete from crm.granola_keys where workspace_id = p_workspace and user_id = p_user;
  delete from crm.readwise_keys where workspace_id = p_workspace and user_id = p_user;
  delete from crm.recall_keys where workspace_id = p_workspace and user_id = p_user;
  update crm.ai_companions set revoked_at = now()
    where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  update crm.agent_mail_messages
    set status = 'failed', status_reason = 'They left the workspace.', advancing_until = null
    where workspace_id = p_workspace and user_id = p_user and status in ('received', 'working') and replied_at is null;
  delete from crm.agent_mail_threads where workspace_id = p_workspace and user_id = p_user;
  delete from crm.workspace_members where workspace_id = p_workspace and user_id = p_user;
end;
$$;

revoke all on function private.team_remove(uuid, uuid, uuid) from public;
grant execute on function private.team_remove(uuid, uuid, uuid) to crm_app;

revoke all on function private.agent_mailbox_targets() from public;
revoke all on function private.agent_mail_receive(uuid, text, jsonb, boolean, text) from public;
revoke all on function private.agent_mail_working(integer) from public;
revoke all on function private.agent_mailbox_note_error(uuid, text) from public;
revoke all on function private.agent_mail_record_sent(uuid, uuid, text, text, text[], text[], text, text, timestamptz) from public;
revoke all on function private.agent_mail_fail(uuid, text) from public;
grant execute on function private.agent_mailbox_targets() to crm_app;
grant execute on function private.agent_mail_receive(uuid, text, jsonb, boolean, text) to crm_app;
grant execute on function private.agent_mail_working(integer) to crm_app;
grant execute on function private.agent_mailbox_note_error(uuid, text) to crm_app;
grant execute on function private.agent_mail_record_sent(uuid, uuid, text, text, text[], text[], text, text, timestamptz) to crm_app;
grant execute on function private.agent_mail_fail(uuid, text) to crm_app;
