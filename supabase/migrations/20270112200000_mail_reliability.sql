alter table crm.mail_drafts add column if not exists send_attempted_at timestamptz;
alter table crm.mail_drafts add column if not exists sent_internet_id text;

alter table crm.mail_reminders add column if not exists attempts integer not null default 0;
alter table crm.mail_reminders add column if not exists last_error text;

create table if not exists crm.mail_send_keys (
  user_id uuid not null references crm.profiles (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  key uuid not null,
  draft_id uuid,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

create index if not exists mail_send_keys_draft_idx on crm.mail_send_keys (draft_id) where draft_id is not null;

alter table crm.mail_send_keys enable row level security;
alter table crm.mail_send_keys force row level security;

drop policy if exists mail_send_keys_owner on crm.mail_send_keys;
create policy mail_send_keys_owner on crm.mail_send_keys
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_send_keys from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_send_keys to authenticated;
