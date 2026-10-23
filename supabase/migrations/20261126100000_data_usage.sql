create table if not exists crm.data_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  provider text not null,
  agent text not null,
  rows integer not null default 0,
  cost_usd numeric(10, 5) not null default 0,
  user_id uuid references crm.profiles (id) on delete set null,
  source text,
  created_at timestamptz not null default now(),
  constraint data_usage_provider check (char_length(provider) between 1 and 40),
  constraint data_usage_agent check (char_length(agent) between 1 and 80),
  constraint data_usage_rows check (rows >= 0),
  constraint data_usage_cost check (cost_usd >= 0)
);

create index if not exists data_usage_month_idx on crm.data_usage (workspace_id, provider, created_at desc);

alter table crm.data_usage enable row level security;
alter table crm.data_usage force row level security;

drop policy if exists data_usage_member on crm.data_usage;
create policy data_usage_member on crm.data_usage for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists data_usage_agent on crm.data_usage;
create policy data_usage_agent on crm.data_usage for all to crm_agent
  using (workspace_id = (select private.request_workspace_id()))
  with check (workspace_id = (select private.request_workspace_id()));

revoke all on crm.data_usage from anon, authenticated, crm_agent;
grant select, insert on crm.data_usage to authenticated, crm_agent;
