set lock_timeout = '5s';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'crm' and table_name = 'tasks' and column_name = 'due_has_time'
  ) then
    alter table crm.tasks add column due_has_time boolean not null default false;
    alter table crm.tasks add column if not exists scheduled_by text;
    alter table crm.tasks disable trigger tasks_set_updated_at;
    update crm.tasks
    set due_has_time = true, scheduled_by = 'person'
    where due_at is not null and remind_minutes is not null;
    update crm.tasks t
    set due_at = date_trunc('day', t.due_at at time zone 'Europe/London') at time zone 'Europe/London',
        clickup_sync = case
          when t.clickup_sync ? 'dueAt'
            and jsonb_typeof(t.clickup_sync -> 'dueAt') = 'string'
            and (t.clickup_sync ->> 'dueAt')::timestamptz = t.due_at
          then jsonb_set(
            t.clickup_sync,
            '{dueAt}',
            to_jsonb(to_char((date_trunc('day', t.due_at at time zone 'Europe/London') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
          )
          else t.clickup_sync
        end
    where t.due_at is not null
      and not t.due_has_time
      and t.due_at <> date_trunc('day', t.due_at at time zone 'Europe/London') at time zone 'Europe/London';
    alter table crm.tasks enable trigger tasks_set_updated_at;
  end if;
end;
$$;

alter table crm.tasks add column if not exists scheduled_by text;
alter table crm.tasks add column if not exists duration_minutes integer not null default 15;

alter table crm.tasks drop constraint if exists tasks_duration_minutes_check;
alter table crm.tasks
  add constraint tasks_duration_minutes_check
  check (duration_minutes between 5 and 480);

alter table crm.tasks drop constraint if exists tasks_scheduled_by_check;
alter table crm.tasks
  add constraint tasks_scheduled_by_check
  check (scheduled_by is null or scheduled_by in ('person', 'planner'));

alter table crm.tasks drop constraint if exists tasks_timing_check;
alter table crm.tasks
  add constraint tasks_timing_check
  check ((due_has_time and due_at is not null) or (not due_has_time and scheduled_by is null));
