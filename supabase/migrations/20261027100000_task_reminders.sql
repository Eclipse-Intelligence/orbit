alter table crm.tasks add column if not exists remind_minutes integer;

alter table crm.tasks drop constraint if exists tasks_remind_minutes_check;
alter table crm.tasks
  add constraint tasks_remind_minutes_check
  check (remind_minutes is null or remind_minutes in (0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080));

create index if not exists tasks_reminder_idx
  on crm.tasks (workspace_id, due_at)
  where remind_minutes is not null and completed_at is null and archived_at is null;
