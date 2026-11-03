create table if not exists crm.mail_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  sender text not null,
  status text not null default 'subscribed',
  unsubscribed_at timestamptz,
  method text,
  outcome text,
  ignored_at timestamptz,
  ignored_count integer not null default 0,
  cold_pitch_at timestamptz,
  list_unsubscribe text,
  one_click boolean not null default false,
  pitch_rule boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_subscriptions_sender check (char_length(sender) between 3 and 320),
  constraint mail_subscriptions_status check (status in ('subscribed', 'kept', 'unsubscribed', 'research', 'blocked')),
  constraint mail_subscriptions_method check (method is null or method in ('one_click', 'mailto', 'page', 'none')),
  constraint mail_subscriptions_outcome check (outcome is null or outcome in ('unsubscribed', 'requested', 'needs_you', 'failed', 'none')),
  constraint mail_subscriptions_link check (list_unsubscribe is null or char_length(list_unsubscribe) <= 2000),
  constraint mail_subscriptions_unique unique (user_id, sender)
);

alter table crm.mail_subscriptions add column if not exists pitch_rule boolean not null default false;

create index if not exists mail_subscriptions_status_idx on crm.mail_subscriptions (user_id, status);

create table if not exists crm.mail_unsubscribes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  sender text not null,
  source_id uuid references crm.mail_sources (id) on delete set null,
  message_id uuid references crm.mail_messages (id) on delete set null,
  method text not null,
  outcome text not null,
  target text,
  detail text,
  existing text not null default 'leave',
  moved integer not null default 0,
  created_at timestamptz not null default now(),
  constraint mail_unsubscribes_sender check (char_length(sender) between 3 and 320),
  constraint mail_unsubscribes_method check (method in ('one_click', 'mailto', 'page', 'none')),
  constraint mail_unsubscribes_outcome check (outcome in ('unsubscribed', 'requested', 'needs_you', 'failed', 'none')),
  constraint mail_unsubscribes_existing check (existing in ('archive', 'trash', 'leave')),
  constraint mail_unsubscribes_target check (target is null or char_length(target) <= 2000),
  constraint mail_unsubscribes_detail check (detail is null or char_length(detail) <= 500)
);

create index if not exists mail_unsubscribes_user_idx on crm.mail_unsubscribes (user_id, created_at desc);
create index if not exists mail_unsubscribes_sender_idx on crm.mail_unsubscribes (user_id, sender, created_at desc);

create table if not exists crm.mail_pitch_failures (
  message_id uuid primary key references crm.mail_messages (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  failures integer not null default 1,
  last_failed_at timestamptz not null default now(),
  last_error text,
  constraint mail_pitch_failures_count check (failures >= 1),
  constraint mail_pitch_failures_error check (last_error is null or char_length(last_error) <= 300)
);

create index if not exists mail_pitch_failures_user_idx on crm.mail_pitch_failures (user_id);

alter table crm.mail_subscriptions enable row level security;
alter table crm.mail_subscriptions force row level security;
alter table crm.mail_unsubscribes enable row level security;
alter table crm.mail_unsubscribes force row level security;
alter table crm.mail_pitch_failures enable row level security;
alter table crm.mail_pitch_failures force row level security;

drop policy if exists mail_subscriptions_owner on crm.mail_subscriptions;
create policy mail_subscriptions_owner on crm.mail_subscriptions
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists mail_unsubscribes_owner on crm.mail_unsubscribes;
create policy mail_unsubscribes_owner on crm.mail_unsubscribes
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists mail_pitch_failures_owner on crm.mail_pitch_failures;
create policy mail_pitch_failures_owner on crm.mail_pitch_failures
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_subscriptions from anon, authenticated, crm_agent;
revoke all on crm.mail_unsubscribes from anon, authenticated, crm_agent;
revoke all on crm.mail_pitch_failures from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_subscriptions to authenticated;
grant select, insert, update, delete on crm.mail_unsubscribes to authenticated;
grant select, insert, update, delete on crm.mail_pitch_failures to authenticated;

alter table crm.mail_sources add column if not exists research_folder_id text;

alter table crm.mail_preferences add column if not exists cold_pitches text not null default 'off';
alter table crm.mail_preferences drop constraint if exists mail_preferences_cold_pitches;
alter table crm.mail_preferences add constraint mail_preferences_cold_pitches check (cold_pitches in ('off', 'other', 'archive'));

alter table crm.mail_prepared drop constraint if exists mail_prepared_kind;
alter table crm.mail_prepared add constraint mail_prepared_kind check (kind in ('reply', 'nudge', 'follow_up', 'pitch'));
