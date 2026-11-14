set lock_timeout = '5s';

alter table crm.tasks add column if not exists reminder_sent_at timestamptz;

create or replace function private.task_reminder_marker()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.due_at is distinct from old.due_at
    or new.due_has_time is distinct from old.due_has_time
    or new.remind_minutes is distinct from old.remind_minutes
    or new.owner_id is distinct from old.owner_id
  then
    new.reminder_sent_at := null;
  elsif new.reminder_sent_at is distinct from old.reminder_sent_at
    and (to_jsonb(new) - 'reminder_sent_at' - 'updated_at') = (to_jsonb(old) - 'reminder_sent_at' - 'updated_at')
  then
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

revoke all on function private.task_reminder_marker() from public;

drop trigger if exists tasks_updated_reminder on crm.tasks;
create trigger tasks_updated_reminder
  before update on crm.tasks
  for each row execute function private.task_reminder_marker();

drop function if exists private.claim_task_reminders(timestamptz, integer);
create function private.claim_task_reminders(p_now timestamptz, p_limit integer)
returns table (
  task_id uuid,
  claimed_at timestamptz,
  title text,
  due_at timestamptz,
  remind_minutes integer,
  company_name text,
  contact_name text,
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
)
language sql
security definer
set search_path = ''
as $$
  with picked as (
    select t.id
    from crm.tasks t
    where t.remind_minutes is not null
      and t.reminder_sent_at is null
      and t.due_has_time
      and t.due_at is not null
      and t.completed_at is null
      and t.archived_at is null
      and t.due_at - make_interval(mins => t.remind_minutes) <= p_now
      and t.due_at > p_now - interval '5 minutes'
    order by t.due_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of t skip locked
  ), claimed as (
    update crm.tasks t
    set reminder_sent_at = p_now
    from picked
    where t.id = picked.id
    returning t.id, t.reminder_sent_at, t.title, t.due_at, t.remind_minutes, t.company_id, t.contact_id,
              t.workspace_id, coalesce(t.owner_id, t.created_by_user_id) as recipient
  )
  select c.id, c.reminder_sent_at, c.title, c.due_at, c.remind_minutes, co.name,
         coalesce(nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''), ct.email, ct.phone),
         w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from claimed c
  join crm.workspace_members m on m.workspace_id = c.workspace_id and m.user_id = c.recipient
  join crm.workspaces w on w.id = c.workspace_id
  join crm.profiles p on p.id = m.user_id
  left join crm.companies co on co.id = c.company_id
  left join crm.contacts ct on ct.id = c.contact_id
  order by c.due_at
$$;

revoke all on function private.claim_task_reminders(timestamptz, integer) from public;
grant execute on function private.claim_task_reminders(timestamptz, integer) to crm_app;

create or replace function private.release_task_reminder(p_task_id uuid, p_claimed_at timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.tasks
  set reminder_sent_at = null
  where id = p_task_id and reminder_sent_at = p_claimed_at;
$$;

revoke all on function private.release_task_reminder(uuid, timestamptz) from public;
grant execute on function private.release_task_reminder(uuid, timestamptz) to crm_app;

reset lock_timeout;

create index concurrently if not exists tasks_reminder_unsent_idx on crm.tasks (due_at) where remind_minutes is not null and reminder_sent_at is null and completed_at is null and archived_at is null;
