create table if not exists crm.mail_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  provider text not null default 'microsoft',
  connection_id uuid references crm.mailbox_connections (id) on delete cascade,
  account_id uuid references crm.calendar_accounts (id) on delete cascade,
  email text not null,
  locked_until timestamptz,
  folders_synced_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  constraint mail_sources_provider check (provider in ('microsoft')),
  constraint mail_sources_owner check ((connection_id is null) <> (account_id is null)),
  constraint mail_sources_error check (last_error is null or char_length(last_error) <= 500)
);

create unique index if not exists mail_sources_connection_key on crm.mail_sources (connection_id) where connection_id is not null;
create unique index if not exists mail_sources_account_key on crm.mail_sources (account_id) where account_id is not null;
create index if not exists mail_sources_user_idx on crm.mail_sources (user_id);

create table if not exists crm.mail_folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  provider_folder_id text not null,
  parent_provider_id text,
  name text not null,
  role text not null default 'other',
  total_count integer not null default 0,
  unread_count integer not null default 0,
  sync_state text not null default 'pending',
  sync_link text,
  synced_count integer not null default 0,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  constraint mail_folders_role check (role in ('inbox', 'sent', 'drafts', 'archive', 'trash', 'junk', 'outbox', 'other')),
  constraint mail_folders_state check (sync_state in ('pending', 'backfill', 'live', 'skipped')),
  constraint mail_folders_name check (char_length(name) between 1 and 300),
  constraint mail_folders_error check (last_error is null or char_length(last_error) <= 500),
  constraint mail_folders_unique unique (source_id, provider_folder_id)
);

create index if not exists mail_folders_user_idx on crm.mail_folders (user_id);

create table if not exists crm.mail_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  folder_id uuid not null references crm.mail_folders (id) on delete cascade,
  provider_message_id text not null,
  internet_message_id text,
  thread_key text,
  subject text,
  snippet text,
  body_html text,
  body_text text,
  body_truncated boolean not null default false,
  from_email text,
  from_name text,
  to_recipients jsonb not null default '[]'::jsonb,
  cc_recipients jsonb not null default '[]'::jsonb,
  bcc_recipients jsonb not null default '[]'::jsonb,
  sent_at timestamptz,
  received_at timestamptz,
  is_read boolean not null default false,
  is_draft boolean not null default false,
  is_flagged boolean not null default false,
  importance text,
  has_attachments boolean not null default false,
  categories text[] not null default '{}',
  web_link text,
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(from_name, '') || ' ' || coalesce(from_email, '')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(body_text, ''), 200000)), 'C')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_messages_provider_id check (char_length(provider_message_id) between 1 and 400),
  constraint mail_messages_unique unique (source_id, provider_message_id)
);

create index if not exists mail_messages_user_received_idx on crm.mail_messages (user_id, received_at desc);
create index if not exists mail_messages_folder_received_idx on crm.mail_messages (folder_id, received_at desc);
create index if not exists mail_messages_thread_idx on crm.mail_messages (source_id, thread_key, received_at);
create index if not exists mail_messages_search_idx on crm.mail_messages using gin (search);

drop trigger if exists mail_messages_set_updated_at on crm.mail_messages;
create trigger mail_messages_set_updated_at
  before update on crm.mail_messages
  for each row execute function private.set_updated_at();

alter table crm.mail_sources enable row level security;
alter table crm.mail_sources force row level security;
alter table crm.mail_folders enable row level security;
alter table crm.mail_folders force row level security;
alter table crm.mail_messages enable row level security;
alter table crm.mail_messages force row level security;

drop policy if exists mail_sources_owner on crm.mail_sources;
create policy mail_sources_owner on crm.mail_sources
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists mail_folders_owner on crm.mail_folders;
create policy mail_folders_owner on crm.mail_folders
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists mail_messages_owner on crm.mail_messages;
create policy mail_messages_owner on crm.mail_messages
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_sources from anon, authenticated, crm_agent;
revoke all on crm.mail_folders from anon, authenticated, crm_agent;
revoke all on crm.mail_messages from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_sources to authenticated;
grant select, insert, update, delete on crm.mail_folders to authenticated;
grant select, insert, update, delete on crm.mail_messages to authenticated;
