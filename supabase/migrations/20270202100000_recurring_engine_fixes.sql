set lock_timeout = '5s';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'task_series_rule_shape' and conrelid = 'crm.task_series'::regclass
      and pg_get_constraintdef(oid) like '%''yearly''::text) THEN%'
  ) then
    alter table crm.task_series drop constraint if exists task_series_rule_shape;
    alter table crm.task_series add constraint task_series_rule_shape check (
        jsonb_typeof(rule) = 'object'
        and rule ->> 'freq' in ('daily', 'weekly', 'monthly', 'yearly')
        and (rule - 'freq' - 'interval' - 'weekdays' - 'monthDay' - 'monthWeek') = '{}'::jsonb
        and case when jsonb_typeof(rule -> 'interval') = 'number' then (rule ->> 'interval') ~ '^[1-9][0-9]?$' else false end
        and (not (rule ? 'monthDay') or (jsonb_typeof(rule -> 'monthDay') = 'number' and (rule ->> 'monthDay') in ('1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30','31')))
        and case
          when rule ->> 'freq' = 'weekly' then
            jsonb_typeof(rule -> 'weekdays') = 'array'
            and jsonb_array_length(rule -> 'weekdays') between 1 and 7
            and (rule -> 'weekdays') <@ '["mo", "tu", "we", "th", "fr", "sa", "su"]'::jsonb
            and not (rule ? 'monthDay') and not (rule ? 'monthWeek')
          when rule ->> 'freq' = 'monthly' then
            not (rule ? 'weekdays')
            and not (rule ? 'monthDay' and rule ? 'monthWeek')
            and (not (rule ? 'monthWeek') or (
              jsonb_typeof(rule -> 'monthWeek') = 'object'
              and (rule -> 'monthWeek' ->> 'n') in ('1', '2', '3', '4', '-1')
              and (rule -> 'monthWeek' ->> 'weekday') in ('mo', 'tu', 'we', 'th', 'fr', 'sa', 'su')
            ))
          when rule ->> 'freq' = 'yearly' then
            not (rule ? 'weekdays') and not (rule ? 'monthWeek')
          else not (rule ? 'weekdays') and not (rule ? 'monthDay') and not (rule ? 'monthWeek')
        end
      );
  end if;
end
$$;

create or replace function crm.series_active_count(p_workspace uuid, p_owner uuid)
returns table (total integer, keeper uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with head as (
    select m.user_id from crm.workspace_members m
    where m.workspace_id = p_workspace and m.role = 'owner'
    order by m.created_at
    limit 1
  ),
  wanted as (
    select coalesce(p_owner, (select user_id from head)) as id
  )
  select
    (
      select count(*)::integer
      from crm.task_series s, wanted
      where s.workspace_id = p_workspace
        and s.archived_at is null
        and s.ended_at is null
        and not (s.split_from_id is not null and s.current_task_id is null)
        and (s.owner_id = wanted.id or (s.owner_id is null and wanted.id = (select user_id from head)))
    ),
    (select id from wanted)
  where (
    current_setting('role') = 'authenticated'
    and p_workspace in (select private.user_workspace_ids())
  ) or (
    current_setting('role') = 'crm_agent'
    and p_workspace = (select private.request_workspace_id())
  )
$$;

revoke all on function crm.series_active_count(uuid, uuid) from public;
grant execute on function crm.series_active_count(uuid, uuid) to authenticated, crm_agent;

create or replace function crm.series_taken_days(p_series uuid, p_except uuid)
returns table (day date)
language sql
stable
security definer
set search_path = ''
as $$
  select t.occurs_on
  from crm.task_series s
  join crm.tasks t on t.series_id = s.id and t.workspace_id = s.workspace_id
  where s.id = p_series
    and t.archived_at is null
    and t.id is distinct from p_except
    and (
      (
        current_setting('role') = 'authenticated'
        and s.workspace_id in (select private.user_workspace_ids())
        and (
          s.owner_id = (select private.session_user_id())
          or s.created_by_user_id = (select private.session_user_id())
          or exists (
            select 1 from crm.tasks c
            where c.id = s.current_task_id
              and (c.owner_id = (select private.session_user_id()) or c.created_by_user_id = (select private.session_user_id()))
          )
        )
      )
      or (
        current_setting('role') = 'crm_agent'
        and s.workspace_id = (select private.request_workspace_id())
        and (
          s.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
          or exists (
            select 1 from crm.tasks c
            where c.id = s.current_task_id and c.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
          )
        )
      )
    )
$$;

revoke all on function crm.series_taken_days(uuid, uuid) from public;
grant execute on function crm.series_taken_days(uuid, uuid) to authenticated, crm_agent;

create or replace function crm.series_end_with_archived(p_task uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_series s
  set ended_at = coalesce(s.ended_at, now()), roll_at = null, roll_pending = false, roll_retry_at = null
  from crm.tasks t
  where t.id = p_task
    and s.id = t.series_id
    and s.workspace_id = t.workspace_id
    and s.current_task_id = t.id
    and t.archived_at is not null
    and s.ended_at is null
    and s.archived_at is null
    and (
      (
        current_setting('role') = 'authenticated'
        and t.workspace_id in (select private.user_workspace_ids())
        and (t.owner_id = (select private.session_user_id()) or t.created_by_user_id = (select private.session_user_id()))
      )
      or (
        current_setting('role') = 'crm_agent'
        and t.workspace_id = (select private.request_workspace_id())
        and t.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
      )
    )
$$;

revoke all on function crm.series_end_with_archived(uuid) from public;
grant execute on function crm.series_end_with_archived(uuid) to authenticated, crm_agent;

create or replace function crm.series_tag_owner(p_task uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into crm.task_participants (task_id, user_id, added_by)
  select t.id, s.owner_id, null
  from crm.tasks t
  join crm.task_series s on s.id = t.series_id and s.workspace_id = t.workspace_id
  join crm.workspace_members m on m.workspace_id = t.workspace_id and m.user_id = s.owner_id
  where t.id = p_task
    and s.current_task_id = t.id
    and s.owner_id is distinct from t.owner_id
    and current_setting('role') = 'crm_agent'
    and t.workspace_id = (select private.request_workspace_id())
    and (
      s.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
      or t.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
    )
  on conflict (task_id, user_id) do nothing
$$;

revoke all on function crm.series_tag_owner(uuid) from public;
grant execute on function crm.series_tag_owner(uuid) to crm_agent;


create or replace function private.series_occurrence_allowed(p_series uuid, p_workspace uuid, p_user uuid, p_agent uuid, p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.task_series s
    where s.id = p_series
      and s.workspace_id = p_workspace
      and s.archived_at is null
      and s.created_by_user_id is not distinct from p_user
      and s.created_by_agent_id is not distinct from p_agent
      and (
        (
          (select private.session_user_id()) is not null
          and (
            s.owner_id = (select private.session_user_id())
            or s.created_by_user_id = (select private.session_user_id())
            or exists (
              select 1 from crm.tasks c
              where c.id = s.current_task_id
                and (c.owner_id = (select private.session_user_id()) or c.created_by_user_id = (select private.session_user_id()))
                and c.completed_at is not null
                and p_owner is not distinct from coalesce(
                  (select m.user_id from crm.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = s.owner_id),
                  c.owner_id
                )
            )
          )
        )
        or (
          nullif(current_setting('app.agent_id', true), '')::uuid is not null
          and (
            s.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
            or exists (
              select 1 from crm.tasks c
              where c.id = s.current_task_id and c.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
                and c.completed_at is not null
                and p_owner is not distinct from coalesce(
                  (select m.user_id from crm.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = s.owner_id),
                  c.owner_id
                )
            )
          )
        )
      )
  )
$$;

revoke all on function private.series_occurrence_allowed(uuid, uuid, uuid, uuid, uuid) from public;
grant execute on function private.series_occurrence_allowed(uuid, uuid, uuid, uuid, uuid) to authenticated, crm_agent;

drop policy if exists tasks_insert_series_member on crm.tasks;
create policy tasks_insert_series_member on crm.tasks
  for insert to authenticated
  with check (
    series_id is not null
    and workspace_id in (select private.user_workspace_ids())
    and private.series_occurrence_allowed(series_id, workspace_id, created_by_user_id, created_by_agent_id, owner_id)
  );

drop policy if exists tasks_insert_series_agent on crm.tasks;
create policy tasks_insert_series_agent on crm.tasks
  for insert to crm_agent
  with check (
    series_id is not null
    and workspace_id = (select private.request_workspace_id())
    and private.series_occurrence_allowed(series_id, workspace_id, created_by_user_id, created_by_agent_id, owner_id)
  );

drop policy if exists tasks_series_binding on crm.tasks;
create policy tasks_series_binding on crm.tasks
  as restrictive
  for insert to authenticated, crm_agent
  with check (series_id is null or private.series_occurrence_allowed(series_id, workspace_id, created_by_user_id, created_by_agent_id, owner_id));

drop function if exists private.series_occurrence_allowed(uuid, uuid, uuid, uuid);

drop policy if exists tasks_update_series_member on crm.tasks;
create policy tasks_update_series_member on crm.tasks
  for update to authenticated
  using (
    series_id is not null
    and completed_at is null
    and workspace_id in (select private.user_workspace_ids())
    and private.session_owns_series(series_id, workspace_id)
  )
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists tasks_update_series_agent on crm.tasks;
create policy tasks_update_series_agent on crm.tasks
  for update to crm_agent
  using (
    series_id is not null
    and completed_at is null
    and workspace_id = (select private.request_workspace_id())
    and private.agent_owns_series(series_id, workspace_id)
  )
  with check (workspace_id = (select private.request_workspace_id()));

create or replace function private.task_series_take_occurrence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source uuid;
begin
  select coalesce(
    s.current_task_id,
    (select p.current_task_id from crm.task_series p where p.id = s.split_from_id and p.workspace_id = s.workspace_id)
  )
  into v_source
  from crm.task_series s
  where s.id = new.series_id;
  if v_source is not null and v_source is distinct from new.id then
    insert into crm.task_participants (task_id, user_id, added_by)
    select new.id, p.user_id, p.added_by
    from crm.task_participants p
    join crm.workspace_members m on m.workspace_id = new.workspace_id and m.user_id = p.user_id
    where p.task_id = v_source
      and p.user_id is distinct from new.owner_id
    on conflict (task_id, user_id) do nothing;
    insert into crm.task_docs (task_id, page_id, workspace_id, created_by, created_by_agent_id, page_archived)
    select new.id, d.page_id, new.workspace_id, d.created_by, d.created_by_agent_id, d.page_archived
    from crm.task_docs d
    where d.task_id = v_source
      and d.workspace_id = new.workspace_id
    on conflict (task_id, page_id) do nothing;
  end if;
  update crm.task_series
  set current_task_id = new.id, roll_retry_at = null, roll_pending = (roll_pending or roll_at is null or roll_at <= now())
  where id = new.series_id and current_task_id is distinct from new.id;
  return null;
end;
$$;

revoke all on function private.task_series_take_occurrence() from public;

create or replace function private.tasks_bind_series()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_series crm.task_series%rowtype;
  v_old crm.task_series%rowtype;
  v_user uuid := (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid;
  v_agent uuid := nullif(current_setting('app.agent_id', true), '')::uuid;
begin
  if current_user not in ('authenticated', 'crm_agent') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.series_id is not null and old.series_id is distinct from new.series_id then
    select * into v_old from crm.task_series s where s.id = old.series_id;
    if found
      and not coalesce(
        (v_user is not null and (v_old.owner_id = v_user or v_old.created_by_user_id = v_user))
        or (v_agent is not null and v_old.created_by_agent_id = v_agent),
        false
      )
      and (
        not coalesce(
          (v_user is not null and (old.owner_id = v_user or old.created_by_user_id = v_user))
          or (v_agent is not null and old.created_by_agent_id = v_agent),
          false
        )
        or (v_old.current_task_id = old.id and v_old.ended_at is null and v_old.archived_at is null)
      ) then
      raise exception 'Only the repeating task''s assignee or creator can take its open task out of it.' using errcode = '42501';
    end if;
  end if;
  if new.series_id is null or (tg_op = 'UPDATE' and old.series_id is not distinct from new.series_id and old.workspace_id is not distinct from new.workspace_id) then
    return new;
  end if;
  select * into v_series from crm.task_series s where s.id = new.series_id;
  if not found then
    raise exception 'You can''t add to that repeating task.' using errcode = '42501';
  end if;
  if v_series.workspace_id <> new.workspace_id or v_series.archived_at is not null then
    raise exception 'That repeating task isn''t in this workspace.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
    v_series.current_task_id is not null and v_series.current_task_id <> new.id
    or not coalesce(
      (
        (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub') is not null
        and (
          v_series.owner_id is not distinct from (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid
          or v_series.created_by_user_id is not distinct from (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid
        )
      )
      or (
        nullif(current_setting('app.agent_id', true), '') is not null
        and v_series.created_by_agent_id is not distinct from nullif(current_setting('app.agent_id', true), '')::uuid
      ),
      false
    )
  ) then
    raise exception 'That task can''t join this repeating task.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.tasks_bind_series() from public;
grant execute on function private.tasks_bind_series() to authenticated, crm_agent;

create or replace function private.task_series_bind_current()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid;
  v_agent uuid := nullif(current_setting('app.agent_id', true), '')::uuid;
  v_owns boolean;
begin
  if tg_op = 'UPDATE' then
    v_owns := coalesce(
      (v_user is not null and (old.owner_id is not distinct from v_user or old.created_by_user_id is not distinct from v_user))
      or (v_agent is not null and old.created_by_agent_id is not distinct from v_agent),
      false
    );
  end if;
  if new.current_task_id is not null
    and (tg_op = 'INSERT' or old.current_task_id is distinct from new.current_task_id or old.workspace_id is distinct from new.workspace_id)
    and not exists (
      select 1 from crm.tasks t
      where t.id = new.current_task_id and t.series_id = new.id and t.workspace_id = new.workspace_id
    ) then
    raise exception 'A repeating task''s open task must belong to it.' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE'
    and current_user in ('authenticated', 'crm_agent')
    and not v_owns
    and (
      old.roll_at is distinct from new.roll_at
      or old.roll_retry_at is distinct from new.roll_retry_at
      or (old.roll_pending and not new.roll_pending)
      or old.id is distinct from new.id or old.workspace_id is distinct from new.workspace_id
      or old.created_by_user_id is distinct from new.created_by_user_id or old.created_by_agent_id is distinct from new.created_by_agent_id
      or old.created_at is distinct from new.created_at
      or (old.current_task_id is not null and new.current_task_id is null)
      or
      old.rule is distinct from new.rule or old.ends is distinct from new.ends or old.starts_on is distinct from new.starts_on
      or old.at is distinct from new.at or old.title is distinct from new.title or old.description is distinct from new.description
      or old.priority is distinct from new.priority or old.company_id is distinct from new.company_id
      or old.contact_id is distinct from new.contact_id or old.opportunity_id is distinct from new.opportunity_id
      or old.duration_minutes is distinct from new.duration_minutes or old.remind_minutes is distinct from new.remind_minutes
      or old.ended_at is distinct from new.ended_at or old.archived_at is distinct from new.archived_at
      or old.owner_id is distinct from new.owner_id or old.split_from_id is distinct from new.split_from_id
    ) then
    raise exception 'Only the repeating task''s assignee or creator can change every date.' using errcode = '42501';
  end if;
  if new.split_from_id is not null
    and current_user in ('authenticated', 'crm_agent')
    and (tg_op = 'INSERT' or old.split_from_id is distinct from new.split_from_id)
    and not exists (
      select 1 from crm.task_series p
      where p.id = new.split_from_id
        and p.workspace_id = new.workspace_id
        and (
          (v_user is not null and (p.owner_id = v_user or p.created_by_user_id = v_user))
          or (v_agent is not null and p.created_by_agent_id = v_agent)
        )
    ) then
    raise exception 'A repeating task can only follow on from one you can change.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.current_task_id is not null and new.current_task_id is null and new.ended_at is null and new.archived_at is null then
    new.ended_at := now();
    new.roll_at := null;
    new.roll_pending := false;
    new.roll_retry_at := null;
  end if;
  if new.owner_id is not null
    and current_user in ('authenticated', 'crm_agent')
    and (tg_op = 'INSERT' or old.owner_id is distinct from new.owner_id)
    and not exists (select 1 from crm.workspace_members m where m.workspace_id = new.workspace_id and m.user_id = new.owner_id) then
    raise exception 'Choose an assignee in this workspace.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.task_series_bind_current() from public;
grant execute on function private.task_series_bind_current() to authenticated, crm_agent;

create or replace function private.task_series_follow_move(p_source uuid, p_target uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_moved integer := 0;
  v_followed uuid[];
begin
  with followed as (
    update crm.task_series s
    set workspace_id = p_target,
        owner_id = case
          when exists (select 1 from crm.workspace_members m where m.workspace_id = p_target and m.user_id = s.owner_id) then s.owner_id
          else t.owner_id
        end,
        company_id = t.company_id,
        contact_id = t.contact_id,
        opportunity_id = t.opportunity_id,
        at = case when t.due_has_time then s.at else null end,
        remind_minutes = case when t.due_has_time then s.remind_minutes else null end,
        roll_pending = true
    from crm.tasks t
    where s.workspace_id = p_source
      and t.id = s.current_task_id
      and t.series_id = s.id
      and t.workspace_id = p_target
    returning s.id
  )
  select coalesce(array_agg(id), '{}') into v_followed from followed;
  v_moved := coalesce(array_length(v_followed, 1), 0);

  with recursive later as (
    select c.id, p.owner_id as parent_owner
    from crm.task_series c
    join crm.task_series p on p.id = c.split_from_id
    where p.id = any(v_followed) and c.workspace_id = p_source and c.current_task_id is null
      and not exists (select 1 from crm.tasks t where t.series_id = c.id)
    union
    select c.id, later.parent_owner
    from crm.task_series c
    join later on c.split_from_id = later.id
    where c.workspace_id = p_source and c.current_task_id is null
      and not exists (select 1 from crm.tasks t where t.series_id = c.id)
  )
  update crm.task_series s
  set workspace_id = p_target,
      owner_id = case
        when exists (select 1 from crm.workspace_members m where m.workspace_id = p_target and m.user_id = s.owner_id) then s.owner_id
        else later.parent_owner
      end
  from later
  where s.id = later.id;

  if to_regclass('pg_temp.orbit_move_map') is not null then
    with recursive later as (
      select c.id
      from crm.task_series c
      where c.split_from_id = any(v_followed) and c.workspace_id = p_target and c.current_task_id is null
      union
      select c.id
      from crm.task_series c
      join later on c.split_from_id = later.id
      where c.workspace_id = p_target and c.current_task_id is null
    )
    update crm.task_series s
    set company_id = coalesce((select m.new_id from pg_temp.orbit_move_map m where m.kind in ('company', 'company_link') and m.old_id = s.company_id order by m.kind limit 1), s.company_id),
        contact_id = coalesce((select m.new_id from pg_temp.orbit_move_map m where m.kind = 'contact' and m.old_id = s.contact_id limit 1), s.contact_id),
        opportunity_id = coalesce((select m.new_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card') and m.old_id = s.opportunity_id limit 1), s.opportunity_id)
    from later
    where s.id = later.id;
  end if;

  update crm.tasks t
  set series_id = null, occurs_on = null
  from crm.task_series s
  where t.series_id = s.id
    and t.workspace_id is distinct from s.workspace_id
    and t.workspace_id in (p_source, p_target);

  update crm.task_series s
  set company_id = case when s.company_id is not null and not exists (select 1 from crm.companies c where c.id = s.company_id and c.workspace_id = s.workspace_id) then null else s.company_id end,
      contact_id = case when s.contact_id is not null and not exists (select 1 from crm.contacts c where c.id = s.contact_id and c.workspace_id = s.workspace_id) then null else s.contact_id end,
      opportunity_id = case when s.opportunity_id is not null and not exists (select 1 from crm.opportunities o where o.id = s.opportunity_id and o.workspace_id = s.workspace_id) then null else s.opportunity_id end
  where s.workspace_id in (p_source, p_target)
    and (
      (s.company_id is not null and not exists (select 1 from crm.companies c where c.id = s.company_id and c.workspace_id = s.workspace_id))
      or (s.contact_id is not null and not exists (select 1 from crm.contacts c where c.id = s.contact_id and c.workspace_id = s.workspace_id))
      or (s.opportunity_id is not null and not exists (select 1 from crm.opportunities o where o.id = s.opportunity_id and o.workspace_id = s.workspace_id))
    );

  return v_moved;
end;
$$;

revoke all on function private.task_series_follow_move(uuid, uuid) from public;
grant execute on function private.task_series_follow_move(uuid, uuid) to crm_app;

create or replace function private.merge_company_references(
  p_workspace uuid,
  p_user uuid,
  p_agent uuid,
  p_keep uuid,
  p_merge uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  keep_row crm.companies%rowtype;
  merge_row crm.companies%rowtype;
  moved jsonb := '{}'::jsonb;
  target text;
  calendar_replaced integer;
  calendar_shared integer;
  marks integer;
  web_state text := 'none';
  ai_winners uuid[];
  ai_moved integer;
  follow_ups integer;
  links_dropped integer;
  links_moved integer;
  card record;
  combined jsonb := '[]'::jsonb;
begin
  perform private.merge_actor_check(p_workspace, p_user, p_agent);
  if p_keep = p_merge then
    raise exception 'Pick a different company to merge into.' using errcode = '22023';
  end if;
  perform 1 from crm.companies c
    where c.workspace_id = p_workspace and c.id in (p_keep, p_merge)
    order by c.id
    for update;
  select * into keep_row from crm.companies c where c.id = p_keep and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The company to keep isn''t in this workspace.' using errcode = 'P0002';
  end if;
  select * into merge_row from crm.companies c where c.id = p_merge and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The company to merge isn''t in this workspace.' using errcode = 'P0002';
  end if;
  if keep_row.archived_at is not null then
    raise exception '% is archived, so it can''t be merged into.', keep_row.name using errcode = '22023';
  end if;
  if merge_row.archived_at is not null then
    raise exception '% is already archived, so it can''t be merged.', merge_row.name using errcode = '22023';
  end if;

  perform set_config('orbit.merging', 'on', true);

  for card in
    select dup.id as dup_id, kept.id as kept_id, dup.pipeline_id
    from crm.opportunities dup
    join crm.pipelines p on p.id = dup.pipeline_id and p.kind = 'board'
    join lateral (
      select k.id from crm.opportunities k
      where k.workspace_id = p_workspace and k.pipeline_id = dup.pipeline_id
        and k.company_id = p_keep and k.archived_at is null
      order by k.created_at, k.id
      limit 1
    ) kept on true
    where dup.workspace_id = p_workspace and dup.company_id = p_merge and dup.archived_at is null
    order by dup.created_at, dup.id
  loop
    update crm.activities set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.tasks set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.task_series set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.documents set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.opportunities set archived_at = now() where id = card.dup_id;
    combined := combined || jsonb_build_array(jsonb_build_object(
      'id', card.dup_id, 'keptId', card.kept_id, 'pipelineId', card.pipeline_id
    ));
  end loop;

  foreach target in array array[
    'contacts', 'opportunities', 'tasks', 'activities', 'email_messages', 'call_records',
    'call_insights', 'conversation_imports', 'workflow_runs', 'documents', 'memories',
    'market_notes', 'watchlist', 'knowledge_items', 'company_signals'
  ] loop
    moved := moved || jsonb_build_object(target, private.merge_move(target, 'company_id', p_workspace, p_merge, p_keep));
  end loop;
  perform private.merge_move('task_series', 'company_id', p_workspace, p_merge, p_keep);

  with changed as (
    update crm.calendar_events e
    set company_ids = array_replace(e.company_ids, p_merge, p_keep)
    where e.workspace_id = p_workspace and p_merge = any(e.company_ids) and not (p_keep = any(e.company_ids))
    returning e.id
  )
  select count(*)::integer into calendar_replaced from changed;
  with changed as (
    update crm.calendar_events e
    set company_ids = array_remove(e.company_ids, p_merge)
    where e.workspace_id = p_workspace and p_merge = any(e.company_ids)
    returning e.id
  )
  select count(*)::integer into calendar_shared from changed;

  with changed as (
    update crm.workflow_record_marks m
    set record_id = p_keep
    where m.workspace_id = p_workspace and m.record_id = p_merge
      and not exists (
        select 1 from crm.workflow_record_marks k
        where k.workflow_id = m.workflow_id and k.record_id = p_keep
      )
    returning m.workflow_id
  )
  select count(*)::integer into marks from changed;

  update crm.follow_up_suggestions f set company_id = p_keep where f.company_id = p_merge;
  get diagnostics follow_ups = row_count;

  select coalesce(array_agg(m.field_id), '{}'::uuid[])
  into ai_winners
  from crm.ai_field_answers m
  left join crm.ai_field_answers k on k.field_id = m.field_id and k.company_id = p_keep
  where m.company_id = p_merge
    and m.workspace_id = p_workspace
    and (case when m.manual then 3 when m.state = 'answered' then 2 else 1 end)
      > (case when k.field_id is null then 0 when k.manual then 3 when k.state = 'answered' then 2 else 1 end);
  delete from crm.ai_field_answers k
  where k.company_id = p_keep and k.field_id = any(ai_winners);
  update crm.ai_field_answers m
  set company_id = p_keep
  where m.company_id = p_merge and m.field_id = any(ai_winners);
  get diagnostics ai_moved = row_count;

  delete from crm.page_links l
  where l.target_kind = 'company' and l.target_record_id = p_merge
    and exists (
      select 1 from crm.page_links k
      where k.page_id = l.page_id and k.target_kind = 'company' and k.target_record_id = p_keep
    );
  get diagnostics links_dropped = row_count;
  update crm.page_links l
  set target_record_id = p_keep
  where l.target_kind = 'company' and l.target_record_id = p_merge;
  get diagnostics links_moved = row_count;

  if exists (select 1 from crm.company_web_state w where w.company_id = p_merge) then
    if exists (select 1 from crm.company_web_state w where w.company_id = p_keep) then
      web_state := 'kept';
    else
      update crm.company_web_state set company_id = p_keep where company_id = p_merge;
      web_state := 'moved';
    end if;
  end if;

  perform set_config('orbit.merging', 'off', true);

  return moved || jsonb_build_object(
    'calendar_events', calendar_replaced,
    'calendar_events_shared', calendar_shared,
    'workflow_record_marks', marks,
    'company_web_state', web_state,
    'ai_field_answers', ai_moved,
    'follow_up_suggestions', follow_ups,
    'page_links', links_dropped + links_moved,
    'combined_cards', combined
  );
end;
$$;

create or replace function private.merge_contact_references(
  p_workspace uuid,
  p_user uuid,
  p_agent uuid,
  p_keep uuid,
  p_merge uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  keep_row crm.contacts%rowtype;
  merge_row crm.contacts%rowtype;
  moved jsonb := '{}'::jsonb;
  target text;
  calendar_replaced integer;
  calendar_shared integer;
  marks integer;
  follow_ups integer;
  routes integer;
  links_dropped integer;
  links_moved integer;
begin
  perform private.merge_actor_check(p_workspace, p_user, p_agent);
  if p_keep = p_merge then
    raise exception 'Pick a different person to merge into.' using errcode = '22023';
  end if;
  perform 1 from crm.contacts c
    where c.workspace_id = p_workspace and c.id in (p_keep, p_merge)
    order by c.id
    for update;
  select * into keep_row from crm.contacts c where c.id = p_keep and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The person to keep isn''t in this workspace.' using errcode = 'P0002';
  end if;
  select * into merge_row from crm.contacts c where c.id = p_merge and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The person to merge isn''t in this workspace.' using errcode = 'P0002';
  end if;
  if keep_row.archived_at is not null then
    raise exception '% is archived, so they can''t be merged into.',
      coalesce(nullif(trim(concat_ws(' ', keep_row.first_name, keep_row.last_name)), ''), keep_row.email, 'This person')
      using errcode = '22023';
  end if;
  if merge_row.archived_at is not null then
    raise exception '% is already archived, so they can''t be merged.',
      coalesce(nullif(trim(concat_ws(' ', merge_row.first_name, merge_row.last_name)), ''), merge_row.email, 'This person')
      using errcode = '22023';
  end if;

  perform set_config('orbit.merging', 'on', true);

  foreach target in array array[
    'tasks', 'activities', 'email_messages', 'call_records', 'call_insights',
    'conversation_imports', 'workflow_runs', 'documents'
  ] loop
    moved := moved || jsonb_build_object(target, private.merge_move(target, 'contact_id', p_workspace, p_merge, p_keep));
  end loop;
  perform private.merge_move('task_series', 'contact_id', p_workspace, p_merge, p_keep);
  moved := moved || jsonb_build_object(
    'opportunities', private.merge_move('opportunities', 'primary_contact_id', p_workspace, p_merge, p_keep)
  );

  with changed as (
    update crm.calendar_events e
    set contact_ids = array_replace(e.contact_ids, p_merge, p_keep)
    where e.workspace_id = p_workspace and p_merge = any(e.contact_ids) and not (p_keep = any(e.contact_ids))
    returning e.id
  )
  select count(*)::integer into calendar_replaced from changed;
  with changed as (
    update crm.calendar_events e
    set contact_ids = array_remove(e.contact_ids, p_merge)
    where e.workspace_id = p_workspace and p_merge = any(e.contact_ids)
    returning e.id
  )
  select count(*)::integer into calendar_shared from changed;

  with changed as (
    update crm.workflow_record_marks m
    set record_id = p_keep
    where m.workspace_id = p_workspace and m.record_id = p_merge
      and not exists (
        select 1 from crm.workflow_record_marks k
        where k.workflow_id = m.workflow_id and k.record_id = p_keep
      )
    returning m.workflow_id
  )
  select count(*)::integer into marks from changed;

  update crm.follow_up_suggestions f set contact_id = p_keep where f.contact_id = p_merge;
  get diagnostics follow_ups = row_count;
  update crm.mail_thread_routes r set contact_id = p_keep where r.contact_id = p_merge;
  get diagnostics routes = row_count;

  delete from crm.page_links l
  where l.target_kind = 'contact' and l.target_record_id = p_merge
    and exists (
      select 1 from crm.page_links k
      where k.page_id = l.page_id and k.target_kind = 'contact' and k.target_record_id = p_keep
    );
  get diagnostics links_dropped = row_count;
  update crm.page_links l
  set target_record_id = p_keep
  where l.target_kind = 'contact' and l.target_record_id = p_merge;
  get diagnostics links_moved = row_count;

  perform set_config('orbit.merging', 'off', true);

  return moved || jsonb_build_object(
    'calendar_events', calendar_replaced,
    'calendar_events_shared', calendar_shared,
    'workflow_record_marks', marks,
    'follow_up_suggestions', follow_ups,
    'mail_thread_routes', routes,
    'page_links', links_dropped + links_moved
  );
end;
$$;

revoke all on function private.merge_company_references(uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) from public;
grant execute on function private.merge_company_references(uuid, uuid, uuid, uuid, uuid) to crm_app;
grant execute on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) to crm_app;

create or replace function private.team_remove_records(
  p_workspace uuid,
  p_actor uuid,
  p_user uuid,
  p_source text default null,
  p_operation text default 'remove_member',
  p_source_url text default null
)
returns table (record_kind text, record_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := private.team_role(p_workspace, p_actor);
  target_role text := private.team_role(p_workspace, p_user);
  next_home uuid;
  handed jsonb := '[]'::jsonb;
  owner_only jsonb := jsonb_build_object('ownerId', p_user);
  owner_now jsonb := jsonb_build_object('ownerId', p_actor);
begin
  if coalesce(actor_role, '') not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can remove people.' using errcode = '42501';
  end if;
  if target_role is null then
    raise exception 'They are not in this workspace.' using errcode = '22023';
  end if;
  if target_role = 'owner' then
    raise exception 'The owner can''t be removed.' using errcode = '42501';
  end if;
  if p_user = p_actor then
    raise exception 'You can''t remove yourself.' using errcode = '42501';
  end if;
  if target_role = 'admin' and actor_role <> 'owner' then
    raise exception 'Only the owner can remove an admin.' using errcode = '42501';
  end if;
  select m.workspace_id into next_home
  from crm.workspace_members m
  where m.user_id = p_user and m.workspace_id <> p_workspace
  order by m.created_at, m.workspace_id
  limit 1;

  with moved as (
    update crm.companies c set owner_id = p_actor
    where c.workspace_id = p_workspace and c.owner_id = p_user
    returning c.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'company', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  with moved as (
    update crm.contacts c set owner_id = p_actor
    where c.workspace_id = p_workspace and c.owner_id = p_user
    returning c.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'contact', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  with moved as (
    update crm.opportunities o set owner_id = p_actor
    where o.workspace_id = p_workspace and o.owner_id = p_user
    returning o.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'opportunity', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  with prior as (
    select t.id, t.owner_id, t.due_at, t.due_has_time, t.scheduled_by, t.remind_minutes
    from crm.tasks t
    where t.workspace_id = p_workspace
      and (t.owner_id = p_user or (t.owner_id is null and t.created_by_user_id = p_user))
    for update
  ),
  moved as (
    update crm.tasks t
      set owner_id = p_actor,
          due_at = case
            when t.due_has_time and t.due_at is not null
            then date_trunc('day', t.due_at at time zone 'Europe/London') at time zone 'Europe/London'
            else t.due_at
          end,
          scheduled_by = case when t.due_has_time then null else t.scheduled_by end,
          remind_minutes = case when t.due_has_time then null else t.remind_minutes end,
          due_has_time = false
    from prior
    where t.id = prior.id
    returning t.id, t.due_at, t.scheduled_by, t.remind_minutes
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object(
    'kind', 'task',
    'id', moved.id,
    'changes', private.handover_changes(
      jsonb_build_object(
        'ownerId', prior.owner_id,
        'dueAt', private.handover_instant(prior.due_at),
        'dueHasTime', coalesce(prior.due_has_time and prior.due_at is not null, false),
        'scheduledBy', prior.scheduled_by,
        'remindMinutes', prior.remind_minutes
      ),
      jsonb_build_object(
        'ownerId', p_actor,
        'dueAt', private.handover_instant(moved.due_at),
        'dueHasTime', false,
        'scheduledBy', moved.scheduled_by,
        'remindMinutes', moved.remind_minutes
      ),
      array['ownerId', 'dueAt', 'dueHasTime', 'scheduledBy', 'remindMinutes']
    )
  )), '[]'::jsonb)
  into handed
  from moved
  join prior on prior.id = moved.id;

  with moved as (
    update crm.documents d set owner_id = p_actor
    where d.workspace_id = p_workspace and d.owner_id = p_user
    returning d.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'document', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  with series_events as (
    insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, source, source_url, operation, changes)
    select p_workspace, 'task_series.updated', 'task', s.current_task_id, 'user', p_actor, p_source, p_source_url, p_operation,
      jsonb_build_object(
        'series', jsonb_build_object('id', s.id),
        'handedOver', jsonb_build_object('from', p_user, 'to', p_actor, 'owner', s.owner_id = p_user, 'creator', s.created_by_user_id = p_user)
      )
    from crm.task_series s
    where s.workspace_id = p_workspace and (s.owner_id = p_user or s.created_by_user_id = p_user) and s.current_task_id is not null
    returning id, event_type, entity_type, entity_id, changes, created_at
  )
  insert into crm.webhook_deliveries (workspace_id, endpoint_id, event_id, event_type, payload)
  select p_workspace, endpoint.id, series_events.id, series_events.event_type, jsonb_build_object(
    'id', series_events.id,
    'type', series_events.event_type,
    'createdAt', private.handover_instant(series_events.created_at),
    'workspaceId', p_workspace,
    'entity', jsonb_build_object('type', series_events.entity_type, 'id', series_events.entity_id),
    'actor', jsonb_build_object('type', 'user', 'userId', p_actor, 'agentId', null),
    'source', p_source,
    'sourceUrl', p_source_url,
    'data', series_events.changes
  )
  from series_events
  join crm.webhook_endpoints endpoint
    on endpoint.workspace_id = p_workspace
   and endpoint.archived_at is null
   and endpoint.enabled
   and (series_events.event_type = any(endpoint.events) or '*' = any(endpoint.events));
  insert into crm.task_participants (task_id, user_id, added_by)
  select s.current_task_id, p_actor, p_actor
  from crm.task_series s
  join crm.tasks t on t.id = s.current_task_id
  where s.workspace_id = p_workspace and (s.owner_id = p_user or s.created_by_user_id = p_user)
    and t.owner_id is distinct from p_actor and t.created_by_user_id is distinct from p_actor
  on conflict do nothing;
  update crm.task_series s
  set owner_id = p_actor,
      at = null,
      remind_minutes = null,
      roll_pending = case when s.ended_at is null and s.archived_at is null then true else s.roll_pending end
  where s.workspace_id = p_workspace and s.owner_id = p_user;
  update crm.task_series s set created_by_user_id = p_actor
  where s.workspace_id = p_workspace and s.created_by_user_id = p_user;

  with items as (
    select item ->> 'kind' as kind, (item ->> 'id')::uuid as id, item -> 'changes' as changes
    from jsonb_array_elements(handed) as item
  ),
  events as (
    insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, source, source_url, operation, changes)
    select p_workspace, items.kind || '.updated', items.kind, items.id, 'user', p_actor, p_source, p_source_url, p_operation, items.changes
    from items
    returning id, event_type, entity_type, entity_id, changes, created_at
  )
  insert into crm.webhook_deliveries (workspace_id, endpoint_id, event_id, event_type, payload)
  select p_workspace, endpoint.id, events.id, events.event_type, jsonb_build_object(
    'id', events.id,
    'type', events.event_type,
    'createdAt', private.handover_instant(events.created_at),
    'workspaceId', p_workspace,
    'entity', jsonb_build_object('type', events.entity_type, 'id', events.entity_id),
    'actor', jsonb_build_object('type', 'user', 'userId', p_actor, 'agentId', null),
    'source', p_source,
    'sourceUrl', p_source_url,
    'data', events.changes
  )
  from events
  join crm.webhook_endpoints endpoint
    on endpoint.workspace_id = p_workspace
   and endpoint.archived_at is null
   and endpoint.enabled
   and (events.event_type = any(endpoint.events) or '*' = any(endpoint.events));

  update crm.webhook_endpoints set created_by_user_id = p_actor
  where workspace_id = p_workspace and created_by_user_id = p_user;

  if next_home is not null then
    perform private.move_personal_rows(p_user, p_workspace, next_home);
  else
    update crm.mailbox_connections
      set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
      where workspace_id = p_workspace and user_id = p_user;
    update crm.calendar_accounts
      set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
      where workspace_id = p_workspace and user_id = p_user;
    delete from crm.ai_accounts where workspace_id = p_workspace and user_id = p_user;
    update crm.ai_companions set revoked_at = now()
      where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  end if;
  delete from crm.granola_keys where workspace_id = p_workspace and user_id = p_user;
  delete from crm.readwise_keys where workspace_id = p_workspace and user_id = p_user;
  delete from crm.recall_keys where workspace_id = p_workspace and user_id = p_user;
  update crm.personal_tokens set revoked_at = now()
    where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  update crm.agent_mail_messages
    set status = 'failed', status_reason = 'They left the workspace.', advancing_until = null
    where workspace_id = p_workspace and user_id = p_user and status in ('received', 'working') and replied_at is null;
  delete from crm.agent_mail_threads where workspace_id = p_workspace and user_id = p_user;
  delete from crm.workspace_members where workspace_id = p_workspace and user_id = p_user;

  return query
    select item ->> 'kind', (item ->> 'id')::uuid
    from jsonb_array_elements(handed) as item;
end;
$$;

revoke all on function private.team_remove_records(uuid, uuid, uuid, text, text, text) from public;
grant execute on function private.team_remove_records(uuid, uuid, uuid, text, text, text) to crm_app;

update crm.task_series s
set roll_pending = true
where s.ended_at is null and s.archived_at is null and s.current_task_id is not null and s.roll_at is null and not s.roll_pending
  and exists (select 1 from crm.tasks t where t.id = s.current_task_id and t.completed_at is null and t.archived_at is null);

update crm.task_series s
set ended_at = now(), roll_at = null, roll_pending = false, roll_retry_at = null
where s.ended_at is null and s.archived_at is null and s.current_task_id is null and s.split_from_id is null;

do $$
declare
  v_index text;
begin
  foreach v_index in array array['tasks_series_occurs_idx', 'tasks_series_open_idx', 'tasks_series_idx'] loop
    if exists (
      select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'crm' and c.relname = v_index and not i.indisvalid
    ) then
      execute format('drop index crm.%I', v_index);
    end if;
  end loop;
end
$$;

reset lock_timeout;

create unique index concurrently if not exists tasks_series_occurs_idx on crm.tasks (series_id, occurs_on) where series_id is not null and archived_at is null;

create unique index concurrently if not exists tasks_series_open_idx on crm.tasks (series_id) where series_id is not null and completed_at is null and archived_at is null;

create index concurrently if not exists tasks_series_idx on crm.tasks (series_id, occurs_on desc) where series_id is not null;
