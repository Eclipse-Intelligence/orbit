create table crm.mailbox_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  provider text not null,
  email text not null,
  status text not null default 'connected',
  refresh_token text,
  access_token text,
  access_token_expires_at timestamptz,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mailbox_connections_provider check (provider in ('microsoft')),
  constraint mailbox_connections_status check (status in ('connected', 'disconnected')),
  constraint mailbox_connections_email_length check (char_length(email) between 3 and 320),
  constraint mailbox_connections_connected_token check (
    status <> 'connected' or refresh_token is not null
  ),
  constraint mailbox_connections_owner unique (workspace_id, user_id, provider)
);

create table crm.email_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  connection_id uuid not null references crm.mailbox_connections (id) on delete cascade,
  provider_message_id text not null,
  conversation_id text,
  internet_message_id text,
  direction text not null,
  subject text,
  preview text,
  from_email text,
  from_name text,
  received_at timestamptz,
  contact_id uuid references crm.contacts (id) on delete set null,
  company_id uuid references crm.companies (id) on delete set null,
  activity_id uuid references crm.activities (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint email_messages_direction check (direction in ('inbound')),
  constraint email_messages_provider_id_length check (char_length(provider_message_id) between 1 and 400),
  constraint email_messages_unique unique (workspace_id, provider_message_id)
);

create index email_messages_connection_received_idx
  on crm.email_messages (connection_id, received_at desc);

create trigger mailbox_connections_set_updated_at
  before update on crm.mailbox_connections
  for each row execute function private.set_updated_at();

alter table crm.mailbox_connections enable row level security;
alter table crm.mailbox_connections force row level security;
alter table crm.email_messages enable row level security;
alter table crm.email_messages force row level security;

create policy mailbox_connections_select_owner on crm.mailbox_connections
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and workspace_id in (select private.user_workspace_ids())
  );
create policy mailbox_connections_insert_owner on crm.mailbox_connections
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and workspace_id in (select private.user_workspace_ids())
  );
create policy mailbox_connections_update_owner on crm.mailbox_connections
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select auth.uid())
    and workspace_id in (select private.user_workspace_ids())
  );

create policy email_messages_select_owner on crm.email_messages
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select auth.uid())
    )
  );
create policy email_messages_insert_owner on crm.email_messages
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select auth.uid())
    )
  );

grant select, insert, update on crm.mailbox_connections to authenticated;
grant select, insert on crm.email_messages to authenticated;
revoke all on crm.mailbox_connections, crm.email_messages from anon, crm_agent;
