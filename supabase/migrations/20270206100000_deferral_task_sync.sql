set lock_timeout = '5s';

create or replace function private.task_deferral_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date;
begin
  if new.due_at is not distinct from old.due_at
    and new.completed_at is not distinct from old.completed_at
    and new.archived_at is not distinct from old.archived_at then
    return null;
  end if;
  if not exists (select 1 from crm.mail_reminders r where r.task_id = new.id and r.deferral and r.state in ('waiting', 'due')) then
    return null;
  end if;
  if new.completed_at is not null or new.archived_at is not null then
    update crm.mail_prepared p set state = 'dismissed', updated_at = now()
    from crm.mail_reminders r
    where r.task_id = new.id and r.deferral and r.state = 'due'
      and p.user_id = r.user_id and p.source_id = r.source_id and p.thread_key = r.thread_key
      and p.kind = 'nudge' and p.state = 'ready';
    update crm.mail_reminders set state = 'done'
    where task_id = new.id and deferral and state in ('waiting', 'due');
    return null;
  end if;
  if new.due_at is not null and new.due_at is distinct from old.due_at then
    v_day := (new.due_at at time zone 'Europe/London')::date;
    update crm.mail_reminders
    set due_at = (v_day + time '09:00') at time zone 'Europe/London'
    where task_id = new.id and deferral and state = 'waiting'
      and (due_at at time zone 'Europe/London')::date <> v_day;
  end if;
  return null;
end;
$$;

revoke all on function private.task_deferral_sync() from public;

drop trigger if exists tasks_deferral_sync on crm.tasks;
create trigger tasks_deferral_sync
  after update of due_at, completed_at, archived_at on crm.tasks
  for each row execute function private.task_deferral_sync();

reset lock_timeout;
