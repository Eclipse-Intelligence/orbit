set lock_timeout = '3s';

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
grant select, insert, update on crm.mail_thread_relevance to authenticated;

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

create table if not exists crm.mail_known_addresses (
  user_id uuid not null references crm.profiles (id) on delete cascade,
  address text not null,
  domain text not null,
  sent_count integer not null default 0,
  sent_first timestamptz,
  sent_last timestamptz,
  met_first timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, address),
  constraint mail_known_addresses_address check (char_length(address) between 3 and 320 and address = lower(address))
);

create index if not exists mail_known_addresses_domain_idx on crm.mail_known_addresses (user_id, domain);

alter table crm.mail_known_addresses enable row level security;
alter table crm.mail_known_addresses force row level security;

drop policy if exists mail_known_addresses_owner on crm.mail_known_addresses;
create policy mail_known_addresses_owner on crm.mail_known_addresses
  for select to authenticated
  using (user_id = (select private.session_user_id()));

revoke all on crm.mail_known_addresses from anon, authenticated, crm_agent;
grant select on crm.mail_known_addresses to authenticated;

create or replace function private.mail_known_sent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := coalesce(new.sent_at, new.created_at);
begin
  if new.is_draft or not exists (select 1 from crm.mail_folders f where f.id = new.folder_id and f.role = 'sent') then
    return null;
  end if;
  insert into crm.mail_known_addresses as k (user_id, address, domain, sent_count, sent_first, sent_last)
  select new.user_id, x.address, split_part(x.address, '@', 2), 1, v_at, v_at
  from (
    select distinct lower(btrim(r->>'address')) as address
    from jsonb_array_elements(
      (case when jsonb_typeof(new.to_recipients) = 'array' then new.to_recipients else '[]'::jsonb end)
      || (case when jsonb_typeof(new.cc_recipients) = 'array' then new.cc_recipients else '[]'::jsonb end)
      || (case when jsonb_typeof(new.bcc_recipients) = 'array' then new.bcc_recipients else '[]'::jsonb end)
    ) r
    where jsonb_typeof(r) = 'object' and jsonb_typeof(r->'address') = 'string'
  ) x
  where x.address ~ '^[^[:space:]@]+@[^[:space:]@]+$' and char_length(x.address) <= 320
  on conflict (user_id, address) do update set
    sent_count = k.sent_count + 1,
    sent_first = least(k.sent_first, excluded.sent_first),
    sent_last = greatest(k.sent_last, excluded.sent_last),
    updated_at = now();
  return null;
end;
$$;

revoke all on function private.mail_known_sent() from public;

drop trigger if exists mail_messages_known_sent on crm.mail_messages;
create trigger mail_messages_known_sent
  after insert or update of folder_id on crm.mail_messages
  for each row execute function private.mail_known_sent();

create or replace function private.calendar_known_met()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_cancelled or jsonb_typeof(new.attendees) <> 'array' or jsonb_array_length(new.attendees) > 25 then
    return null;
  end if;
  insert into crm.mail_known_addresses as k (user_id, address, domain, met_first)
  select new.user_id, x.address, split_part(x.address, '@', 2), new.starts_at
  from (
    select distinct lower(btrim(p->>'email')) as address
    from jsonb_array_elements(
      new.attendees || (case when jsonb_typeof(new.organizer) = 'object' then jsonb_build_array(new.organizer) else '[]'::jsonb end)
    ) p
    where jsonb_typeof(p) = 'object' and jsonb_typeof(p->'email') = 'string'
  ) x
  where x.address ~ '^[^[:space:]@]+@[^[:space:]@]+$' and char_length(x.address) <= 320
  on conflict (user_id, address) do update set
    met_first = least(coalesce(k.met_first, excluded.met_first), excluded.met_first),
    updated_at = now();
  return null;
end;
$$;

revoke all on function private.calendar_known_met() from public;

drop trigger if exists calendar_events_known_met on crm.calendar_events;
create trigger calendar_events_known_met
  after insert or update of attendees, organizer, starts_at, is_cancelled on crm.calendar_events
  for each row execute function private.calendar_known_met();

insert into crm.mail_known_addresses as k (user_id, address, domain, sent_count, sent_first, sent_last)
select m.user_id, x.address, split_part(x.address, '@', 2), count(*)::int, min(coalesce(m.sent_at, m.created_at)), max(coalesce(m.sent_at, m.created_at))
from crm.mail_messages m
join crm.mail_folders f on f.id = m.folder_id and f.role = 'sent'
cross join lateral (
  select distinct lower(btrim(r->>'address')) as address
  from jsonb_array_elements(
    (case when jsonb_typeof(m.to_recipients) = 'array' then m.to_recipients else '[]'::jsonb end)
    || (case when jsonb_typeof(m.cc_recipients) = 'array' then m.cc_recipients else '[]'::jsonb end)
    || (case when jsonb_typeof(m.bcc_recipients) = 'array' then m.bcc_recipients else '[]'::jsonb end)
  ) r
  where jsonb_typeof(r) = 'object' and jsonb_typeof(r->'address') = 'string'
) x
where not m.is_draft and x.address ~ '^[^[:space:]@]+@[^[:space:]@]+$' and char_length(x.address) <= 320
group by m.user_id, x.address
on conflict (user_id, address) do update set
  sent_count = excluded.sent_count,
  sent_first = excluded.sent_first,
  sent_last = excluded.sent_last,
  updated_at = now();

insert into crm.mail_known_addresses as k (user_id, address, domain, met_first)
select e.user_id, x.address, split_part(x.address, '@', 2), min(e.starts_at)
from crm.calendar_events e
cross join lateral (
  select distinct lower(btrim(p->>'email')) as address
  from jsonb_array_elements(
    e.attendees || (case when jsonb_typeof(e.organizer) = 'object' then jsonb_build_array(e.organizer) else '[]'::jsonb end)
  ) p
  where jsonb_typeof(p) = 'object' and jsonb_typeof(p->'email') = 'string'
) x
where not e.is_cancelled and jsonb_typeof(e.attendees) = 'array' and jsonb_array_length(e.attendees) <= 25
  and x.address ~ '^[^[:space:]@]+@[^[:space:]@]+$' and char_length(x.address) <= 320
group by e.user_id, x.address
on conflict (user_id, address) do update set
  met_first = least(coalesce(k.met_first, excluded.met_first), excluded.met_first),
  updated_at = now();

alter table crm.mail_messages add column if not exists from_domain text;

create or replace function private.mail_message_from_domain()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.from_domain := nullif(split_part(lower(coalesce(new.from_email, '')), '@', 2), '');
  return new;
end;
$$;

revoke all on function private.mail_message_from_domain() from public;

drop trigger if exists mail_messages_from_domain on crm.mail_messages;
create trigger mail_messages_from_domain
  before insert or update of from_email on crm.mail_messages
  for each row execute function private.mail_message_from_domain();

do $$
begin
  if to_regclass('crm.mail_messages_user_from_domain_idx') is null then
    create index mail_messages_user_from_domain_idx on crm.mail_messages (user_id, from_domain);
  end if;
end;
$$;

create index if not exists activity_tones_workspace_created_idx on crm.activity_tones (workspace_id, created_at);

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
    and not exists (
      select 1 from crm.mail_sender_relevance b
      where b.user_id = m.user_id and b.workspace_id = a.workspace_id and b.rule and b.category = 'business'
        and b.sender in (lower(m.from_email), '@' || split_part(lower(m.from_email), '@', 2))
    )
    and exists (
      select 1 from crm.mail_thread_relevance r
      where r.user_id = m.user_id and r.workspace_id = a.workspace_id
        and ((r.source_id = m.source_id and r.thread_key = m.thread_key) or r.sender = lower(m.from_email))
        and r.category in ('personal', 'collections')
        and (r.engine in ('listed', 'headers') or coalesce(r.confidence, 0) >= 0.8)
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

reset lock_timeout;
