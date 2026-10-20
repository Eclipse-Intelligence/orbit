create table if not exists crm.mail_summaries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  thread_key text not null,
  latest_message_id uuid not null,
  summary text not null,
  todo text,
  created_at timestamptz not null default now(),
  constraint mail_summaries_summary check (char_length(summary) <= 1000),
  constraint mail_summaries_todo check (todo is null or char_length(todo) <= 500),
  constraint mail_summaries_unique unique (source_id, thread_key)
);

create index if not exists mail_summaries_user_idx on crm.mail_summaries (user_id);

alter table crm.mail_summaries enable row level security;
alter table crm.mail_summaries force row level security;

drop policy if exists mail_summaries_owner on crm.mail_summaries;
create policy mail_summaries_owner on crm.mail_summaries
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_summaries from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_summaries to authenticated;
