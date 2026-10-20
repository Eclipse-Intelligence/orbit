alter table crm.mail_messages add column if not exists focused boolean;
alter table crm.mail_folders add column if not exists classified_at timestamptz;

create table if not exists crm.mail_sender_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  sender text not null,
  split text not null,
  created_at timestamptz not null default now(),
  constraint mail_sender_rules_split check (split in ('important', 'other', 'news', 'calendar')),
  constraint mail_sender_rules_sender check (char_length(sender) between 3 and 320),
  constraint mail_sender_rules_unique unique (user_id, sender)
);

alter table crm.mail_sender_rules enable row level security;
alter table crm.mail_sender_rules force row level security;

drop policy if exists mail_sender_rules_owner on crm.mail_sender_rules;
create policy mail_sender_rules_owner on crm.mail_sender_rules
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_sender_rules from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_sender_rules to authenticated;
