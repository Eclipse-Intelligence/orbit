create table if not exists crm.mail_prepared (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  thread_key text not null,
  message_id uuid not null references crm.mail_messages (id) on delete cascade,
  kind text not null,
  state text not null default 'ready',
  body text,
  sent_body text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_prepared_kind check (kind in ('reply', 'nudge', 'follow_up')),
  constraint mail_prepared_state check (state in ('ready', 'skipped', 'used', 'sent', 'dismissed', 'scheduled')),
  constraint mail_prepared_body check (body is null or char_length(body) <= 20000),
  constraint mail_prepared_sent_body check (sent_body is null or char_length(sent_body) <= 20000),
  constraint mail_prepared_unique unique (message_id, kind)
);

create index if not exists mail_prepared_thread_idx on crm.mail_prepared (source_id, thread_key, state);
create index if not exists mail_prepared_user_idx on crm.mail_prepared (user_id, created_at desc);

alter table crm.mail_prepared enable row level security;
alter table crm.mail_prepared force row level security;

drop policy if exists mail_prepared_owner on crm.mail_prepared;
create policy mail_prepared_owner on crm.mail_prepared
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_prepared from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_prepared to authenticated;

alter table crm.mail_reminders add column if not exists automatic boolean not null default false;

alter table crm.mail_preferences add column if not exists prepare_replies boolean not null default true;
alter table crm.mail_preferences add column if not exists auto_remind_days integer default 3;
alter table crm.mail_preferences drop constraint if exists mail_preferences_auto_remind_days;
alter table crm.mail_preferences add constraint mail_preferences_auto_remind_days check (auto_remind_days is null or auto_remind_days between 1 and 30);
