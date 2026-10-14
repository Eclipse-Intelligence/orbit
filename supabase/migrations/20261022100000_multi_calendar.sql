create or replace function private.session_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid()
$$;

revoke all on function private.session_user_id() from public;
grant execute on function private.session_user_id() to authenticated;

create table if not exists crm.calendar_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  provider text not null default 'microsoft',
  email text not null,
  display_name text,
  tenant_id text,
  refresh_token text,
  access_token text,
  access_token_expires_at timestamptz,
  status text not null default 'connected',
  scope_missing boolean not null default false,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_accounts_provider check (provider in ('microsoft')),
  constraint calendar_accounts_status check (status in ('connected', 'disconnected')),
  constraint calendar_accounts_email_length check (char_length(email) between 3 and 320),
  constraint calendar_accounts_display_name_length check (display_name is null or char_length(display_name) <= 200),
  constraint calendar_accounts_tenant_length check (tenant_id is null or char_length(tenant_id) <= 100),
  constraint calendar_accounts_error_length check (last_error is null or char_length(last_error) <= 500),
  constraint calendar_accounts_connected_token check (status <> 'connected' or refresh_token is not null),
  constraint calendar_accounts_owner_email unique (user_id, provider, email)
);

drop trigger if exists calendar_accounts_set_updated_at on crm.calendar_accounts;
create trigger calendar_accounts_set_updated_at
  before update on crm.calendar_accounts
  for each row execute function private.set_updated_at();

alter table crm.calendar_accounts enable row level security;
alter table crm.calendar_accounts force row level security;

drop policy if exists calendar_accounts_select_owner on crm.calendar_accounts;
create policy calendar_accounts_select_owner on crm.calendar_accounts
  for select to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists calendar_accounts_insert_owner on crm.calendar_accounts;
create policy calendar_accounts_insert_owner on crm.calendar_accounts
  for insert to authenticated
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists calendar_accounts_update_owner on crm.calendar_accounts;
create policy calendar_accounts_update_owner on crm.calendar_accounts
  for update to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists calendar_accounts_delete_owner on crm.calendar_accounts;
create policy calendar_accounts_delete_owner on crm.calendar_accounts
  for delete to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

revoke all on crm.calendar_accounts from anon, authenticated, crm_agent;
grant select, insert, delete on crm.calendar_accounts to authenticated;
grant update (
  email, display_name, tenant_id, refresh_token, access_token, access_token_expires_at,
  status, scope_missing, last_synced_at, last_attempt_at, last_error
) on crm.calendar_accounts to authenticated;

create table if not exists crm.calendars (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  account_id uuid references crm.calendar_accounts (id) on delete cascade,
  connection_id uuid references crm.mailbox_connections (id) on delete cascade,
  provider_calendar_id text not null,
  name text not null,
  color text not null,
  owner_email text,
  is_default boolean not null default false,
  is_visible boolean not null default true,
  use_for_crm boolean not null default false,
  can_edit boolean not null default false,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendars_one_source check (num_nonnulls(account_id, connection_id) = 1),
  constraint calendars_provider_id_length check (char_length(provider_calendar_id) between 1 and 400),
  constraint calendars_name_length check (char_length(name) between 1 and 200),
  constraint calendars_color_hex check (color ~ '^#[0-9a-f]{6}$'),
  constraint calendars_owner_length check (owner_email is null or char_length(owner_email) <= 320),
  constraint calendars_error_length check (last_error is null or char_length(last_error) <= 500)
);

create unique index if not exists calendars_provider_key
  on crm.calendars (user_id, coalesce(account_id, connection_id), provider_calendar_id);
create index if not exists calendars_account_idx on crm.calendars (account_id) where account_id is not null;
create index if not exists calendars_connection_idx on crm.calendars (connection_id) where connection_id is not null;

drop trigger if exists calendars_set_updated_at on crm.calendars;
create trigger calendars_set_updated_at
  before update on crm.calendars
  for each row execute function private.set_updated_at();

alter table crm.calendars enable row level security;
alter table crm.calendars force row level security;

drop policy if exists calendars_select_owner on crm.calendars;
create policy calendars_select_owner on crm.calendars
  for select to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists calendars_insert_owner on crm.calendars;
create policy calendars_insert_owner on crm.calendars
  for insert to authenticated
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and (
      connection_id is null
      or connection_id in (select id from crm.mailbox_connections where user_id = (select private.session_user_id()))
    )
    and (
      account_id is null
      or account_id in (select id from crm.calendar_accounts where user_id = (select private.session_user_id()))
    )
  );

drop policy if exists calendars_update_owner on crm.calendars;
create policy calendars_update_owner on crm.calendars
  for update to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists calendars_delete_owner on crm.calendars;
create policy calendars_delete_owner on crm.calendars
  for delete to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

revoke all on crm.calendars from anon, authenticated, crm_agent;
grant select, insert, delete on crm.calendars to authenticated;
grant update (
  provider_calendar_id, name, color, owner_email, is_default, is_visible, use_for_crm, can_edit,
  last_synced_at, last_attempt_at, last_error
) on crm.calendars to authenticated;

insert into crm.calendars (
  workspace_id, user_id, connection_id, provider_calendar_id, name, color,
  is_default, is_visible, use_for_crm, can_edit
)
select m.workspace_id, m.user_id, m.id, '__default__', 'Calendar', '#4f9be8', true, true, true, true
from crm.mailbox_connections m
where not exists (select 1 from crm.calendars c where c.connection_id = m.id);

alter table crm.calendar_events add column if not exists calendar_id uuid references crm.calendars (id) on delete cascade;
alter table crm.calendar_events add column if not exists account_id uuid references crm.calendar_accounts (id) on delete cascade;
alter table crm.calendar_events add column if not exists show_as text;
alter table crm.calendar_events alter column connection_id drop not null;

alter table crm.calendar_events drop constraint if exists calendar_events_show_as_length;
alter table crm.calendar_events
  add constraint calendar_events_show_as_length check (show_as is null or char_length(show_as) <= 40);

update crm.calendar_events e
set calendar_id = c.id
from crm.calendars c
where e.calendar_id is null
  and c.connection_id = e.connection_id
  and c.is_default;

delete from crm.calendar_events where calendar_id is null;

alter table crm.calendar_events alter column calendar_id set not null;

alter table crm.calendar_events drop constraint if exists calendar_events_one_source;
alter table crm.calendar_events
  add constraint calendar_events_one_source check (num_nonnulls(account_id, connection_id) = 1);

alter table crm.calendar_events drop constraint if exists calendar_events_provider_key;
alter table crm.calendar_events drop constraint if exists calendar_events_calendar_key;
alter table crm.calendar_events
  add constraint calendar_events_calendar_key unique (calendar_id, provider_event_id);

create index if not exists calendar_events_user_starts_idx
  on crm.calendar_events (user_id, starts_at);
create index if not exists calendar_events_account_idx
  on crm.calendar_events (account_id) where account_id is not null;

drop policy if exists calendar_events_insert_owner on crm.calendar_events;
create policy calendar_events_insert_owner on crm.calendar_events
  for insert to authenticated
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and calendar_id in (select id from crm.calendars where user_id = (select private.session_user_id()))
    and (
      connection_id is null
      or connection_id in (select id from crm.mailbox_connections where user_id = (select private.session_user_id()))
    )
    and (
      account_id is null
      or account_id in (select id from crm.calendar_accounts where user_id = (select private.session_user_id()))
    )
  );

drop policy if exists calendar_events_update_owner on crm.calendar_events;
create policy calendar_events_update_owner on crm.calendar_events
  for update to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and calendar_id in (select id from crm.calendars where user_id = (select private.session_user_id()))
  );

grant update (show_as) on crm.calendar_events to authenticated;
