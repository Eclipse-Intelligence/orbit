create table if not exists crm.ai_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  provider text not null,
  status text not null default 'pending',
  label text,
  account_id text,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  pending text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_accounts_provider check (provider in ('chatgpt', 'claude')),
  constraint ai_accounts_status check (status in ('pending', 'connected')),
  constraint ai_accounts_label_length check (label is null or char_length(label) <= 320),
  constraint ai_accounts_error_length check (last_error is null or char_length(last_error) <= 1000),
  constraint ai_accounts_one_per_provider unique (user_id, provider)
);

create index if not exists ai_accounts_workspace_idx on crm.ai_accounts (workspace_id);

drop trigger if exists ai_accounts_set_updated_at on crm.ai_accounts;
create trigger ai_accounts_set_updated_at
  before update on crm.ai_accounts
  for each row execute function private.set_updated_at();

alter table crm.ai_accounts enable row level security;
alter table crm.ai_accounts force row level security;

drop policy if exists ai_accounts_owner on crm.ai_accounts;
create policy ai_accounts_owner on crm.ai_accounts
  for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

revoke all on crm.ai_accounts from anon, authenticated, crm_agent;
grant select, insert, delete on crm.ai_accounts to authenticated;
grant update (status, label, account_id, access_token, refresh_token, expires_at, pending, last_error, updated_at)
  on crm.ai_accounts to authenticated;

alter table crm.assistant_messages add column if not exists provider_state jsonb;
