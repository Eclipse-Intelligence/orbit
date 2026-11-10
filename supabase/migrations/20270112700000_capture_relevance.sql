create table if not exists crm.mail_sender_relevance (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  sender text not null,
  category text not null,
  engine text not null,
  confidence real,
  reason text,
  rule boolean not null default false,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_sender_relevance_sender check (char_length(sender) between 3 and 320 and sender = lower(sender) and position('@' in sender) > 0),
  constraint mail_sender_relevance_category check (category in ('business', 'supplier', 'service', 'personal', 'collections', 'spam', 'newsletter', 'muted')),
  constraint mail_sender_relevance_engine check (engine in ('jev', 'haiku', 'headers', 'rule', 'filed', 'shown')),
  constraint mail_sender_relevance_confidence check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint mail_sender_relevance_reason check (reason is null or char_length(reason) <= 300),
  constraint mail_sender_relevance_unique unique (user_id, workspace_id, sender)
);

alter table crm.mail_sender_relevance enable row level security;
alter table crm.mail_sender_relevance force row level security;

drop policy if exists mail_sender_relevance_owner on crm.mail_sender_relevance;
create policy mail_sender_relevance_owner on crm.mail_sender_relevance
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_sender_relevance from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_sender_relevance to authenticated;

create table if not exists crm.mail_thread_relevance (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  thread_key text not null,
  sender text not null,
  category text,
  engine text not null,
  confidence real,
  reason text,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_thread_relevance_key check (char_length(thread_key) between 1 and 450),
  constraint mail_thread_relevance_sender check (char_length(sender) between 3 and 320 and sender = lower(sender)),
  constraint mail_thread_relevance_category check (category is null or category in ('business', 'supplier', 'service', 'personal', 'collections', 'spam', 'newsletter', 'muted')),
  constraint mail_thread_relevance_engine check (engine in ('jev', 'haiku', 'headers', 'listed', 'history', 'cached', 'rule', 'filed', 'shown', 'failed')),
  constraint mail_thread_relevance_confidence check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint mail_thread_relevance_reason check (reason is null or char_length(reason) <= 300),
  constraint mail_thread_relevance_unique unique (user_id, source_id, thread_key)
);

alter table crm.mail_thread_relevance enable row level security;
alter table crm.mail_thread_relevance force row level security;

drop policy if exists mail_thread_relevance_owner on crm.mail_thread_relevance;
create policy mail_thread_relevance_owner on crm.mail_thread_relevance
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_thread_relevance from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_thread_relevance to authenticated;

create index if not exists mail_thread_relevance_sensitive_idx on crm.mail_thread_relevance (user_id, source_id, thread_key)
  where category in ('personal', 'collections');

create index if not exists mail_messages_user_sender_domain_idx on crm.mail_messages (user_id, (split_part(lower(from_email), '@', 2)));
