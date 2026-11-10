update crm.workspace_brands b
set eclipse_tools = false
where b.eclipse_tools
  and b.workspace_id <> (
    select first.workspace_id
    from crm.workspace_brands first
    join crm.workspaces w on w.id = first.workspace_id
    where first.eclipse_tools
    order by w.created_at, w.id
    limit 1
  );

create unique index if not exists workspace_brands_one_eclipse_owner on crm.workspace_brands ((true)) where eclipse_tools;

alter table crm.workspace_brands add column if not exists eclipse_client_id text;
alter table crm.workspace_brands drop constraint if exists workspace_brands_eclipse_client_id_length;
alter table crm.workspace_brands add constraint workspace_brands_eclipse_client_id_length check (eclipse_client_id is null or char_length(eclipse_client_id) between 1 and 200);
create unique index if not exists workspace_brands_eclipse_client_unique on crm.workspace_brands (eclipse_client_id) where eclipse_client_id is not null;

revoke insert (eclipse_tools) on crm.workspace_brands from authenticated;
revoke update (eclipse_tools) on crm.workspace_brands from authenticated;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'crm' and table_name = 'workspace_brands' and column_name = 'eclipse_backfill'
  ) then
    alter table crm.workspace_brands add column eclipse_backfill boolean not null default false;
    insert into crm.workspace_brands (workspace_id, eclipse_backfill)
    select w.id, true from crm.workspaces w
    on conflict (workspace_id) do update set eclipse_backfill = true
    where crm.workspace_brands.eclipse_client_id is null;
  end if;
end;
$$;

revoke insert (eclipse_client_id, eclipse_backfill) on crm.workspace_brands from authenticated;
revoke update (eclipse_client_id, eclipse_backfill) on crm.workspace_brands from authenticated;

create or replace function private.workspace_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(normalize(coalesce(p_name, ''), nfkc), '[[:space:]]+', '', 'g'));
$$;

create or replace function private.unique_workspace_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.name is distinct from old.name and exists (
    select 1 from crm.workspaces w
    where w.id <> new.id and private.workspace_name_key(w.name) = private.workspace_name_key(new.name)
  ) then
    raise exception 'There is already a workspace called %.', btrim(new.name) using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_unique_name on crm.workspaces;
create trigger workspaces_unique_name
  before update of name on crm.workspaces
  for each row execute function private.unique_workspace_name();

create or replace function private.create_workspace(p_user uuid, p_name text, p_brand_source uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_workspace uuid;
  v_pipeline uuid;
  v_slug text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'user required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from crm.workspace_members m where m.user_id = p_user and m.role = 'owner'
  ) then
    raise exception 'Only workspace owners can create a workspace.' using errcode = '42501';
  end if;
  if char_length(v_name) = 0 then
    raise exception 'Give the workspace a name.' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Keep the name to 120 characters.' using errcode = '22023';
  end if;
  if exists (select 1 from crm.workspaces w where private.workspace_name_key(w.name) = private.workspace_name_key(v_name)) then
    raise exception 'There is already a workspace called %. Choose another name.', v_name using errcode = '22023';
  end if;
  if p_brand_source is not null and not exists (
    select 1 from crm.workspace_members m where m.user_id = p_user and m.workspace_id = p_brand_source
  ) then
    raise exception 'You can only copy from a workspace you are in.' using errcode = '42501';
  end if;

  loop
    v_slug := 'ws-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
    exit when not exists (select 1 from crm.workspaces w where w.slug = v_slug);
  end loop;

  insert into crm.workspaces (name, slug, brand_source_id)
  values (v_name, v_slug, p_brand_source)
  returning id into v_workspace;

  insert into crm.workspace_members (workspace_id, user_id, role)
  values (v_workspace, p_user, 'owner');

  insert into crm.pipelines (workspace_id, name, is_default)
  values (v_workspace, 'Default', true)
  returning id into v_pipeline;

  insert into crm.pipeline_stages
    (workspace_id, pipeline_id, name, position, probability, is_won, is_lost)
  values
    (v_workspace, v_pipeline, 'New', 0, 10, false, false),
    (v_workspace, v_pipeline, 'Working', 1, 30, false, false),
    (v_workspace, v_pipeline, 'Proposal', 2, 60, false, false),
    (v_workspace, v_pipeline, 'Won', 3, 100, true, false),
    (v_workspace, v_pipeline, 'Lost', 4, 0, false, true);

  insert into crm.capture_seen (workspace_id, user_id, seen_at)
  values (v_workspace, p_user, now())
  on conflict (workspace_id, user_id) do nothing;

  insert into crm.audit_events (
    workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, operation, changes
  )
  values (
    v_workspace,
    'workspace.created',
    'workspace',
    v_workspace,
    'user',
    p_user,
    'create_workspace',
    jsonb_build_object('name', v_name, 'brand_source_id', p_brand_source)
  );

  return v_workspace;
end;
$$;

revoke all on function private.create_workspace(uuid, text, uuid) from public;
grant execute on function private.create_workspace(uuid, text, uuid) to crm_app;

create or replace function private.owns_eclipse_brand(p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return exists (
    select 1
    from crm.workspace_brands b
    join crm.workspace_members m on m.workspace_id = b.workspace_id
    where b.eclipse_tools and m.user_id = p_user and m.role = 'owner'
  );
end;
$$;

revoke all on function private.owns_eclipse_brand(uuid) from public;
grant execute on function private.owns_eclipse_brand(uuid) to crm_app;

create or replace function private.link_eclipse_client(p_workspace uuid, p_client_id text, p_creator uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_workspace is null or nullif(btrim(coalesce(p_client_id, '')), '') is null then
    return false;
  end if;
  if exists (select 1 from crm.workspace_brands b where b.eclipse_client_id = p_client_id) then
    return false;
  end if;
  if p_creator is not null then
    if not private.owns_eclipse_brand(p_creator) then
      return false;
    end if;
    if not exists (
      select 1 from crm.workspaces w
      join crm.workspace_members m on m.workspace_id = w.id
      where w.id = p_workspace and m.user_id = p_creator and m.role = 'owner'
        and w.created_at > now() - interval '15 minutes'
    ) then
      return false;
    end if;
    if exists (select 1 from crm.workspace_brands b where b.workspace_id = p_workspace and b.eclipse_client_id is not null) then
      return false;
    end if;
    insert into crm.workspace_brands (workspace_id, eclipse_client_id)
    values (p_workspace, p_client_id)
    on conflict (workspace_id) do update set eclipse_client_id = excluded.eclipse_client_id, eclipse_backfill = false
    where crm.workspace_brands.eclipse_client_id is null;
    return found;
  end if;
  update crm.workspace_brands
  set eclipse_client_id = p_client_id, eclipse_backfill = false
  where workspace_id = p_workspace and eclipse_backfill and eclipse_client_id is null;
  return found;
exception
  when unique_violation then
    return false;
end;
$$;

revoke all on function private.link_eclipse_client(uuid, text, uuid) from public;
grant execute on function private.link_eclipse_client(uuid, text, uuid) to crm_app;

drop function if exists private.other_eclipse_workspaces(uuid);

create or replace function private.other_eclipse_workspaces(p_workspace_id uuid)
returns table (eclipse_client_id text)
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
  select b.eclipse_client_id
  from crm.workspace_brands b
  where b.workspace_id <> p_workspace_id and b.eclipse_client_id is not null;
end;
$$;

revoke all on function private.other_eclipse_workspaces(uuid) from public;
grant execute on function private.other_eclipse_workspaces(uuid) to crm_app;

drop function if exists private.other_workspace_names(uuid);

do $$
begin
  if to_regclass('crm.integration_settings') is null then
    create table crm.integration_settings (
      integration text primary key,
      workspace_id uuid not null references crm.workspaces (id) on delete cascade,
      connected_by uuid references crm.profiles (id) on delete set null,
      created_at timestamptz not null default now(),
      constraint integration_settings_integration check (integration in ('linear'))
    );
    insert into crm.integration_settings (integration, workspace_id)
    select 'linear', b.workspace_id
    from crm.workspace_brands b
    where b.eclipse_tools
    limit 1
    on conflict (integration) do nothing;
  end if;
end;
$$;

create index if not exists integration_settings_workspace_idx on crm.integration_settings (workspace_id);
create index if not exists integration_settings_connected_by_idx on crm.integration_settings (connected_by);

alter table crm.integration_settings enable row level security;
alter table crm.integration_settings force row level security;

drop policy if exists integration_settings_read on crm.integration_settings;
create policy integration_settings_read on crm.integration_settings
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

drop policy if exists integration_settings_admin_insert on crm.integration_settings;
create policy integration_settings_admin_insert on crm.integration_settings
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and private.is_workspace_admin(workspace_id)
    and connected_by = (select private.session_user_id())
  );

drop policy if exists integration_settings_admin_delete on crm.integration_settings;
create policy integration_settings_admin_delete on crm.integration_settings
  for delete to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));

revoke all on crm.integration_settings from anon, authenticated, crm_agent;
grant select, delete on crm.integration_settings to authenticated;
grant insert (integration, workspace_id, connected_by) on crm.integration_settings to authenticated;

create or replace function private.integration_claimed(p_integration text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return exists (select 1 from crm.integration_settings s where s.integration = p_integration);
end;
$$;

revoke all on function private.integration_claimed(text) from public;
grant execute on function private.integration_claimed(text) to crm_app;

alter table crm.memories add column if not exists source text;

update crm.memories
set source = case
  when origin = 'manual' then 'manual'
  when origin = 'assistant' then 'chat'
  when scope = 'market' then 'market'
  when scope = 'business' then 'learned'
  else 'chat'
end
where source is null;

alter table crm.memories alter column source set default 'chat';
alter table crm.memories alter column source set not null;
alter table crm.memories drop constraint if exists memories_source;
alter table crm.memories add constraint memories_source check (source in ('chat', 'manual', 'crm', 'learned', 'email', 'call', 'web', 'market'));

alter table crm.ai_companion_jobs add column if not exists outside_read boolean not null default false;
alter table crm.ai_companion_jobs add column if not exists seen_urls text[] not null default '{}';
alter table crm.ai_companion_jobs drop constraint if exists ai_companion_jobs_seen_urls_count;
alter table crm.ai_companion_jobs add constraint ai_companion_jobs_seen_urls_count check (cardinality(seen_urls) <= 5000);

grant update (outside_read, seen_urls) on crm.ai_companion_jobs to authenticated;
