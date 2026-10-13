create or replace function private.assert_same_workspace()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  payload jsonb := to_jsonb(new);
  previous jsonb;
  scope_changed boolean;
  company_id uuid := nullif(payload ->> 'company_id', '')::uuid;
  contact_id uuid := nullif(payload ->> 'contact_id', '')::uuid;
  opportunity_id uuid := nullif(payload ->> 'opportunity_id', '')::uuid;
  primary_contact_id uuid := nullif(payload ->> 'primary_contact_id', '')::uuid;
  stage_id uuid := nullif(payload ->> 'stage_id', '')::uuid;
  contact_company uuid;
  opportunity_company uuid;
  primary_company uuid;
begin
  if tg_op = 'UPDATE' then
    previous := to_jsonb(old);
  end if;
  scope_changed := previous is null
    or previous -> 'workspace_id' is distinct from payload -> 'workspace_id'
    or previous -> 'company_id' is distinct from payload -> 'company_id';

  if scope_changed and company_id is not null and not exists (
    select 1
    from crm.companies row
    where row.id = company_id
      and row.workspace_id = new.workspace_id
  ) then
    raise exception 'company belongs to another workspace' using errcode = '23514';
  end if;

  if contact_id is not null
    and (scope_changed or previous -> 'contact_id' is distinct from payload -> 'contact_id') then
    select row.company_id
    into contact_company
    from crm.contacts row
    where row.id = contact_id
      and row.workspace_id = new.workspace_id;
    if not found then
      raise exception 'contact belongs to another workspace' using errcode = '23514';
    end if;
    if company_id is not null and contact_company is not null and contact_company is distinct from company_id then
      raise exception 'contact belongs to a different company' using errcode = '23514';
    end if;
  end if;

  if primary_contact_id is not null
    and (
      scope_changed
      or previous -> 'primary_contact_id' is distinct from payload -> 'primary_contact_id'
    ) then
    select row.company_id
    into primary_company
    from crm.contacts row
    where row.id = primary_contact_id
      and row.workspace_id = new.workspace_id;
    if not found then
      raise exception 'contact belongs to another workspace' using errcode = '23514';
    end if;
    if company_id is not null and primary_company is not null and primary_company is distinct from company_id then
      raise exception 'contact belongs to a different company' using errcode = '23514';
    end if;
  end if;

  if opportunity_id is not null
    and (scope_changed or previous -> 'opportunity_id' is distinct from payload -> 'opportunity_id') then
    select row.company_id
    into opportunity_company
    from crm.opportunities row
    where row.id = opportunity_id
      and row.workspace_id = new.workspace_id;
    if not found then
      raise exception 'opportunity belongs to another workspace' using errcode = '23514';
    end if;
    if company_id is not null and opportunity_company is distinct from company_id then
      raise exception 'opportunity belongs to a different company' using errcode = '23514';
    end if;
  end if;

  if stage_id is not null
    and (
      previous is null
      or previous -> 'workspace_id' is distinct from payload -> 'workspace_id'
      or previous -> 'stage_id' is distinct from payload -> 'stage_id'
    )
    and not exists (
      select 1
      from crm.pipeline_stages row
      where row.id = stage_id
        and row.workspace_id = new.workspace_id
    ) then
    raise exception 'stage belongs to another workspace' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists contacts_same_workspace on crm.contacts;
create trigger contacts_same_workspace
  before insert or update of company_id, workspace_id on crm.contacts
  for each row execute function private.assert_same_workspace();

drop trigger if exists opportunities_same_workspace on crm.opportunities;
create trigger opportunities_same_workspace
  before insert or update of company_id, primary_contact_id, stage_id, workspace_id
  on crm.opportunities
  for each row execute function private.assert_same_workspace();

drop trigger if exists activities_same_workspace on crm.activities;
create trigger activities_same_workspace
  before insert or update of company_id, contact_id, opportunity_id, workspace_id
  on crm.activities
  for each row execute function private.assert_same_workspace();

drop trigger if exists tasks_same_workspace on crm.tasks;
create trigger tasks_same_workspace
  before insert or update of company_id, contact_id, opportunity_id, workspace_id
  on crm.tasks
  for each row execute function private.assert_same_workspace();

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
  if p_user_id is null then
    raise exception 'user required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

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

do $migration$
declare
  crypto_schema text;
begin
  select n.nspname
  into crypto_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto';

  execute format($sql$
create or replace function private.create_local_user(
  p_email text,
  p_password text,
  p_full_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  created uuid;
begin
  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'invalid email' using errcode = '22023';
  end if;
  if p_password is null or char_length(p_password) < 8 then
    raise exception 'password must be at least 8 characters' using errcode = '22023';
  end if;

  insert into auth.users (email, encrypted_password, raw_user_meta_data)
  values (
    lower(trim(p_email)),
    %1$I.crypt(p_password, %1$I.gen_salt('bf')),
    jsonb_build_object('full_name', nullif(trim(coalesce(p_full_name, '')), ''))
  )
  returning id into created;

  return created;
end;
$fn$;

create or replace function private.verify_local_password(p_email text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  found uuid;
begin
  select u.id
  into found
  from auth.users u
  where u.email = lower(trim(p_email))
    and u.encrypted_password = %1$I.crypt(p_password, u.encrypted_password);

  return found;
end;
$fn$;
$sql$, crypto_schema);
end
$migration$;

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

revoke all on function private.ensure_personal_workspace(uuid) from public;
revoke all on function private.create_local_user(text, text, text) from public;
revoke all on function private.verify_local_password(text, text) from public;
revoke all on function private.memberships_for(uuid) from public;
revoke all on function private.authenticate_agent(text) from public;
revoke all on function private.touch_agent_credential(uuid) from public;
revoke all on function private.consume_rate_limit(text, integer, integer) from public;

drop policy if exists activities_update_member on crm.activities;
drop policy if exists activities_update_agent on crm.activities;
revoke update on crm.activities from authenticated, crm_agent;
