create table if not exists crm.activity_tone_failures (
  activity_id uuid primary key references crm.activities (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  failures integer not null default 1,
  last_failed_at timestamptz not null default now(),
  last_error text,
  constraint activity_tone_failures_count check (failures >= 1),
  constraint activity_tone_failures_error check (last_error is null or char_length(last_error) <= 300)
);

create index if not exists activity_tone_failures_workspace_idx on crm.activity_tone_failures (workspace_id);

alter table crm.activity_tone_failures enable row level security;
alter table crm.activity_tone_failures force row level security;

drop policy if exists activity_tone_failures_member on crm.activity_tone_failures;
create policy activity_tone_failures_member on crm.activity_tone_failures for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

revoke all on crm.activity_tone_failures from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.activity_tone_failures to authenticated;
