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

revoke insert (eclipse_tools) on crm.workspace_brands from authenticated;
revoke update (eclipse_tools) on crm.workspace_brands from authenticated;

create or replace function private.other_workspace_names(p_workspace_id uuid)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select w.name from crm.workspaces w where w.id <> p_workspace_id;
end;
$$;

revoke all on function private.other_workspace_names(uuid) from public;
grant execute on function private.other_workspace_names(uuid) to crm_app;

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
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));

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
  when scope = 'business' then 'crm'
  else 'chat'
end
where source is null;

alter table crm.memories alter column source set default 'chat';
alter table crm.memories alter column source set not null;
alter table crm.memories drop constraint if exists memories_source;
alter table crm.memories add constraint memories_source check (source in ('chat', 'manual', 'crm', 'email', 'call', 'web', 'market'));

alter table crm.ai_companion_jobs add column if not exists outside_read boolean not null default false;
alter table crm.ai_companion_jobs add column if not exists seen_urls text[] not null default '{}';
alter table crm.ai_companion_jobs drop constraint if exists ai_companion_jobs_seen_urls_count;
alter table crm.ai_companion_jobs add constraint ai_companion_jobs_seen_urls_count check (cardinality(seen_urls) <= 5000);

grant update (outside_read, seen_urls) on crm.ai_companion_jobs to authenticated;
