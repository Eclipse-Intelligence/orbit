create table if not exists crm.mail_sender_relevance (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  sender text not null,
  category text not null,
  engine text not null,
  confidence real,
  reason text,
  rule boolean not null default false,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_sender_relevance_sender check (char_length(sender) between 3 and 320 and sender = lower(sender) and position('@' in sender) > 0),
  constraint mail_sender_relevance_category check (category in ('business', 'supplier', 'service', 'personal', 'collections', 'spam', 'newsletter', 'muted')),
  constraint mail_sender_relevance_engine check (engine in ('jev', 'haiku', 'rule', 'filed', 'shown')),
  constraint mail_sender_relevance_confidence check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint mail_sender_relevance_reason check (reason is null or char_length(reason) <= 300),
  constraint mail_sender_relevance_unique unique (user_id, workspace_id, sender)
);

alter table crm.mail_sender_relevance enable row level security;
alter table crm.mail_sender_relevance force row level security;

drop policy if exists mail_sender_relevance_owner on crm.mail_sender_relevance;
create policy mail_sender_relevance_owner on crm.mail_sender_relevance
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_sender_relevance from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_sender_relevance to authenticated;

create index if not exists mail_sender_relevance_sensitive_idx on crm.mail_sender_relevance (user_id, sender)
  where category in ('personal', 'collections');

create table if not exists crm.mail_thread_relevance (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  thread_key text not null,
  sender text not null,
  category text,
  engine text not null,
  confidence real,
  reason text,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_thread_relevance_key check (char_length(thread_key) between 1 and 450),
  constraint mail_thread_relevance_sender check (char_length(sender) between 3 and 320 and sender = lower(sender)),
  constraint mail_thread_relevance_category check (category is null or category in ('business', 'supplier', 'service', 'personal', 'collections', 'spam', 'newsletter', 'muted')),
  constraint mail_thread_relevance_engine check (engine in ('jev', 'haiku', 'headers', 'listed', 'history', 'cached', 'rule', 'filed', 'shown', 'failed')),
  constraint mail_thread_relevance_confidence check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint mail_thread_relevance_reason check (reason is null or char_length(reason) <= 300),
  constraint mail_thread_relevance_unique unique (user_id, source_id, thread_key)
);

alter table crm.mail_thread_relevance enable row level security;
alter table crm.mail_thread_relevance force row level security;

drop policy if exists mail_thread_relevance_owner on crm.mail_thread_relevance;
create policy mail_thread_relevance_owner on crm.mail_thread_relevance
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_thread_relevance from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_thread_relevance to authenticated;

create index if not exists mail_thread_relevance_sensitive_sender_idx on crm.mail_thread_relevance (user_id, sender)
  where category in ('personal', 'collections');

create table if not exists crm.mail_relevance_runs (
  user_id uuid primary key references crm.profiles (id) on delete cascade,
  started_at timestamptz not null default now(),
  running_until timestamptz not null default now()
);

alter table crm.mail_relevance_runs enable row level security;
alter table crm.mail_relevance_runs force row level security;

drop policy if exists mail_relevance_runs_owner on crm.mail_relevance_runs;
create policy mail_relevance_runs_owner on crm.mail_relevance_runs
  for all to authenticated
  using (user_id = (select private.session_user_id()))
  with check (user_id = (select private.session_user_id()));

revoke all on crm.mail_relevance_runs from anon, authenticated, crm_agent;
grant select, insert, update on crm.mail_relevance_runs to authenticated;

create index if not exists mail_messages_user_sender_domain_idx on crm.mail_messages (user_id, (split_part(lower(from_email), '@', 2)));

create or replace function private.sensitive_email_activities(p_workspace uuid, p_since timestamptz)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id
  from crm.activities a
  join crm.mail_messages m on m.id = (
    case when a.metadata->>'mailMessageId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (a.metadata->>'mailMessageId')::uuid end
  )
  where a.workspace_id = p_workspace and a.type = 'email'
    and exists (select 1 from crm.activity_tones t where t.activity_id = a.id and t.created_at > p_since)
    and (
      exists (
        select 1 from crm.mail_thread_relevance r
        where r.user_id = m.user_id and r.source_id = m.source_id and r.thread_key = m.thread_key
          and r.category in ('personal', 'collections')
      )
      or exists (
        select 1 from crm.mail_thread_relevance r
        where r.user_id = m.user_id and r.sender = lower(m.from_email) and r.category in ('personal', 'collections')
      )
      or exists (
        select 1 from crm.mail_sender_relevance s
        where s.user_id = m.user_id and s.sender = lower(m.from_email) and s.category in ('personal', 'collections')
      )
    )
$$;

revoke all on function private.sensitive_email_activities(uuid, timestamptz) from public;
grant execute on function private.sensitive_email_activities(uuid, timestamptz) to crm_app;

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

  foreach v_table in array array[
    'calendar_accounts', 'mail_sources', 'mail_folders', 'mail_messages', 'mail_drafts', 'mail_prepared',
    'mail_reminders', 'mail_summaries', 'mail_unsubscribes', 'send_identities', 'mail_attachment_texts',
    'mail_deferral_checks', 'mail_pitch_failures', 'calendars', 'calendar_events', 'mail_sender_rules',
    'mail_subscriptions', 'mail_viewer_addresses', 'mail_tracking', 'mail_opens', 'email_attachments',
    'ai_accounts', 'ai_companions', 'ai_companion_pairings', 'push_subscriptions', 'push_log', 'booking_pages',
    'mail_domain_rules', 'mail_thread_routes', 'capture_dismissals'
  ]
  loop
    execute format('update crm.%I set workspace_id = $1 where workspace_id = $2 and user_id = $3', v_table)
      using p_to, p_from, p_user;
  end loop;

  delete from crm.mail_sender_relevance where workspace_id = p_from and user_id = p_user;
  delete from crm.mail_thread_relevance where workspace_id = p_from and user_id = p_user;
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
