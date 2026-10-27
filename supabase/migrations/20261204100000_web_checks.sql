alter table crm.enrichment_settings add column if not exists web_tags boolean not null default false;
alter table crm.enrichment_settings add column if not exists web_gaps boolean not null default false;
alter table crm.enrichment_settings add column if not exists web_signals boolean not null default false;

create table if not exists crm.company_web_state (
  company_id uuid primary key references crm.companies (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  checked_at timestamptz,
  signals_checked_at timestamptz
);

create index if not exists company_web_state_workspace_idx on crm.company_web_state (workspace_id, signals_checked_at);

create table if not exists crm.web_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  kind text not null,
  label text not null,
  question text not null,
  note_kind text not null default 'signal',
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint web_checks_kind check (kind in ('tag', 'signal')),
  constraint web_checks_label_length check (char_length(label) between 1 and 60),
  constraint web_checks_question_length check (char_length(question) between 1 and 1000),
  constraint web_checks_note_kind check (note_kind in ('funding', 'hire', 'launch', 'signal'))
);

create unique index if not exists web_checks_label_uidx on crm.web_checks (workspace_id, kind, lower(label));
create index if not exists web_checks_created_by_idx on crm.web_checks (created_by_user_id);

drop trigger if exists web_checks_set_updated_at on crm.web_checks;
create trigger web_checks_set_updated_at
  before update on crm.web_checks
  for each row execute function private.set_updated_at();

create table if not exists crm.company_signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  company_id uuid not null references crm.companies (id) on delete cascade,
  check_id uuid not null references crm.web_checks (id) on delete cascade,
  probability double precision not null,
  url text,
  note_id uuid references crm.market_notes (id) on delete set null,
  flagged_at timestamptz not null default now(),
  constraint company_signals_url check (url is null or (char_length(url) <= 1000 and url ~ '^https?://'))
);

create index if not exists company_signals_lookup_idx on crm.company_signals (company_id, check_id, flagged_at desc);
create index if not exists company_signals_workspace_idx on crm.company_signals (workspace_id, flagged_at desc);
create index if not exists company_signals_check_idx on crm.company_signals (check_id);
create index if not exists company_signals_note_idx on crm.company_signals (note_id);

alter table crm.web_checks enable row level security;
alter table crm.web_checks force row level security;
alter table crm.company_web_state enable row level security;
alter table crm.company_web_state force row level security;
alter table crm.company_signals enable row level security;
alter table crm.company_signals force row level security;

drop policy if exists web_checks_member on crm.web_checks;
create policy web_checks_member on crm.web_checks for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));
drop policy if exists web_checks_agent on crm.web_checks;
create policy web_checks_agent on crm.web_checks for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));

drop policy if exists company_web_state_member on crm.company_web_state;
create policy company_web_state_member on crm.company_web_state for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists company_signals_member on crm.company_signals;
create policy company_signals_member on crm.company_signals for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));
drop policy if exists company_signals_agent on crm.company_signals;
create policy company_signals_agent on crm.company_signals for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));

grant select, insert, update, delete on crm.web_checks to authenticated;
grant select, insert on crm.company_signals to authenticated;
grant select, insert, update on crm.company_web_state to authenticated;
grant select on crm.web_checks, crm.company_signals to crm_agent;
