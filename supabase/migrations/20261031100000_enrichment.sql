alter table crm.companies add column if not exists linkedin_url text;
alter table crm.companies add column if not exists phone text;
alter table crm.companies add column if not exists address text;
alter table crm.companies add column if not exists logo_url text;
alter table crm.companies add column if not exists enriched_at timestamptz;

alter table crm.companies drop constraint if exists companies_linkedin_url_length;
alter table crm.companies add constraint companies_linkedin_url_length check (linkedin_url is null or char_length(linkedin_url) <= 500);
alter table crm.companies drop constraint if exists companies_phone_length;
alter table crm.companies add constraint companies_phone_length check (phone is null or char_length(phone) <= 60);
alter table crm.companies drop constraint if exists companies_address_length;
alter table crm.companies add constraint companies_address_length check (address is null or char_length(address) <= 500);
alter table crm.companies drop constraint if exists companies_logo_url_length;
alter table crm.companies add constraint companies_logo_url_length check (logo_url is null or char_length(logo_url) <= 1000);

create table if not exists crm.enrichment_settings (
  workspace_id uuid primary key references crm.workspaces (id) on delete cascade,
  email_order text[] not null default array['context', 'hunter', 'enrow', 'icypeas'],
  linkedin_order text[] not null default array['context', 'icypeas', 'hunter'],
  auto_companies boolean not null default true,
  updated_at timestamptz not null default now()
);

drop trigger if exists enrichment_settings_set_updated_at on crm.enrichment_settings;
create trigger enrichment_settings_set_updated_at
  before update on crm.enrichment_settings
  for each row execute function private.set_updated_at();

create table if not exists crm.enrichment_lookups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  record_type text not null,
  record_id uuid not null,
  field text not null,
  status text not null,
  provider text,
  value text,
  attempts jsonb not null default '[]'::jsonb,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint enrichment_lookups_record_type check (record_type in ('contact', 'company')),
  constraint enrichment_lookups_field check (field in ('email', 'linkedin', 'company')),
  constraint enrichment_lookups_status check (status in ('found', 'not_found', 'failed')),
  constraint enrichment_lookups_attempts_array check (jsonb_typeof(attempts) = 'array'),
  constraint enrichment_lookups_value_length check (value is null or char_length(value) <= 1000)
);

create index if not exists enrichment_lookups_record_idx
  on crm.enrichment_lookups (workspace_id, record_type, record_id, field, created_at desc);
create index if not exists enrichment_lookups_user_idx on crm.enrichment_lookups (created_by_user_id);

alter table crm.enrichment_settings enable row level security;
alter table crm.enrichment_settings force row level security;
alter table crm.enrichment_lookups enable row level security;
alter table crm.enrichment_lookups force row level security;

drop policy if exists enrichment_settings_select_member on crm.enrichment_settings;
create policy enrichment_settings_select_member on crm.enrichment_settings
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists enrichment_settings_insert_member on crm.enrichment_settings;
create policy enrichment_settings_insert_member on crm.enrichment_settings
  for insert to authenticated with check (workspace_id in (select private.user_workspace_ids()));
drop policy if exists enrichment_settings_update_member on crm.enrichment_settings;
create policy enrichment_settings_update_member on crm.enrichment_settings
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));
drop policy if exists enrichment_settings_select_agent on crm.enrichment_settings;
create policy enrichment_settings_select_agent on crm.enrichment_settings
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));

drop policy if exists enrichment_lookups_select_member on crm.enrichment_lookups;
create policy enrichment_lookups_select_member on crm.enrichment_lookups
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists enrichment_lookups_insert_member on crm.enrichment_lookups;
create policy enrichment_lookups_insert_member on crm.enrichment_lookups
  for insert to authenticated with check (workspace_id in (select private.user_workspace_ids()));
drop policy if exists enrichment_lookups_select_agent on crm.enrichment_lookups;
create policy enrichment_lookups_select_agent on crm.enrichment_lookups
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));
drop policy if exists enrichment_lookups_insert_agent on crm.enrichment_lookups;
create policy enrichment_lookups_insert_agent on crm.enrichment_lookups
  for insert to crm_agent with check (workspace_id = (select private.request_workspace_id()));

revoke all on crm.enrichment_settings from anon, authenticated, crm_agent;
revoke all on crm.enrichment_lookups from anon, authenticated, crm_agent;
grant select, insert, update on crm.enrichment_settings to authenticated;
grant select on crm.enrichment_settings to crm_agent;
grant select, insert on crm.enrichment_lookups to authenticated, crm_agent;
