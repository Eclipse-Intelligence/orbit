alter table crm.agents drop constraint if exists agents_scopes_valid;
alter table crm.agents
  add constraint agents_scopes_valid check (
    scopes <@ array['crm:read', 'companies:write', 'contacts:write', 'leads:write', 'activities:write', 'opportunities:write', 'tasks:write', 'market:write', 'admin']::text[]
    and cardinality(scopes) > 0
  );

create table if not exists crm.memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid references crm.profiles (id) on delete cascade,
  scope text not null,
  kind text not null,
  title text not null,
  body text not null,
  sources jsonb not null default '[]'::jsonb,
  confidence text not null default 'medium',
  pinned boolean not null default false,
  company_id uuid references crm.companies (id) on delete set null,
  origin text not null default 'learning',
  observed_at timestamptz not null default now(),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored,
  constraint memories_scope check (scope in ('personal', 'business', 'market')),
  constraint memories_scope_owner check ((scope = 'personal') = (user_id is not null)),
  constraint memories_kind check (char_length(kind) between 1 and 40),
  constraint memories_title_length check (char_length(title) between 1 and 160),
  constraint memories_body_length check (char_length(body) between 1 and 1200),
  constraint memories_sources_array check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) <= 10),
  constraint memories_confidence check (confidence in ('low', 'medium', 'high')),
  constraint memories_origin check (origin in ('learning', 'assistant', 'manual'))
);

create index if not exists memories_workspace_scope_idx on crm.memories (workspace_id, scope, updated_at desc) where archived_at is null;
create index if not exists memories_user_idx on crm.memories (user_id, updated_at desc) where archived_at is null;
create index if not exists memories_search_idx on crm.memories using gin (search);

drop trigger if exists memories_set_updated_at on crm.memories;
create trigger memories_set_updated_at
  before update on crm.memories
  for each row execute function private.set_updated_at();

create table if not exists crm.market_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  kind text not null default 'news',
  headline text not null,
  summary text,
  url text,
  about text,
  published_at timestamptz,
  company_id uuid references crm.companies (id) on delete set null,
  agent_id uuid references crm.agents (id) on delete set null,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint market_notes_kind check (kind in ('news', 'post', 'launch', 'hire', 'funding', 'signal', 'research', 'other')),
  constraint market_notes_headline_length check (char_length(headline) between 1 and 300),
  constraint market_notes_summary_length check (summary is null or char_length(summary) <= 2000),
  constraint market_notes_url check (url is null or (char_length(url) <= 1000 and url ~ '^https?://')),
  constraint market_notes_about_length check (about is null or char_length(about) <= 200)
);

create unique index if not exists market_notes_workspace_url_uidx on crm.market_notes (workspace_id, url) where url is not null;
create index if not exists market_notes_workspace_created_idx on crm.market_notes (workspace_id, created_at desc);
create index if not exists market_notes_unprocessed_idx on crm.market_notes (workspace_id, created_at) where processed_at is null;

create table if not exists crm.watchlist (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  kind text not null,
  label text not null,
  url text,
  notes text,
  company_id uuid references crm.companies (id) on delete set null,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint watchlist_kind check (kind in ('topic', 'competitor', 'person', 'account', 'source')),
  constraint watchlist_label_length check (char_length(label) between 1 and 160),
  constraint watchlist_url check (url is null or (char_length(url) <= 500 and url ~ '^https?://')),
  constraint watchlist_notes_length check (notes is null or char_length(notes) <= 500)
);

create unique index if not exists watchlist_workspace_label_uidx on crm.watchlist (workspace_id, kind, lower(label));

drop trigger if exists watchlist_set_updated_at on crm.watchlist;
create trigger watchlist_set_updated_at
  before update on crm.watchlist
  for each row execute function private.set_updated_at();

create table if not exists crm.learning_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid references crm.profiles (id) on delete cascade,
  kind text not null,
  status text not null default 'running',
  trigger text not null default 'nightly',
  summary jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint learning_runs_kind check (kind in ('personal', 'business', 'market', 'brief')),
  constraint learning_runs_status check (status in ('running', 'done', 'failed')),
  constraint learning_runs_trigger check (trigger in ('nightly', 'manual')),
  constraint learning_runs_owner check ((kind in ('personal', 'brief')) = (user_id is not null)),
  constraint learning_runs_error_length check (error is null or char_length(error) <= 1000)
);

create index if not exists learning_runs_unit_idx on crm.learning_runs (workspace_id, kind, user_id, started_at desc);

create table if not exists crm.daily_briefs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  day date not null,
  body text not null,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint daily_briefs_body_length check (char_length(body) between 1 and 8000),
  constraint daily_briefs_unique unique (user_id, day)
);

alter table crm.memories enable row level security;
alter table crm.memories force row level security;
alter table crm.market_notes enable row level security;
alter table crm.market_notes force row level security;
alter table crm.watchlist enable row level security;
alter table crm.watchlist force row level security;
alter table crm.learning_runs enable row level security;
alter table crm.learning_runs force row level security;
alter table crm.daily_briefs enable row level security;
alter table crm.daily_briefs force row level security;

drop policy if exists memories_member on crm.memories;
create policy memories_member on crm.memories for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and (user_id is null or user_id = (select auth.uid())))
  with check (workspace_id in (select private.user_workspace_ids()) and (user_id is null or user_id = (select auth.uid())));

drop policy if exists market_notes_member on crm.market_notes;
create policy market_notes_member on crm.market_notes for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists market_notes_agent on crm.market_notes;
create policy market_notes_agent on crm.market_notes for all to crm_agent
  using (workspace_id = (select private.request_workspace_id()))
  with check (workspace_id = (select private.request_workspace_id()));

drop policy if exists watchlist_member on crm.watchlist;
create policy watchlist_member on crm.watchlist for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists watchlist_agent on crm.watchlist;
create policy watchlist_agent on crm.watchlist for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));

drop policy if exists learning_runs_member on crm.learning_runs;
create policy learning_runs_member on crm.learning_runs for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and (user_id is null or user_id = (select auth.uid())))
  with check (workspace_id in (select private.user_workspace_ids()) and (user_id is null or user_id = (select auth.uid())));

drop policy if exists daily_briefs_owner on crm.daily_briefs;
create policy daily_briefs_owner on crm.daily_briefs for all to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select auth.uid()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.memories, crm.market_notes, crm.watchlist, crm.learning_runs, crm.daily_briefs from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.memories, crm.market_notes, crm.watchlist, crm.daily_briefs to authenticated;
grant select, insert, update on crm.learning_runs to authenticated;
grant select, insert on crm.market_notes to crm_agent;
grant select on crm.watchlist to crm_agent;

create or replace function private.issue_market_agent(p_workspace uuid, p_user uuid, p_name text, p_prefix text, p_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from crm.workspace_members m
    where m.workspace_id = p_workspace and m.user_id = p_user and m.role in ('owner', 'admin')
  ) then
    raise exception 'Only an owner or admin can connect a market agent.' using errcode = '42501';
  end if;
  select a.id into v_agent from crm.agents a
  where a.workspace_id = p_workspace and a.name = p_name and a.scopes = array['market:write']::text[]
  order by a.created_at limit 1;
  if v_agent is null then
    insert into crm.agents (workspace_id, name, description, scopes, created_by_user_id)
    values (p_workspace, p_name, 'Sends market notes to Orbit and reads the watchlist.', array['market:write']::text[], p_user)
    returning id into v_agent;
  else
    update crm.agents set enabled = true where id = v_agent;
    update crm.agent_credentials set revoked_at = now() where agent_id = v_agent and revoked_at is null;
  end if;
  insert into crm.agent_credentials (agent_id, token_prefix, token_hash) values (v_agent, p_prefix, p_hash);
  return v_agent;
end;
$$;

revoke all on function private.issue_market_agent(uuid, uuid, text, text, text) from public;
grant execute on function private.issue_market_agent(uuid, uuid, text, text, text) to crm_app;

create or replace function private.market_agent_status(p_workspace uuid, p_name text)
returns table (agent_id uuid, connected_at timestamptz, last_used_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, c.created_at, greatest(a.last_used_at, c.last_used_at)
  from crm.agents a
  join crm.agent_credentials c on c.agent_id = a.id and c.revoked_at is null
  where a.workspace_id = p_workspace and a.name = p_name and a.scopes = array['market:write']::text[] and a.enabled
    and current_user in ('crm_app', 'postgres')
  order by c.created_at desc
  limit 1
$$;

revoke all on function private.market_agent_status(uuid, text) from public;
grant execute on function private.market_agent_status(uuid, text) to crm_app;
