create table if not exists crm.follow_up_suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  activity_id uuid not null references crm.activities (id) on delete cascade,
  company_id uuid references crm.companies (id) on delete set null,
  contact_id uuid references crm.contacts (id) on delete set null,
  source text not null,
  call_at timestamptz not null,
  label text,
  person_name text,
  person_email text,
  subject text,
  body text,
  state text not null default 'ready',
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint follow_up_suggestions_source check (source in ('teams', 'granola')),
  constraint follow_up_suggestions_state check (state in ('ready', 'used', 'dismissed', 'done', 'failed')),
  constraint follow_up_suggestions_label check (label is null or char_length(label) <= 60),
  constraint follow_up_suggestions_person_name check (person_name is null or char_length(person_name) <= 200),
  constraint follow_up_suggestions_person_email check (person_email is null or char_length(person_email) <= 320),
  constraint follow_up_suggestions_subject check (subject is null or char_length(subject) <= 300),
  constraint follow_up_suggestions_body check (body is null or char_length(body) <= 6000),
  constraint follow_up_suggestions_error check (error is null or char_length(error) <= 500),
  constraint follow_up_suggestions_unique unique (user_id, activity_id)
);

create index if not exists follow_up_suggestions_user_idx on crm.follow_up_suggestions (user_id, workspace_id, state, created_at desc);
create index if not exists follow_up_suggestions_activity_idx on crm.follow_up_suggestions (activity_id);

alter table crm.follow_up_suggestions enable row level security;
alter table crm.follow_up_suggestions force row level security;

drop policy if exists follow_up_suggestions_owner on crm.follow_up_suggestions;
create policy follow_up_suggestions_owner on crm.follow_up_suggestions
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.follow_up_suggestions from anon, authenticated, crm_agent;
grant select, insert, update on crm.follow_up_suggestions to authenticated;

create table if not exists crm.mail_deferral_checks (
  message_id uuid primary key references crm.mail_messages (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  state text not null default 'none',
  failures integer not null default 0,
  last_failed_at timestamptz,
  checked_at timestamptz not null default now(),
  constraint mail_deferral_checks_state check (state in ('none', 'found', 'failed'))
);

create index if not exists mail_deferral_checks_user_idx on crm.mail_deferral_checks (user_id, checked_at desc);

alter table crm.mail_deferral_checks enable row level security;
alter table crm.mail_deferral_checks force row level security;

drop policy if exists mail_deferral_checks_owner on crm.mail_deferral_checks;
create policy mail_deferral_checks_owner on crm.mail_deferral_checks
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_deferral_checks from anon, authenticated, crm_agent;
grant select, insert, update on crm.mail_deferral_checks to authenticated;

alter table crm.mail_reminders add column if not exists deferred_message_id uuid references crm.mail_messages (id) on delete set null;
alter table crm.mail_reminders add column if not exists task_id uuid references crm.tasks (id) on delete set null;
alter table crm.mail_reminders add column if not exists defer_note text;
alter table crm.mail_reminders add column if not exists deferral boolean not null default false;
alter table crm.mail_reminders drop constraint if exists mail_reminders_deferral;
alter table crm.mail_reminders add constraint mail_reminders_deferral check (not deferral or (kind = 'follow_up' and action = 'remind'));
alter table crm.mail_reminders drop constraint if exists mail_reminders_defer_note;
alter table crm.mail_reminders add constraint mail_reminders_defer_note check (defer_note is null or char_length(defer_note) <= 300);

create index if not exists mail_reminders_deferred_idx on crm.mail_reminders (deferred_message_id) where deferred_message_id is not null;
create index if not exists mail_reminders_deferral_idx on crm.mail_reminders (user_id, source_id, thread_key) where deferral;
create index if not exists mail_reminders_task_idx on crm.mail_reminders (task_id) where task_id is not null;
