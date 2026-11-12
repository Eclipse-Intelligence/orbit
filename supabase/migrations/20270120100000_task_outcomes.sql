set lock_timeout = '5s';

create table if not exists crm.task_outcomes (
  id uuid primary key,
  task_id uuid not null references crm.tasks (id) on delete cascade,
  completed_at timestamptz not null,
  activity_id uuid references crm.activities (id) on delete set null,
  next_task_id uuid references crm.tasks (id) on delete set null,
  created_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint task_outcomes_once unique (task_id, completed_at)
);

create index if not exists task_outcomes_activity_idx on crm.task_outcomes (activity_id) where activity_id is not null;
create index if not exists task_outcomes_next_task_idx on crm.task_outcomes (next_task_id) where next_task_id is not null;
create index if not exists task_outcomes_created_by_idx on crm.task_outcomes (created_by);

alter table crm.task_outcomes enable row level security;
alter table crm.task_outcomes force row level security;

drop policy if exists task_outcomes_select on crm.task_outcomes;
create policy task_outcomes_select on crm.task_outcomes
  for select to authenticated
  using (task_id in (select t.id from crm.tasks t));

drop policy if exists task_outcomes_insert on crm.task_outcomes;
create policy task_outcomes_insert on crm.task_outcomes
  for insert to authenticated
  with check (
    created_by = (select private.session_user_id())
    and exists (
      select 1 from crm.tasks t
      where t.id = task_outcomes.task_id
        and t.workspace_id in (select private.user_workspace_ids())
        and (
          t.owner_id = (select private.session_user_id())
          or t.created_by_user_id = (select private.session_user_id())
          or private.is_workspace_admin(t.workspace_id)
        )
    )
  );

revoke all on crm.task_outcomes from anon, authenticated, crm_agent;
grant select, insert on crm.task_outcomes to authenticated;
