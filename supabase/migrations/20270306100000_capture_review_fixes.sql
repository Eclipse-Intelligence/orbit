set lock_timeout = '5s';

alter table crm.mail_prepared drop constraint if exists mail_prepared_kind;
alter table crm.mail_prepared add constraint mail_prepared_kind check (kind in ('reply', 'nudge', 'follow_up', 'pitch', 'reply_check', 'reply_failed')) not valid;

alter table crm.mail_prepared add column if not exists transient integer not null default 0;
alter table crm.mail_prepared drop constraint if exists mail_prepared_transient;
alter table crm.mail_prepared add constraint mail_prepared_transient check (transient between 0 and 10) not valid;

alter table crm.mail_relevance_runs add column if not exists settled_at timestamptz;

create table if not exists crm.mail_prepare_runs (
  user_id uuid primary key references crm.profiles (id) on delete cascade,
  started_at timestamptz not null default now(),
  running_until timestamptz not null default now()
);

alter table crm.mail_prepare_runs enable row level security;
alter table crm.mail_prepare_runs force row level security;

drop policy if exists mail_prepare_runs_owner on crm.mail_prepare_runs;
create policy mail_prepare_runs_owner on crm.mail_prepare_runs
  for all to authenticated
  using (user_id = (select private.session_user_id()))
  with check (user_id = (select private.session_user_id()));

revoke all on crm.mail_prepare_runs from anon, authenticated, crm_agent;
grant select, insert, update on crm.mail_prepare_runs to authenticated;

reset lock_timeout;

alter table crm.mail_prepared validate constraint mail_prepared_kind;
alter table crm.mail_prepared validate constraint mail_prepared_transient;

create index concurrently if not exists mail_messages_user_created_idx on crm.mail_messages (user_id, created_at desc);
