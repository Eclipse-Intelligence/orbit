alter table crm.call_insights drop constraint if exists call_insights_source;
alter table crm.call_insights
  add constraint call_insights_source check (source in ('teams', 'manual', 'granola'));

alter table crm.call_records add column if not exists teams_call_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'call_records_teams_call_id_length'
      and conrelid = 'crm.call_records'::regclass
  ) then
    alter table crm.call_records
      add constraint call_records_teams_call_id_length
      check (teams_call_id is null or char_length(teams_call_id) <= 200);
  end if;
end;
$$;

create index if not exists call_records_teams_call_idx
  on crm.call_records (workspace_id, teams_call_id)
  where teams_call_id is not null;

grant update (teams_call_id) on crm.call_records to authenticated;

create table if not exists crm.conversation_imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid references crm.profiles (id) on delete cascade,
  source text not null,
  external_id text not null,
  kind text not null,
  call_id text,
  title text,
  occurred_at timestamptz,
  ended_at timestamptz,
  participants jsonb not null default '[]'::jsonb,
  external_url text,
  transcript text,
  source_summary text,
  status text not null default 'pending',
  activity_id uuid references crm.activities (id) on delete set null,
  contact_id uuid references crm.contacts (id) on delete set null,
  company_id uuid references crm.companies (id) on delete set null,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversation_imports_source check (source in ('granola', 'teams')),
  constraint conversation_imports_kind check (kind in ('meeting', 'call')),
  constraint conversation_imports_status check (status in ('pending', 'filed', 'unfiled', 'ignored')),
  constraint conversation_imports_teams_owner check (source <> 'teams' or user_id is not null),
  constraint conversation_imports_external_length check (char_length(external_id) between 1 and 400),
  constraint conversation_imports_call_id_length check (call_id is null or char_length(call_id) <= 200),
  constraint conversation_imports_title_length check (title is null or char_length(title) <= 500),
  constraint conversation_imports_url_length check (external_url is null or char_length(external_url) <= 2000),
  constraint conversation_imports_transcript_length check (transcript is null or char_length(transcript) <= 1000000),
  constraint conversation_imports_summary_length check (source_summary is null or char_length(source_summary) <= 100000),
  constraint conversation_imports_error_length check (error is null or char_length(error) <= 1000),
  constraint conversation_imports_attempts check (attempts >= 0),
  constraint conversation_imports_participants_array check (jsonb_typeof(participants) = 'array')
);

alter table crm.conversation_imports drop constraint if exists conversation_imports_external_unique;

create unique index if not exists conversation_imports_granola_key
  on crm.conversation_imports (workspace_id, external_id)
  where source = 'granola';
create unique index if not exists conversation_imports_teams_key
  on crm.conversation_imports (user_id, external_id)
  where source = 'teams';
create index if not exists conversation_imports_status_idx
  on crm.conversation_imports (workspace_id, status, occurred_at desc);
create index if not exists conversation_imports_call_idx
  on crm.conversation_imports (workspace_id, call_id)
  where call_id is not null;
create index if not exists conversation_imports_activity_idx on crm.conversation_imports (activity_id);
create index if not exists conversation_imports_contact_idx on crm.conversation_imports (contact_id);
create index if not exists conversation_imports_company_idx on crm.conversation_imports (company_id);
create index if not exists conversation_imports_user_idx on crm.conversation_imports (user_id);

drop trigger if exists conversation_imports_set_updated_at on crm.conversation_imports;
create trigger conversation_imports_set_updated_at
  before update on crm.conversation_imports
  for each row execute function private.set_updated_at();

alter table crm.conversation_imports enable row level security;
alter table crm.conversation_imports force row level security;

drop policy if exists conversation_imports_select_member on crm.conversation_imports;
create policy conversation_imports_select_member on crm.conversation_imports
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (source <> 'teams' or user_id = (select private.session_user_id()))
  );

drop policy if exists conversation_imports_insert_member on crm.conversation_imports;
create policy conversation_imports_insert_member on crm.conversation_imports
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (source <> 'teams' or user_id = (select private.session_user_id()))
  );

drop policy if exists conversation_imports_update_member on crm.conversation_imports;
create policy conversation_imports_update_member on crm.conversation_imports
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (source <> 'teams' or user_id = (select private.session_user_id()))
  )
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (source <> 'teams' or user_id = (select private.session_user_id()))
  );

revoke all on crm.conversation_imports from anon, authenticated, crm_agent;
grant select, insert on crm.conversation_imports to authenticated;
grant update (
  status, activity_id, contact_id, company_id, error, attempts, transcript,
  title, occurred_at, ended_at, participants, external_url, source_summary
) on crm.conversation_imports to authenticated;

create table if not exists crm.integration_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  source text not null,
  connection_id uuid references crm.mailbox_connections (id) on delete cascade,
  user_id uuid references crm.profiles (id) on delete cascade,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  webhook_id text,
  webhook_secret text,
  subscription_id text,
  subscription_expires_at timestamptz,
  client_state text,
  updated_at timestamptz not null default now(),
  constraint integration_state_source check (source in ('granola', 'teams_transcripts')),
  constraint integration_state_error_length check (last_error is null or char_length(last_error) <= 500),
  constraint integration_state_webhook_id_length check (webhook_id is null or char_length(webhook_id) <= 200),
  constraint integration_state_subscription_id_length check (subscription_id is null or char_length(subscription_id) <= 200)
);

alter table crm.integration_state
  add column if not exists connection_id uuid references crm.mailbox_connections (id) on delete cascade;
alter table crm.integration_state
  add column if not exists user_id uuid references crm.profiles (id) on delete cascade;
alter table crm.integration_state drop constraint if exists integration_state_unique;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'integration_state_teams_connection'
      and conrelid = 'crm.integration_state'::regclass
  ) then
    alter table crm.integration_state
      add constraint integration_state_teams_connection
      check (
        (source = 'teams_transcripts') = (connection_id is not null)
        and (source <> 'teams_transcripts' or user_id is not null)
      );
  end if;
end;
$$;

drop index if exists crm.integration_state_subscription_idx;
create unique index if not exists integration_state_workspace_key
  on crm.integration_state (workspace_id, source)
  where connection_id is null;
create unique index if not exists integration_state_connection_key
  on crm.integration_state (connection_id)
  where connection_id is not null;
create unique index if not exists integration_state_subscription_key
  on crm.integration_state (subscription_id)
  where subscription_id is not null;
create index if not exists integration_state_user_idx on crm.integration_state (user_id);

drop trigger if exists integration_state_set_updated_at on crm.integration_state;
create trigger integration_state_set_updated_at
  before update on crm.integration_state
  for each row execute function private.set_updated_at();

alter table crm.integration_state enable row level security;
alter table crm.integration_state force row level security;

drop policy if exists integration_state_select_member on crm.integration_state;
create policy integration_state_select_member on crm.integration_state
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (source <> 'teams_transcripts' or user_id = (select private.session_user_id()))
  );

drop policy if exists integration_state_insert_member on crm.integration_state;
create policy integration_state_insert_member on crm.integration_state
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (source <> 'teams_transcripts' or user_id = (select private.session_user_id()))
  );

drop policy if exists integration_state_update_member on crm.integration_state;
create policy integration_state_update_member on crm.integration_state
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (source <> 'teams_transcripts' or user_id = (select private.session_user_id()))
  )
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (source <> 'teams_transcripts' or user_id = (select private.session_user_id()))
  );

revoke all on crm.integration_state from anon, authenticated, crm_agent;
grant select, insert on crm.integration_state to authenticated;
grant update (
  user_id, last_synced_at, last_attempt_at, last_error, webhook_id, webhook_secret,
  subscription_id, subscription_expires_at, client_state
) on crm.integration_state to authenticated;

create table if not exists crm.webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  source text not null,
  message_id text not null,
  received_at timestamptz not null default now(),
  constraint webhook_receipts_source check (source in ('granola')),
  constraint webhook_receipts_message_length check (char_length(message_id) between 1 and 200),
  constraint webhook_receipts_unique unique (workspace_id, source, message_id)
);

create index if not exists webhook_receipts_received_idx
  on crm.webhook_receipts (workspace_id, received_at);

alter table crm.webhook_receipts enable row level security;
alter table crm.webhook_receipts force row level security;

drop policy if exists webhook_receipts_select_member on crm.webhook_receipts;
create policy webhook_receipts_select_member on crm.webhook_receipts
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

drop policy if exists webhook_receipts_insert_member on crm.webhook_receipts;
create policy webhook_receipts_insert_member on crm.webhook_receipts
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists webhook_receipts_delete_member on crm.webhook_receipts;
create policy webhook_receipts_delete_member on crm.webhook_receipts
  for delete to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

revoke all on crm.webhook_receipts from anon, authenticated, crm_agent;
grant select, insert, delete on crm.webhook_receipts to authenticated;

create or replace function private.background_members()
returns table (
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.workspace_members m
  join crm.workspaces w on w.id = m.workspace_id
  join crm.profiles p on p.id = m.user_id
  order by w.created_at, w.id,
    case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
    m.created_at;
end;
$$;

create or replace function private.granola_webhook_targets()
returns table (
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text,
  webhook_secret text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select s.workspace_id, w.name, m.user_id, m.role, p.email, p.full_name, s.webhook_secret
  from crm.integration_state s
  join crm.workspaces w on w.id = s.workspace_id
  join crm.workspace_members m on m.workspace_id = s.workspace_id and m.user_id = s.user_id
  join crm.profiles p on p.id = m.user_id
  where s.source = 'granola'
    and s.connection_id is null
    and s.webhook_secret is not null
  limit 20;
end;
$$;

create or replace function private.transcript_subscriptions(p_ids text[])
returns table (
  subscription_id text,
  client_state text,
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select s.subscription_id, s.client_state, s.workspace_id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.integration_state s
  join crm.workspaces w on w.id = s.workspace_id
  join crm.workspace_members m on m.workspace_id = s.workspace_id and m.user_id = s.user_id
  join crm.profiles p on p.id = m.user_id
  where s.source = 'teams_transcripts'
    and s.subscription_id = any(p_ids[1:50]);
end;
$$;

revoke all on function private.background_members() from public;
revoke all on function private.granola_webhook_targets() from public;
revoke all on function private.transcript_subscriptions(text[]) from public;
grant execute on function private.background_members() to crm_app;
grant execute on function private.granola_webhook_targets() to crm_app;
grant execute on function private.transcript_subscriptions(text[]) to crm_app;
