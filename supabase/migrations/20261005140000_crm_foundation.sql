-- CRM foundation: tenancy, agent identities, companies, and the tables the
-- later relationship model needs. Business tables live in schema crm so they
-- are not exposed through the Supabase Data API. Access is granted only to
-- authenticated (human sessions) and crm_agent (machine sessions), and RLS
-- constrains both.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'crm_agent') then
    create role crm_agent nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'crm_app') then
    create role crm_app login password 'crm_app_dev' nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end
$$;

grant authenticated to crm_app;
grant crm_agent to crm_app;

create schema if not exists crm;
create schema if not exists private;

revoke all on schema crm from public;
revoke all on schema private from public;
grant usage on schema crm to crm_app, authenticated, crm_agent;
grant usage on schema private to crm_app;

create table crm.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_name_length check (char_length(name) between 1 and 120),
  constraint workspaces_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint workspaces_slug_key unique (slug)
);

create table crm.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_full_name_length check (full_name is null or char_length(full_name) <= 120),
  constraint profiles_email_length check (email is null or char_length(email) <= 320)
);

create table crm.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  constraint workspace_members_role check (role in ('owner', 'admin', 'member')),
  constraint workspace_members_unique unique (workspace_id, user_id)
);

create table crm.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  name text not null,
  description text,
  enabled boolean not null default true,
  scopes text[] not null,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint agents_name_length check (char_length(name) between 1 and 120),
  constraint agents_description_length check (description is null or char_length(description) <= 2000),
  constraint agents_scopes_valid check (
    scopes <@ array[
      'crm:read',
      'companies:write',
      'contacts:write',
      'leads:write',
      'activities:write',
      'opportunities:write',
      'tasks:write',
      'admin'
    ]::text[]
    and cardinality(scopes) > 0
  )
);

create table crm.agent_credentials (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references crm.agents (id) on delete cascade,
  token_prefix text not null,
  token_hash text not null,
  revoked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint agent_credentials_hash_key unique (token_hash),
  constraint agent_credentials_prefix_length check (char_length(token_prefix) between 4 and 32)
);

create table crm.pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipelines_name_length check (char_length(name) between 1 and 120)
);

create unique index pipelines_one_default_uidx
  on crm.pipelines (workspace_id)
  where is_default and archived_at is null;

create table crm.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  pipeline_id uuid not null references crm.pipelines (id) on delete cascade,
  name text not null,
  position integer not null,
  probability smallint not null default 0,
  is_won boolean not null default false,
  is_lost boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipeline_stages_name_length check (char_length(name) between 1 and 80),
  constraint pipeline_stages_position check (position >= 0),
  constraint pipeline_stages_probability check (probability between 0 and 100),
  constraint pipeline_stages_closed_exclusive check (not (is_won and is_lost)),
  constraint pipeline_stages_pipeline_position unique (pipeline_id, position),
  constraint pipeline_stages_pipeline_name unique (pipeline_id, name),
  constraint pipeline_stages_id_pipeline unique (id, pipeline_id)
);

create table crm.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  name text not null,
  normalized_name text not null,
  domain text,
  website text,
  description text,
  industry text,
  size_category text,
  lifecycle text not null default 'lead',
  owner_id uuid references crm.profiles (id) on delete set null,
  source text,
  source_reference text,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_by_agent_id uuid references crm.agents (id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_name_length check (char_length(name) between 1 and 200),
  constraint companies_normalized_name_length check (char_length(normalized_name) between 1 and 200),
  constraint companies_domain_format check (
    domain is null
    or domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  constraint companies_lifecycle check (lifecycle in ('lead', 'prospect', 'customer', 'churned')),
  constraint companies_size_length check (size_category is null or char_length(size_category) <= 80),
  constraint companies_description_length check (description is null or char_length(description) <= 10000),
  constraint companies_industry_length check (industry is null or char_length(industry) <= 120),
  constraint companies_website_length check (website is null or char_length(website) <= 500),
  constraint companies_source_length check (source is null or char_length(source) <= 120),
  constraint companies_source_reference_length check (
    source_reference is null or char_length(source_reference) <= 500
  ),
  constraint companies_actor_exclusive check (num_nonnulls(created_by_user_id, created_by_agent_id) <= 1)
);

create unique index companies_workspace_domain_active_uidx
  on crm.companies (workspace_id, domain)
  where domain is not null and archived_at is null;

create unique index companies_workspace_name_without_domain_uidx
  on crm.companies (workspace_id, normalized_name)
  where domain is null and archived_at is null;

create index companies_workspace_updated_idx
  on crm.companies (workspace_id, updated_at desc);

create index companies_workspace_normalized_name_idx
  on crm.companies (workspace_id, normalized_name)
  where archived_at is null;

create index companies_owner_id_idx on crm.companies (owner_id);
create index companies_created_by_user_idx on crm.companies (created_by_user_id);
create index companies_created_by_agent_idx on crm.companies (created_by_agent_id);
create index companies_name_trgm_idx on crm.companies using gin (name gin_trgm_ops);
create index companies_domain_trgm_idx on crm.companies using gin (domain gin_trgm_ops);

create table crm.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  company_id uuid references crm.companies (id) on delete restrict,
  first_name text,
  last_name text,
  email text,
  normalized_email text,
  phone text,
  job_title text,
  linkedin_url text,
  normalized_linkedin text,
  owner_id uuid references crm.profiles (id) on delete set null,
  source text,
  source_reference text,
  notes text,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_by_agent_id uuid references crm.agents (id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_identity check (
    nullif(trim(coalesce(first_name, '') || coalesce(last_name, '')), '') is not null
    or email is not null
    or phone is not null
    or linkedin_url is not null
  ),
  constraint contacts_actor_exclusive check (num_nonnulls(created_by_user_id, created_by_agent_id) <= 1)
);

create unique index contacts_workspace_email_active_uidx
  on crm.contacts (workspace_id, normalized_email)
  where normalized_email is not null and archived_at is null;

create unique index contacts_workspace_linkedin_active_uidx
  on crm.contacts (workspace_id, normalized_linkedin)
  where normalized_linkedin is not null and archived_at is null;

create index contacts_company_id_idx on crm.contacts (company_id);
create index contacts_workspace_id_idx on crm.contacts (workspace_id);
create index contacts_owner_id_idx on crm.contacts (owner_id);

create table crm.opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  company_id uuid not null references crm.companies (id) on delete restrict,
  primary_contact_id uuid references crm.contacts (id) on delete set null,
  pipeline_id uuid references crm.pipelines (id) on delete restrict,
  stage_id uuid,
  name text not null,
  value numeric(14, 2),
  currency text not null default 'USD',
  probability smallint,
  expected_close_date date,
  owner_id uuid references crm.profiles (id) on delete set null,
  status text not null default 'open',
  source text,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_by_agent_id uuid references crm.agents (id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunities_name_length check (char_length(name) between 1 and 200),
  constraint opportunities_currency check (currency ~ '^[A-Z]{3}$'),
  constraint opportunities_probability check (probability is null or probability between 0 and 100),
  constraint opportunities_value check (value is null or value >= 0),
  constraint opportunities_status check (status in ('open', 'won', 'lost')),
  constraint opportunities_stage_pair check (
    (stage_id is null and pipeline_id is null) or (stage_id is not null and pipeline_id is not null)
  ),
  constraint opportunities_stage_fk foreign key (stage_id, pipeline_id)
    references crm.pipeline_stages (id, pipeline_id),
  constraint opportunities_actor_exclusive check (num_nonnulls(created_by_user_id, created_by_agent_id) <= 1)
);

create index opportunities_company_id_idx on crm.opportunities (company_id);
create index opportunities_workspace_id_idx on crm.opportunities (workspace_id);
create index opportunities_stage_id_idx on crm.opportunities (stage_id);
create index opportunities_owner_id_idx on crm.opportunities (owner_id);
create index opportunities_primary_contact_idx on crm.opportunities (primary_contact_id);

create table crm.activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  type text not null,
  title text,
  body text,
  occurred_at timestamptz not null default now(),
  company_id uuid references crm.companies (id) on delete restrict,
  contact_id uuid references crm.contacts (id) on delete restrict,
  opportunity_id uuid references crm.opportunities (id) on delete restrict,
  actor_user_id uuid,
  actor_agent_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint activities_type check (
    type in ('email', 'meeting', 'call', 'note', 'research', 'linkedin', 'agent_update', 'other')
  ),
  constraint activities_subject check (
    company_id is not null or contact_id is not null or opportunity_id is not null
  )
);

create index activities_company_id_idx on crm.activities (company_id, occurred_at desc);
create index activities_contact_id_idx on crm.activities (contact_id, occurred_at desc);
create index activities_opportunity_id_idx on crm.activities (opportunity_id, occurred_at desc);
create index activities_workspace_occurred_idx on crm.activities (workspace_id, occurred_at desc);

create table crm.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  title text not null,
  description text,
  due_at timestamptz,
  completed_at timestamptz,
  priority text not null default 'normal',
  owner_id uuid references crm.profiles (id) on delete set null,
  company_id uuid references crm.companies (id) on delete restrict,
  contact_id uuid references crm.contacts (id) on delete restrict,
  opportunity_id uuid references crm.opportunities (id) on delete restrict,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_by_agent_id uuid references crm.agents (id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_title_length check (char_length(title) between 1 and 200),
  constraint tasks_priority check (priority in ('low', 'normal', 'high')),
  constraint tasks_actor_exclusive check (num_nonnulls(created_by_user_id, created_by_agent_id) <= 1)
);

create index tasks_workspace_due_idx on crm.tasks (workspace_id, due_at);
create index tasks_owner_id_idx on crm.tasks (owner_id);
create index tasks_company_id_idx on crm.tasks (company_id);
create index tasks_contact_id_idx on crm.tasks (contact_id);
create index tasks_opportunity_id_idx on crm.tasks (opportunity_id);

create table crm.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  event_type text not null,
  entity_type text not null,
  entity_id uuid not null,
  actor_type text not null,
  actor_user_id uuid,
  actor_agent_id uuid,
  credential_id uuid,
  source text,
  source_url text,
  operation text not null,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_events_actor_type check (actor_type in ('user', 'agent', 'system')),
  constraint audit_events_actor_shape check (
    (actor_type <> 'user' or actor_user_id is not null)
    and (actor_type <> 'agent' or actor_agent_id is not null)
  ),
  constraint audit_events_type_length check (char_length(event_type) between 1 and 80),
  constraint audit_events_operation_length check (char_length(operation) between 1 and 80)
);

create index audit_events_entity_idx
  on crm.audit_events (workspace_id, entity_type, entity_id, created_at desc);
create index audit_events_created_idx on crm.audit_events (created_at, id);

create table crm.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  actor_key text not null,
  idempotency_key text not null,
  request_hash text not null,
  status_code integer not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  constraint idempotency_keys_unique unique (workspace_id, actor_key, idempotency_key),
  constraint idempotency_keys_length check (char_length(idempotency_key) between 1 and 200)
);

create index idempotency_keys_workspace_idx on crm.idempotency_keys (workspace_id);

create index workspace_members_user_idx on crm.workspace_members (user_id);
create index workspace_members_workspace_idx on crm.workspace_members (workspace_id);
create index agents_workspace_idx on crm.agents (workspace_id);
create index agent_credentials_agent_idx on crm.agent_credentials (agent_id);
create index pipelines_workspace_idx on crm.pipelines (workspace_id);
create index pipeline_stages_pipeline_idx on crm.pipeline_stages (pipeline_id);
create index pipeline_stages_workspace_idx on crm.pipeline_stages (workspace_id);
create index profiles_email_idx on crm.profiles (email);

create table private.rate_limit_buckets (
  bucket_key text primary key,
  window_start timestamptz not null,
  request_count integer not null
);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.reject_audit_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_events is append-only' using errcode = '55000';
end;
$$;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into crm.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(profiles.full_name, excluded.full_name);
  return new;
end;
$$;

create or replace function private.companies_owner_is_member()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is not null and not exists (
    select 1
    from crm.workspace_members m
    where m.workspace_id = new.workspace_id
      and m.user_id = new.owner_id
  ) then
    raise exception 'owner is not a member of the workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function private.user_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id
  from crm.workspace_members m
  where m.user_id = (select auth.uid())
$$;

create or replace function private.request_workspace_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.workspace_id', true), '')::uuid
$$;

create or replace function private.ensure_personal_workspace(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
  created uuid;
  created_pipeline uuid;
  slug text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'user required' using errcode = '22023';
  end if;

  select m.workspace_id
  into existing
  from crm.workspace_members m
  where m.user_id = p_user_id
  order by m.created_at
  limit 1;

  if existing is not null then
    return existing;
  end if;

  slug := 'ws-' || substr(replace(p_user_id::text, '-', ''), 1, 16);

  insert into crm.workspaces (name, slug)
  values ('My workspace', slug)
  returning id into created;

  insert into crm.workspace_members (workspace_id, user_id, role)
  values (created, p_user_id, 'owner');

  insert into crm.pipelines (workspace_id, name, is_default)
  values (created, 'Default', true)
  returning id into created_pipeline;

  insert into crm.pipeline_stages
    (workspace_id, pipeline_id, name, position, probability, is_won, is_lost)
  values
    (created, created_pipeline, 'New', 0, 10, false, false),
    (created, created_pipeline, 'Working', 1, 30, false, false),
    (created, created_pipeline, 'Proposal', 2, 60, false, false),
    (created, created_pipeline, 'Won', 3, 100, true, false),
    (created, created_pipeline, 'Lost', 4, 0, false, true);

  insert into crm.audit_events (
    workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, operation, changes
  )
  values (
    created,
    'workspace.created',
    'workspace',
    created,
    'system',
    null,
    'ensure_personal_workspace',
    jsonb_build_object('user_id', p_user_id)
  );

  return created;
end;
$$;

create or replace function private.create_local_user(
  p_email text,
  p_password text,
  p_full_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'invalid email' using errcode = '22023';
  end if;
  if p_password is null or char_length(p_password) < 8 then
    raise exception 'password must be at least 8 characters' using errcode = '22023';
  end if;

  insert into auth.users (email, encrypted_password, raw_user_meta_data)
  values (
    lower(trim(p_email)),
    public.crypt(p_password, public.gen_salt('bf')),
    jsonb_build_object('full_name', nullif(trim(coalesce(p_full_name, '')), ''))
  )
  returning id into created;

  return created;
end;
$$;

create or replace function private.verify_local_password(p_email text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  found uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select u.id
  into found
  from auth.users u
  where u.email = lower(trim(p_email))
    and u.encrypted_password = public.crypt(p_password, u.encrypted_password);

  return found;
end;
$$;

create or replace function private.memberships_for(p_user_id uuid)
returns table (
  workspace_id uuid,
  workspace_name text,
  workspace_slug text,
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
  select w.id, w.name, w.slug, m.role, p.email, p.full_name
  from crm.workspace_members m
  join crm.workspaces w on w.id = m.workspace_id
  join crm.profiles p on p.id = m.user_id
  where m.user_id = p_user_id
  order by m.created_at;
end;
$$;

create or replace function private.authenticate_agent(p_token_hash text)
returns table (
  agent_id uuid,
  workspace_id uuid,
  credential_id uuid,
  agent_name text,
  scopes text[],
  enabled boolean
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
  select a.id, a.workspace_id, c.id, a.name, a.scopes, a.enabled
  from crm.agent_credentials c
  join crm.agents a on a.id = c.agent_id
  where c.token_hash = p_token_hash
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now());
end;
$$;

create or replace function private.touch_agent_credential(p_credential_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update crm.agent_credentials
  set last_used_at = now()
  where id = p_credential_id
    and (last_used_at is null or last_used_at < now() - interval '1 minute');

  update crm.agents a
  set last_used_at = now()
  from crm.agent_credentials c
  where c.id = p_credential_id
    and a.id = c.agent_id
    and (a.last_used_at is null or a.last_used_at < now() - interval '1 minute');
end;
$$;

create or replace function private.consume_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  v_count integer;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into private.rate_limit_buckets as buckets (bucket_key, window_start, request_count)
  values (p_key, v_window, 1)
  on conflict (bucket_key) do update
    set request_count = case
          when buckets.window_start = excluded.window_start then buckets.request_count + 1
          else 1
        end,
        window_start = excluded.window_start
  returning request_count into v_count;

  return v_count <= p_limit;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create trigger workspaces_set_updated_at
  before update on crm.workspaces
  for each row execute function private.set_updated_at();
create trigger profiles_set_updated_at
  before update on crm.profiles
  for each row execute function private.set_updated_at();
create trigger agents_set_updated_at
  before update on crm.agents
  for each row execute function private.set_updated_at();
create trigger pipelines_set_updated_at
  before update on crm.pipelines
  for each row execute function private.set_updated_at();
create trigger pipeline_stages_set_updated_at
  before update on crm.pipeline_stages
  for each row execute function private.set_updated_at();
create trigger companies_set_updated_at
  before update on crm.companies
  for each row execute function private.set_updated_at();
create trigger contacts_set_updated_at
  before update on crm.contacts
  for each row execute function private.set_updated_at();
create trigger opportunities_set_updated_at
  before update on crm.opportunities
  for each row execute function private.set_updated_at();
create trigger tasks_set_updated_at
  before update on crm.tasks
  for each row execute function private.set_updated_at();

create trigger companies_owner_is_member
  before insert or update of owner_id, workspace_id on crm.companies
  for each row execute function private.companies_owner_is_member();

create trigger audit_events_append_only
  before update or delete on crm.audit_events
  for each row execute function private.reject_audit_change();

alter table crm.workspaces enable row level security;
alter table crm.workspaces force row level security;
alter table crm.profiles enable row level security;
alter table crm.profiles force row level security;
alter table crm.workspace_members enable row level security;
alter table crm.workspace_members force row level security;
alter table crm.agents enable row level security;
alter table crm.agents force row level security;
alter table crm.agent_credentials enable row level security;
alter table crm.agent_credentials force row level security;
alter table crm.pipelines enable row level security;
alter table crm.pipelines force row level security;
alter table crm.pipeline_stages enable row level security;
alter table crm.pipeline_stages force row level security;
alter table crm.companies enable row level security;
alter table crm.companies force row level security;
alter table crm.contacts enable row level security;
alter table crm.contacts force row level security;
alter table crm.opportunities enable row level security;
alter table crm.opportunities force row level security;
alter table crm.activities enable row level security;
alter table crm.activities force row level security;
alter table crm.tasks enable row level security;
alter table crm.tasks force row level security;
alter table crm.audit_events enable row level security;
alter table crm.audit_events force row level security;
alter table crm.idempotency_keys enable row level security;
alter table crm.idempotency_keys force row level security;

create policy workspaces_select_member on crm.workspaces
  for select to authenticated
  using (id in (select private.user_workspace_ids()));
create policy workspaces_select_agent on crm.workspaces
  for select to crm_agent
  using (id = (select private.request_workspace_id()));

create policy profiles_select_member on crm.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1
      from crm.workspace_members mine
      join crm.workspace_members theirs on theirs.workspace_id = mine.workspace_id
      where mine.user_id = (select auth.uid())
        and theirs.user_id = profiles.id
    )
  );
create policy profiles_update_self on crm.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
create policy profiles_select_agent on crm.profiles
  for select to crm_agent
  using (
    exists (
      select 1
      from crm.workspace_members m
      where m.user_id = profiles.id
        and m.workspace_id = (select private.request_workspace_id())
    )
  );

create policy members_select_member on crm.workspace_members
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));
create policy members_select_agent on crm.workspace_members
  for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));

-- Agents and credentials are read through private.authenticate_agent.
-- No policies for authenticated or crm_agent: direct table access is denied.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'pipelines',
    'pipeline_stages',
    'companies',
    'contacts',
    'opportunities',
    'activities',
    'tasks'
  ]
  loop
    execute format(
      'create policy %I on crm.%I for select to authenticated using (workspace_id in (select private.user_workspace_ids()))',
      table_name || '_select_member',
      table_name
    );
    execute format(
      'create policy %I on crm.%I for insert to authenticated with check (workspace_id in (select private.user_workspace_ids()))',
      table_name || '_insert_member',
      table_name
    );
    execute format(
      'create policy %I on crm.%I for update to authenticated using (workspace_id in (select private.user_workspace_ids())) with check (workspace_id in (select private.user_workspace_ids()))',
      table_name || '_update_member',
      table_name
    );
    execute format(
      'create policy %I on crm.%I for select to crm_agent using (workspace_id = (select private.request_workspace_id()))',
      table_name || '_select_agent',
      table_name
    );
    execute format(
      'create policy %I on crm.%I for insert to crm_agent with check (workspace_id = (select private.request_workspace_id()))',
      table_name || '_insert_agent',
      table_name
    );
    execute format(
      'create policy %I on crm.%I for update to crm_agent using (workspace_id = (select private.request_workspace_id())) with check (workspace_id = (select private.request_workspace_id()))',
      table_name || '_update_agent',
      table_name
    );
  end loop;
end
$$;

create policy audit_select_member on crm.audit_events
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));
create policy audit_insert_member on crm.audit_events
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()));
create policy audit_select_agent on crm.audit_events
  for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));
create policy audit_insert_agent on crm.audit_events
  for insert to crm_agent
  with check (workspace_id = (select private.request_workspace_id()));

create policy idempotency_select_member on crm.idempotency_keys
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));
create policy idempotency_insert_member on crm.idempotency_keys
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()));
create policy idempotency_select_agent on crm.idempotency_keys
  for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));
create policy idempotency_insert_agent on crm.idempotency_keys
  for insert to crm_agent
  with check (workspace_id = (select private.request_workspace_id()));

grant select on
  crm.workspaces,
  crm.profiles,
  crm.workspace_members,
  crm.pipelines,
  crm.pipeline_stages,
  crm.companies,
  crm.contacts,
  crm.opportunities,
  crm.activities,
  crm.tasks,
  crm.audit_events,
  crm.idempotency_keys
to authenticated, crm_agent;

grant insert, update on
  crm.pipelines,
  crm.pipeline_stages,
  crm.companies,
  crm.contacts,
  crm.opportunities,
  crm.activities,
  crm.tasks
to authenticated, crm_agent;

grant update on crm.profiles to authenticated;
grant insert on crm.audit_events, crm.idempotency_keys to authenticated, crm_agent;

revoke all on crm.agents, crm.agent_credentials from authenticated, crm_agent, anon;
revoke all on all tables in schema crm from anon;
revoke all on schema crm from anon;

revoke all on function private.set_updated_at() from public;
revoke all on function private.reject_audit_change() from public;
revoke all on function private.handle_new_user() from public;
revoke all on function private.companies_owner_is_member() from public;
revoke all on function private.user_workspace_ids() from public;
revoke all on function private.request_workspace_id() from public;
revoke all on function private.ensure_personal_workspace(uuid) from public;
revoke all on function private.create_local_user(text, text, text) from public;
revoke all on function private.verify_local_password(text, text) from public;
revoke all on function private.memberships_for(uuid) from public;
revoke all on function private.authenticate_agent(text) from public;
revoke all on function private.touch_agent_credential(uuid) from public;
revoke all on function private.consume_rate_limit(text, integer, integer) from public;

grant execute on function private.set_updated_at() to authenticated, crm_agent;
grant execute on function private.reject_audit_change() to authenticated, crm_agent;
grant execute on function private.companies_owner_is_member() to authenticated, crm_agent;
grant execute on function private.user_workspace_ids() to authenticated;
grant execute on function private.request_workspace_id() to authenticated, crm_agent;

grant execute on function private.ensure_personal_workspace(uuid) to crm_app;
grant execute on function private.create_local_user(text, text, text) to crm_app;
grant execute on function private.verify_local_password(text, text) to crm_app;
grant execute on function private.memberships_for(uuid) to crm_app;
grant execute on function private.authenticate_agent(text) to crm_app;
grant execute on function private.touch_agent_credential(uuid) to crm_app;
grant execute on function private.consume_rate_limit(text, integer, integer) to crm_app;
