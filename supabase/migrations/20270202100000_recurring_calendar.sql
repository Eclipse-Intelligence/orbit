set lock_timeout = '5s';

create or replace function private.booking_series(p_user_id uuid, p_from date, p_to date)
returns table (
  starts_on date,
  at text,
  duration_minutes integer,
  rule jsonb,
  ends jsonb,
  current_occurs_on date,
  current_due_at timestamptz,
  changes jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 102 then
    raise exception 'invalid busy window' using errcode = '22023';
  end if;
  if not exists (select 1 from crm.booking_pages b where b.user_id = p_user_id and b.enabled) then
    return;
  end if;

  return query
  select s.starts_on, to_char(s.at, 'HH24:MI'), s.duration_minutes, s.rule, s.ends, t.occurs_on, t.due_at,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'occursOn', c.occurs_on::text, 'skip', c.skip, 'dueAt', c.due_at, 'dueHasTime', c.due_has_time,
        'durationMinutes', c.duration_minutes
      ) order by c.occurs_on)
      from crm.task_occurrence_changes c
      where c.series_id = s.id and (t.occurs_on is null or c.occurs_on > t.occurs_on)
    ), '[]'::jsonb)
  from crm.task_series s
  join crm.workspace_members m on m.workspace_id = s.workspace_id and m.user_id = s.owner_id
  left join crm.tasks t on t.id = s.current_task_id
  where s.owner_id = p_user_id
    and s.ended_at is null
    and s.archived_at is null
    and s.starts_on <= p_to
    and (
      s.at is not null
      or exists (
        select 1 from crm.task_occurrence_changes c
        where c.series_id = s.id and c.due_has_time
      )
    )
  order by s.created_at, s.id
  limit 400;
end;
$$;

revoke all on function private.booking_series(uuid, date, date) from public;
grant execute on function private.booking_series(uuid, date, date) to crm_app;

reset lock_timeout;
