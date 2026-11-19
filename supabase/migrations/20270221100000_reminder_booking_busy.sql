set lock_timeout = '5s';

create or replace function private.booking_busy(p_user_id uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '100 days' then
    raise exception 'invalid busy window' using errcode = '22023';
  end if;
  if not exists (select 1 from crm.booking_pages b where b.user_id = p_user_id and b.enabled) then
    return;
  end if;

  return query
  select busy.starts_at, busy.ends_at
  from (
    select e.starts_at, e.ends_at
    from crm.calendar_events e
    join crm.calendars c on c.id = e.calendar_id and c.user_id = e.user_id
    where e.user_id = p_user_id
      and e.task_id is null
      and not e.is_cancelled
      and coalesce(lower(e.show_as), 'busy') <> 'free'
      and e.starts_at < p_to
      and e.ends_at > p_from
    union all
    select t.due_at, t.due_at + make_interval(mins => t.duration_minutes)
    from crm.tasks t
    join crm.workspace_members m on m.workspace_id = t.workspace_id and m.user_id = t.owner_id
    where t.owner_id = p_user_id
      and t.due_has_time
      and t.due_at is not null
      and t.completed_at is null
      and t.archived_at is null
      and t.due_at < p_to
      and t.due_at + make_interval(mins => t.duration_minutes) > p_from
    union all
    select r.due_at, r.due_at + make_interval(mins => r.duration_minutes)
    from crm.reminders r
    where r.user_id = p_user_id
      and r.blocks_time
      and r.due_at is not null
      and r.completed_at is null
      and r.due_at < p_to
      and r.due_at + make_interval(mins => r.duration_minutes) > p_from
  ) busy
  order by busy.starts_at
  limit 5000;
end;
$$;

revoke all on function private.booking_busy(uuid, timestamptz, timestamptz) from public;
grant execute on function private.booking_busy(uuid, timestamptz, timestamptz) to crm_app;

create or replace function private.booking_reminder_repeats(p_user_id uuid)
returns table (due_on date, due_at timestamptz, duration_minutes integer, repeat_rule jsonb, repeat_ends jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from crm.booking_pages b where b.user_id = p_user_id and b.enabled) then
    return;
  end if;

  return query
  select r.due_on, r.due_at, r.duration_minutes, r.repeat_rule, r.repeat_ends
  from crm.reminders r
  where r.user_id = p_user_id
    and r.blocks_time
    and r.due_at is not null
    and r.due_on is not null
    and r.completed_at is null
    and r.repeat_rule is not null
    and r.repeat_ends is not null
  order by r.due_at
  limit 200;
end;
$$;

revoke all on function private.booking_reminder_repeats(uuid) from public;
grant execute on function private.booking_reminder_repeats(uuid) to crm_app;

reset lock_timeout;
