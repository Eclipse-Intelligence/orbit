create or replace function private.owner_is_member()
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

create or replace function private.assert_same_workspace()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  payload jsonb := to_jsonb(new);
  company_id uuid := nullif(payload ->> 'company_id', '')::uuid;
  contact_id uuid := nullif(payload ->> 'contact_id', '')::uuid;
  opportunity_id uuid := nullif(payload ->> 'opportunity_id', '')::uuid;
  primary_contact_id uuid := nullif(payload ->> 'primary_contact_id', '')::uuid;
  stage_id uuid := nullif(payload ->> 'stage_id', '')::uuid;
  contact_company uuid;
  opportunity_company uuid;
  primary_company uuid;
begin
  if company_id is not null and not exists (
    select 1
    from crm.companies row
    where row.id = company_id
      and row.workspace_id = new.workspace_id
  ) then
    raise exception 'company belongs to another workspace' using errcode = '23514';
  end if;

  if contact_id is not null then
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

  if primary_contact_id is not null then
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

  if opportunity_id is not null then
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

  if stage_id is not null and not exists (
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

drop trigger if exists contacts_owner_is_member on crm.contacts;
create trigger contacts_owner_is_member
  before insert or update of owner_id, workspace_id on crm.contacts
  for each row execute function private.owner_is_member();

drop trigger if exists opportunities_owner_is_member on crm.opportunities;
create trigger opportunities_owner_is_member
  before insert or update of owner_id, workspace_id on crm.opportunities
  for each row execute function private.owner_is_member();

drop trigger if exists tasks_owner_is_member on crm.tasks;
create trigger tasks_owner_is_member
  before insert or update of owner_id, workspace_id on crm.tasks
  for each row execute function private.owner_is_member();

drop trigger if exists contacts_same_workspace on crm.contacts;
create trigger contacts_same_workspace
  before insert or update on crm.contacts
  for each row execute function private.assert_same_workspace();

drop trigger if exists opportunities_same_workspace on crm.opportunities;
create trigger opportunities_same_workspace
  before insert or update on crm.opportunities
  for each row execute function private.assert_same_workspace();

drop trigger if exists activities_same_workspace on crm.activities;
create trigger activities_same_workspace
  before insert or update on crm.activities
  for each row execute function private.assert_same_workspace();

drop trigger if exists tasks_same_workspace on crm.tasks;
create trigger tasks_same_workspace
  before insert or update on crm.tasks
  for each row execute function private.assert_same_workspace();

create index if not exists contacts_name_trgm_idx
  on crm.contacts using gin ((lower(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) gin_trgm_ops);

create index if not exists contacts_email_trgm_idx
  on crm.contacts using gin (normalized_email gin_trgm_ops);

create index if not exists tasks_open_due_idx
  on crm.tasks (workspace_id, due_at)
  where completed_at is null and archived_at is null;

revoke all on function private.owner_is_member() from public;
revoke all on function private.assert_same_workspace() from public;
grant execute on function private.owner_is_member() to authenticated, crm_agent;
grant execute on function private.assert_same_workspace() to authenticated, crm_agent;
