create table if not exists crm.mail_tracking (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  sender_email text not null,
  recipients jsonb not null default '[]'::jsonb,
  subject text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mail_tracking_subject check (subject is null or char_length(subject) <= 2000)
);

create index if not exists mail_tracking_user_idx on crm.mail_tracking (user_id, created_at desc);

create table if not exists crm.mail_opens (
  id uuid primary key default gen_random_uuid(),
  tracking_id uuid not null references crm.mail_tracking (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  opened_at timestamptz not null default now(),
  agent text,
  constraint mail_opens_agent check (agent is null or char_length(agent) <= 120)
);

create index if not exists mail_opens_tracking_idx on crm.mail_opens (tracking_id, opened_at);

create table if not exists crm.mail_viewer_addresses (
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  address_hash text not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, address_hash),
  constraint mail_viewer_addresses_hash check (char_length(address_hash) between 16 and 128)
);

create table if not exists crm.mail_preferences (
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  read_statuses boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists crm.mail_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  provider_draft_id text not null,
  mode text not null,
  reply_to uuid references crm.mail_messages (id) on delete set null,
  thread_key text,
  quote_html text,
  to_recipients jsonb not null default '[]'::jsonb,
  cc_recipients jsonb not null default '[]'::jsonb,
  bcc_recipients jsonb not null default '[]'::jsonb,
  subject text,
  body text not null default '',
  tracking_id uuid references crm.mail_tracking (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_drafts_mode check (mode in ('new', 'reply', 'reply_all', 'forward')),
  constraint mail_drafts_body check (char_length(body) <= 20000),
  constraint mail_drafts_subject check (subject is null or char_length(subject) <= 2000)
);

create index if not exists mail_drafts_thread_idx on crm.mail_drafts (source_id, thread_key, updated_at desc);

alter table crm.mail_messages add column if not exists tracking_id uuid;
create index if not exists mail_messages_tracking_idx on crm.mail_messages (tracking_id) where tracking_id is not null;

alter table crm.mail_tracking enable row level security;
alter table crm.mail_tracking force row level security;
alter table crm.mail_opens enable row level security;
alter table crm.mail_opens force row level security;
alter table crm.mail_viewer_addresses enable row level security;
alter table crm.mail_viewer_addresses force row level security;
alter table crm.mail_preferences enable row level security;
alter table crm.mail_preferences force row level security;
alter table crm.mail_drafts enable row level security;
alter table crm.mail_drafts force row level security;

drop policy if exists mail_tracking_owner on crm.mail_tracking;
create policy mail_tracking_owner on crm.mail_tracking
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists mail_opens_owner on crm.mail_opens;
create policy mail_opens_owner on crm.mail_opens
  for select to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists mail_viewer_addresses_owner on crm.mail_viewer_addresses;
create policy mail_viewer_addresses_owner on crm.mail_viewer_addresses
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists mail_preferences_owner on crm.mail_preferences;
create policy mail_preferences_owner on crm.mail_preferences
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists mail_drafts_owner on crm.mail_drafts;
create policy mail_drafts_owner on crm.mail_drafts
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_tracking from anon, authenticated, crm_agent;
revoke all on crm.mail_opens from anon, authenticated, crm_agent;
revoke all on crm.mail_viewer_addresses from anon, authenticated, crm_agent;
revoke all on crm.mail_preferences from anon, authenticated, crm_agent;
revoke all on crm.mail_drafts from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_tracking to authenticated;
grant select on crm.mail_opens to authenticated;
grant select, insert, update, delete on crm.mail_viewer_addresses to authenticated;
grant select, insert, update on crm.mail_preferences to authenticated;
grant select, insert, update, delete on crm.mail_drafts to authenticated;

create or replace function private.record_mail_open(p_tracking uuid, p_address_hash text, p_agent text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracking crm.mail_tracking%rowtype;
begin
  select * into v_tracking from crm.mail_tracking where id = p_tracking;
  if not found or v_tracking.sent_at is null then
    return false;
  end if;
  if clock_timestamp() < v_tracking.sent_at + interval '5 seconds' then
    return false;
  end if;
  if p_address_hash is not null and exists (
    select 1 from crm.mail_viewer_addresses
    where user_id = v_tracking.user_id and address_hash = p_address_hash and seen_at > clock_timestamp() - interval '30 days'
  ) then
    return false;
  end if;
  if exists (
    select 1 from crm.mail_opens
    where tracking_id = p_tracking and opened_at > clock_timestamp() - interval '2 minutes'
  ) then
    return false;
  end if;
  if (select count(*) from crm.mail_opens where tracking_id = p_tracking) >= 200 then
    return false;
  end if;
  insert into crm.mail_opens (tracking_id, workspace_id, user_id, agent)
  values (p_tracking, v_tracking.workspace_id, v_tracking.user_id, left(p_agent, 120));
  return true;
end;
$$;

revoke all on function private.record_mail_open(uuid, text, text) from public;
grant execute on function private.record_mail_open(uuid, text, text) to crm_app;
