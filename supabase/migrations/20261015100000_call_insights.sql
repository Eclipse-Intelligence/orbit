create table if not exists crm.call_insights (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  activity_id uuid not null references crm.activities (id) on delete cascade,
  contact_id uuid references crm.contacts (id) on delete set null,
  company_id uuid references crm.companies (id) on delete set null,
  source text not null,
  transcript text not null,
  summary text,
  key_points jsonb not null default '[]'::jsonb,
  action_items jsonb not null default '[]'::jsonb,
  model text,
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint call_insights_activity_unique unique (activity_id),
  constraint call_insights_source check (source in ('teams', 'manual')),
  constraint call_insights_status check (status in ('pending', 'ready', 'failed')),
  constraint call_insights_transcript_length check (char_length(transcript) between 1 and 200000),
  constraint call_insights_summary_length check (summary is null or char_length(summary) <= 4000),
  constraint call_insights_model_length check (model is null or char_length(model) <= 200),
  constraint call_insights_error_length check (error is null or char_length(error) <= 1000),
  constraint call_insights_key_points_array check (jsonb_typeof(key_points) = 'array'),
  constraint call_insights_action_items_array check (jsonb_typeof(action_items) = 'array')
);

create index if not exists call_insights_workspace_idx on crm.call_insights (workspace_id);
create index if not exists call_insights_contact_id_idx on crm.call_insights (contact_id);
create index if not exists call_insights_company_id_idx on crm.call_insights (company_id);

drop trigger if exists call_insights_set_updated_at on crm.call_insights;
create trigger call_insights_set_updated_at
  before update on crm.call_insights
  for each row execute function private.set_updated_at();

alter table crm.call_insights enable row level security;
alter table crm.call_insights force row level security;

drop policy if exists call_insights_select_member on crm.call_insights;
create policy call_insights_select_member on crm.call_insights
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

drop policy if exists call_insights_insert_member on crm.call_insights;
create policy call_insights_insert_member on crm.call_insights
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists call_insights_update_member on crm.call_insights;
create policy call_insights_update_member on crm.call_insights
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists call_insights_select_agent on crm.call_insights;
create policy call_insights_select_agent on crm.call_insights
  for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));

drop policy if exists call_insights_insert_agent on crm.call_insights;
create policy call_insights_insert_agent on crm.call_insights
  for insert to crm_agent
  with check (workspace_id = (select private.request_workspace_id()));

drop policy if exists call_insights_update_agent on crm.call_insights;
create policy call_insights_update_agent on crm.call_insights
  for update to crm_agent
  using (workspace_id = (select private.request_workspace_id()))
  with check (workspace_id = (select private.request_workspace_id()));

revoke all on crm.call_insights from anon, authenticated, crm_agent;
grant select, insert on crm.call_insights to authenticated, crm_agent;
grant update (summary, key_points, action_items, model, status, error)
  on crm.call_insights to authenticated, crm_agent;
