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

create table if not exists crm.calendar_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  connection_id uuid not null references crm.mailbox_connections (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  provider_event_id text not null,
  ical_uid text,
  subject text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_all_day boolean not null default false,
  is_cancelled boolean not null default false,
  location text,
  web_link text,
  online_meeting_url text,
  organizer jsonb,
  attendees jsonb not null default '[]'::jsonb,
  contact_ids uuid[] not null default '{}',
  company_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint calendar_events_provider_key unique (connection_id, provider_event_id),
  constraint calendar_events_provider_id_length check (char_length(provider_event_id) between 1 and 400),
  constraint calendar_events_ical_uid_length check (ical_uid is null or char_length(ical_uid) <= 400),
  constraint calendar_events_subject_length check (subject is null or char_length(subject) <= 500),
  constraint calendar_events_location_length check (location is null or char_length(location) <= 500),
  constraint calendar_events_web_link_length check (web_link is null or char_length(web_link) <= 2000),
  constraint calendar_events_online_url_length check (online_meeting_url is null or char_length(online_meeting_url) <= 2000),
  constraint calendar_events_time_order check (ends_at >= starts_at),
  constraint calendar_events_organizer_object check (organizer is null or jsonb_typeof(organizer) = 'object'),
  constraint calendar_events_attendees_array check (
    jsonb_typeof(attendees) = 'array' and pg_column_size(attendees) <= 200000
  )
);

create index if not exists calendar_events_connection_starts_idx
  on crm.calendar_events (connection_id, starts_at);
create index if not exists calendar_events_user_starts_idx
  on crm.calendar_events (user_id, starts_at);
create index if not exists calendar_events_contact_ids_idx
  on crm.calendar_events using gin (contact_ids);
create index if not exists calendar_events_company_ids_idx
  on crm.calendar_events using gin (company_ids);

drop trigger if exists calendar_events_set_updated_at on crm.calendar_events;
create trigger calendar_events_set_updated_at
  before update on crm.calendar_events
  for each row execute function private.set_updated_at();

alter table crm.calendar_events enable row level security;
alter table crm.calendar_events force row level security;

drop policy if exists calendar_events_select_owner on crm.calendar_events;
create policy calendar_events_select_owner on crm.calendar_events
  for select to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists calendar_events_insert_owner on crm.calendar_events;
create policy calendar_events_insert_owner on crm.calendar_events
  for insert to authenticated
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select private.session_user_id())
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
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select private.session_user_id())
    )
  );

drop policy if exists calendar_events_delete_owner on crm.calendar_events;
create policy calendar_events_delete_owner on crm.calendar_events
  for delete to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

revoke all on crm.calendar_events from anon, authenticated, crm_agent;
grant select, insert, delete on crm.calendar_events to authenticated;
grant update (
  ical_uid, subject, starts_at, ends_at, is_all_day, is_cancelled, location, web_link,
  online_meeting_url, organizer, attendees, contact_ids, company_ids
) on crm.calendar_events to authenticated;

create table if not exists crm.hidden_attendees (
  user_id uuid not null references crm.profiles (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  constraint hidden_attendees_pkey primary key (user_id, workspace_id, email),
  constraint hidden_attendees_email_length check (char_length(email) between 3 and 320)
);

alter table crm.hidden_attendees enable row level security;
alter table crm.hidden_attendees force row level security;

drop policy if exists hidden_attendees_select_owner on crm.hidden_attendees;
create policy hidden_attendees_select_owner on crm.hidden_attendees
  for select to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists hidden_attendees_insert_owner on crm.hidden_attendees;
create policy hidden_attendees_insert_owner on crm.hidden_attendees
  for insert to authenticated
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists hidden_attendees_delete_owner on crm.hidden_attendees;
create policy hidden_attendees_delete_owner on crm.hidden_attendees
  for delete to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

revoke all on crm.hidden_attendees from anon, authenticated, crm_agent;
grant select, insert, delete on crm.hidden_attendees to authenticated;

alter table crm.integration_state add column if not exists scope_missing boolean not null default false;
grant update (scope_missing) on crm.integration_state to authenticated;

alter table crm.integration_state drop constraint if exists integration_state_source;
alter table crm.integration_state
  add constraint integration_state_source
  check (source in ('granola', 'teams_transcripts', 'clickup', 'calendar'));

alter table crm.integration_state drop constraint if exists integration_state_teams_connection;
alter table crm.integration_state drop constraint if exists integration_state_connection_sources;
alter table crm.integration_state
  add constraint integration_state_connection_sources
  check (
    (source in ('teams_transcripts', 'calendar')) = (connection_id is not null)
    and (source not in ('teams_transcripts', 'calendar') or user_id is not null)
  );

create unique index if not exists integration_state_connection_source_key
  on crm.integration_state (connection_id, source)
  where connection_id is not null;
drop index if exists crm.integration_state_connection_key;

drop policy if exists integration_state_select_member on crm.integration_state;
create policy integration_state_select_member on crm.integration_state
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (source not in ('teams_transcripts', 'calendar') or user_id = (select private.session_user_id()))
  );

drop policy if exists integration_state_insert_member on crm.integration_state;
create policy integration_state_insert_member on crm.integration_state
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (source not in ('teams_transcripts', 'calendar') or user_id = (select private.session_user_id()))
  );

drop policy if exists integration_state_update_member on crm.integration_state;
create policy integration_state_update_member on crm.integration_state
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (source not in ('teams_transcripts', 'calendar') or user_id = (select private.session_user_id()))
  )
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (source not in ('teams_transcripts', 'calendar') or user_id = (select private.session_user_id()))
  );
