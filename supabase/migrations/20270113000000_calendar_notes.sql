set lock_timeout = '5s';

alter table crm.calendar_events drop constraint if exists calendar_events_notes_length;
alter table crm.calendar_events drop column if exists notes;

create table if not exists crm.calendar_event_notes (
  event_id uuid primary key references crm.calendar_events (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  notes text not null,
  updated_at timestamptz not null default now(),
  constraint calendar_event_notes_length check (char_length(notes) between 1 and 8000)
);

create index if not exists calendar_event_notes_user_idx on crm.calendar_event_notes (user_id);

alter table crm.calendar_event_notes enable row level security;
alter table crm.calendar_event_notes force row level security;

drop policy if exists calendar_event_notes_owner on crm.calendar_event_notes;
create policy calendar_event_notes_owner on crm.calendar_event_notes
  for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and event_id in (
      select id from crm.calendar_events where user_id = (select private.session_user_id())
    )
  );

revoke all on crm.calendar_event_notes from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.calendar_event_notes to authenticated;

create table if not exists crm.calendar_event_links (
  event_id uuid primary key references crm.calendar_events (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  join_url text not null,
  updated_at timestamptz not null default now(),
  constraint calendar_event_links_url check (char_length(join_url) <= 2000 and join_url ~ '^https?://')
);

create index if not exists calendar_event_links_user_idx on crm.calendar_event_links (user_id);

drop function if exists private.proven_addresses(uuid);

create or replace function private.proven_addresses(p_user uuid, p_workspace uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  with login_domains as (
    select distinct split_part(lower(btrim(p.email)), '@', 2) as domain
    from crm.workspace_members m
    join crm.profiles p on p.id = m.user_id
    where m.workspace_id = p_workspace and p.email like '%_@_%'
  ), connected as (
    select lower(btrim(c.email)) as address from crm.mailbox_connections c where c.user_id = p_user
    union
    select lower(btrim(a.email)) from crm.calendar_accounts a where a.user_id = p_user
  )
  select lower(btrim(p.email)) from crm.profiles p where p.id = p_user and p.email like '%_@_%'
  union
  select address from connected
  where address like '%_@_%' and split_part(address, '@', 2) in (select domain from login_domains);
$$;

revoke all on function private.proven_addresses(uuid, uuid) from public;

create or replace function private.workspace_member_addresses(p_workspace uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select distinct address
  from crm.workspace_members m
  cross join lateral private.proven_addresses(m.user_id, p_workspace) as address
  where m.workspace_id = p_workspace;
$$;

revoke all on function private.workspace_member_addresses(uuid) from public;
grant execute on function private.workspace_member_addresses(uuid) to crm_app;

create or replace function private.calendar_guest_events()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select l.event_id
  from crm.calendar_event_links l
  join crm.calendar_events e on e.id = l.event_id
  where l.workspace_id in (select private.user_workspace_ids())
    and l.user_id <> (select private.session_user_id())
    and exists (
      select 1
      from private.proven_addresses((select private.session_user_id()), l.workspace_id) as mine(email)
      where lower(e.organizer ->> 'email') = mine.email
        or e.attendees @> jsonb_build_array(jsonb_build_object('email', mine.email))
    );
$$;

revoke all on function private.calendar_guest_events() from public;
grant execute on function private.calendar_guest_events() to authenticated;

alter table crm.calendar_event_links enable row level security;
alter table crm.calendar_event_links force row level security;

drop policy if exists calendar_event_links_owner on crm.calendar_event_links;
drop policy if exists calendar_event_links_select_guest on crm.calendar_event_links;
drop function if exists private.calendar_event_guest(uuid);

drop policy if exists calendar_event_links_select on crm.calendar_event_links;
create policy calendar_event_links_select on crm.calendar_event_links
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      user_id = (select private.session_user_id())
      or event_id in (select private.calendar_guest_events())
    )
  );

drop policy if exists calendar_event_links_insert_owner on crm.calendar_event_links;
create policy calendar_event_links_insert_owner on crm.calendar_event_links
  for insert to authenticated
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and event_id in (
      select id from crm.calendar_events where user_id = (select private.session_user_id())
    )
  );

drop policy if exists calendar_event_links_update_owner on crm.calendar_event_links;
create policy calendar_event_links_update_owner on crm.calendar_event_links
  for update to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and event_id in (
      select id from crm.calendar_events where user_id = (select private.session_user_id())
    )
  );

drop policy if exists calendar_event_links_delete_owner on crm.calendar_event_links;
create policy calendar_event_links_delete_owner on crm.calendar_event_links
  for delete to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

revoke all on crm.calendar_event_links from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.calendar_event_links to authenticated;

create or replace function private.move_personal_rows(p_user uuid, p_from uuid, p_to uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
begin
  update crm.mailbox_connections c set workspace_id = p_to
  where c.workspace_id = p_from and c.user_id = p_user
    and not exists (
      select 1 from crm.mailbox_connections t
      where t.workspace_id = p_to and t.user_id = p_user and t.provider = c.provider
    );
  update crm.mailbox_connections
    set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
    where workspace_id = p_from and user_id = p_user;

  update crm.email_signatures s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user
    and not exists (
      select 1 from crm.email_signatures t
      where t.workspace_id = p_to and t.user_id = p_user and t.sender_email = s.sender_email
    );
  update crm.mail_preferences s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user
    and not exists (select 1 from crm.mail_preferences t where t.workspace_id = p_to and t.user_id = p_user);
  update crm.hidden_attendees s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user
    and not exists (
      select 1 from crm.hidden_attendees t where t.workspace_id = p_to and t.user_id = p_user and t.email = s.email
    );
  update crm.pages s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user and s.kind = 'daily'
    and not exists (
      select 1 from crm.pages t
      where t.workspace_id = p_to and t.user_id = p_user and t.kind = 'daily' and t.daily_date = s.daily_date
    );
  update crm.integration_state set workspace_id = p_to
  where workspace_id = p_from and user_id = p_user and connection_id is not null;

  delete from crm.booking_pages s
  where s.workspace_id = p_from and s.user_id = p_user
    and exists (select 1 from crm.booking_pages t where t.workspace_id = p_to and t.user_id = p_user);
  delete from crm.personal_context_workspaces where workspace_id = p_from and user_id = p_user;
  if to_regclass('crm.mail_sender_relevance') is not null then
    execute 'delete from crm.mail_sender_relevance where workspace_id = $1 and user_id = $2' using p_from, p_user;
  end if;
  if to_regclass('crm.mail_thread_relevance') is not null then
    execute 'delete from crm.mail_thread_relevance where workspace_id = $1 and user_id = $2' using p_from, p_user;
  end if;

  foreach v_table in array array[
    'calendar_accounts', 'mail_sources', 'mail_folders', 'mail_messages', 'mail_drafts', 'mail_prepared',
    'mail_reminders', 'mail_summaries', 'mail_unsubscribes', 'send_identities', 'mail_attachment_texts',
    'mail_deferral_checks', 'mail_pitch_failures', 'calendars', 'calendar_events', 'calendar_event_notes',
    'calendar_event_links', 'mail_sender_rules', 'mail_subscriptions', 'mail_viewer_addresses', 'mail_tracking',
    'mail_opens', 'email_attachments', 'ai_accounts', 'ai_companions', 'ai_companion_pairings', 'push_subscriptions',
    'push_log', 'booking_pages', 'mail_domain_rules', 'mail_thread_routes', 'capture_dismissals'
  ]
  loop
    execute format('update crm.%I set workspace_id = $1 where workspace_id = $2 and user_id = $3', v_table)
      using p_to, p_from, p_user;
  end loop;

  delete from crm.mail_address_homes where workspace_id = p_from and user_id = p_user;
  update crm.granola_keys set workspace_id = p_to where workspace_id = p_from and user_id = p_user;
  update crm.recall_keys set workspace_id = p_to where workspace_id = p_from and user_id = p_user;
  delete from crm.readwise_documents where workspace_id = p_from and user_id = p_user;
  update crm.readwise_keys
    set workspace_id = p_to, updated_after = null, full_sync_at = null, scan_cursor = null, scan_since = null,
      scan_started_at = null, scan_full = false, list_cursor = null, list_full = false, list_done = false, sync_started_at = null
    where workspace_id = p_from and user_id = p_user;
  delete from crm.mail_domain_rules where user_id = p_user and workspace_ids <@ array[p_from];
  update crm.mail_domain_rules set workspace_ids = array_remove(workspace_ids, p_from)
    where user_id = p_user and p_from = any(workspace_ids);
  update crm.mail_thread_routes set filed_in = nullif(array_remove(filed_in, p_from), '{}')
    where user_id = p_user and p_from = any(filed_in);
  update crm.mail_thread_routes set capture_workspace_id = null
    where user_id = p_user and capture_workspace_id = p_from;
end;
$$;

revoke all on function private.move_personal_rows(uuid, uuid, uuid) from public;

reset lock_timeout;
