create table if not exists crm.ai_companions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint ai_companions_name_length check (char_length(name) between 1 and 120)
);

create index if not exists ai_companions_user_idx on crm.ai_companions (user_id, workspace_id) where revoked_at is null;

create table if not exists crm.ai_companion_pairings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists ai_companion_pairings_user_idx on crm.ai_companion_pairings (user_id);

create table if not exists crm.ai_companion_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  conversation_id uuid not null references crm.assistant_conversations (id) on delete cascade,
  companion_id uuid references crm.ai_companions (id) on delete set null,
  status text not null default 'queued',
  request jsonb not null,
  events jsonb not null default '[]'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint ai_companion_jobs_status check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  constraint ai_companion_jobs_events_array check (jsonb_typeof(events) = 'array'),
  constraint ai_companion_jobs_error_length check (error is null or char_length(error) <= 2000)
);

create index if not exists ai_companion_jobs_queue_idx on crm.ai_companion_jobs (user_id, status, created_at);
create index if not exists ai_companion_jobs_conversation_idx on crm.ai_companion_jobs (conversation_id);
create index if not exists ai_companion_jobs_companion_idx on crm.ai_companion_jobs (companion_id);
create index if not exists ai_companion_jobs_workspace_idx on crm.ai_companion_jobs (workspace_id);

drop trigger if exists ai_companion_jobs_set_updated_at on crm.ai_companion_jobs;
create trigger ai_companion_jobs_set_updated_at
  before update on crm.ai_companion_jobs
  for each row execute function private.set_updated_at();

alter table crm.ai_companions enable row level security;
alter table crm.ai_companions force row level security;
alter table crm.ai_companion_pairings enable row level security;
alter table crm.ai_companion_pairings force row level security;
alter table crm.ai_companion_jobs enable row level security;
alter table crm.ai_companion_jobs force row level security;

drop policy if exists ai_companions_owner on crm.ai_companions;
create policy ai_companions_owner on crm.ai_companions
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists ai_companion_pairings_owner on crm.ai_companion_pairings;
create policy ai_companion_pairings_owner on crm.ai_companion_pairings
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists ai_companion_jobs_owner on crm.ai_companion_jobs;
create policy ai_companion_jobs_owner on crm.ai_companion_jobs
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and conversation_id in (
      select c.id from crm.assistant_conversations c where c.user_id = (select private.session_user_id())
    )
  );

revoke all on crm.ai_companions from anon, authenticated, crm_agent;
revoke all on crm.ai_companion_pairings from anon, authenticated, crm_agent;
revoke all on crm.ai_companion_jobs from anon, authenticated, crm_agent;
grant select (id, workspace_id, user_id, name, created_at, last_seen_at, revoked_at) on crm.ai_companions to authenticated;
grant update (revoked_at) on crm.ai_companions to authenticated;
grant select, insert, delete on crm.ai_companion_pairings to authenticated;
grant select, insert on crm.ai_companion_jobs to authenticated;
grant update (companion_id, status, events, result, error, claimed_at, finished_at, updated_at) on crm.ai_companion_jobs to authenticated;

create or replace function private.authenticate_companion(p_token_hash text)
returns table (companion_id uuid, user_id uuid, workspace_id uuid, name text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update crm.ai_companions c
  set last_seen_at = now()
  where c.token_hash = p_token_hash
    and c.revoked_at is null
    and (c.last_seen_at is null or c.last_seen_at < now() - interval '5 seconds');

  return query
  select c.id, c.user_id, c.workspace_id, c.name
  from crm.ai_companions c
  join crm.workspace_members m on m.user_id = c.user_id and m.workspace_id = c.workspace_id
  where c.token_hash = p_token_hash
    and c.revoked_at is null;
end;
$$;

create or replace function private.redeem_companion_pairing(p_code_hash text, p_token_hash text, p_name text)
returns table (companion_id uuid, user_id uuid, workspace_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pairing crm.ai_companion_pairings;
  v_id uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update crm.ai_companion_pairings p
  set used_at = now()
  where p.code_hash = p_code_hash
    and p.used_at is null
    and p.expires_at > now()
  returning * into v_pairing;

  if v_pairing.id is null then
    return;
  end if;

  insert into crm.ai_companions (workspace_id, user_id, name, token_hash, last_seen_at)
  values (v_pairing.workspace_id, v_pairing.user_id, left(coalesce(nullif(trim(p_name), ''), 'Mac'), 120), p_token_hash, now())
  returning id into v_id;

  return query select v_id, v_pairing.user_id, v_pairing.workspace_id;
end;
$$;

revoke all on function private.authenticate_companion(text) from public;
revoke all on function private.redeem_companion_pairing(text, text, text) from public;
grant execute on function private.authenticate_companion(text) to crm_app;
grant execute on function private.redeem_companion_pairing(text, text, text) to crm_app;

delete from crm.ai_accounts where provider = 'claude';
alter table crm.ai_accounts drop constraint if exists ai_accounts_provider;
alter table crm.ai_accounts add constraint ai_accounts_provider check (provider in ('chatgpt'));
