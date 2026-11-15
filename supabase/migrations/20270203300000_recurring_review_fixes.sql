set lock_timeout = '5s';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'task_series_ends_shape' and conrelid = 'crm.task_series'::regclass
      and pg_get_constraintdef(oid) like '%''spent''%'
  ) then
    alter table crm.task_series drop constraint if exists task_series_ends_shape;
    alter table crm.task_series add constraint task_series_ends_shape check (
      jsonb_typeof(ends) = 'object'
      and (
        ends = '{"never": true}'::jsonb
        or (
          (ends - 'count' - 'spent') = '{}'::jsonb
          and jsonb_typeof(ends -> 'count') = 'number'
          and (ends ->> 'count') ~ '^[1-9][0-9]{0,2}$'
          and (not (ends ? 'spent') or (jsonb_typeof(ends -> 'spent') = 'number' and (ends ->> 'spent') ~ '^(0|[1-9][0-9]{0,5})$'))
        )
        or (
          (ends - 'until') = '{}'::jsonb
          and jsonb_typeof(ends -> 'until') = 'string'
          and (ends ->> 'until') ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
        )
      )
    );
  end if;
end
$$;

drop function if exists crm.series_active_count(uuid, uuid);

create or replace function crm.series_at_limit(p_workspace uuid, p_owner uuid, p_limit integer)
returns table (at_limit boolean, keeper uuid)
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
      select count(*)
      from crm.task_series s, wanted
      where s.workspace_id = p_workspace
        and s.archived_at is null
        and s.ended_at is null
        and not (s.split_from_id is not null and s.current_task_id is null)
        and (s.owner_id = wanted.id or (s.owner_id is null and wanted.id = (select user_id from head)))
    ) >= p_limit,
    (select id from wanted)
  where (
    current_setting('role') = 'authenticated'
    and p_workspace in (select private.user_workspace_ids())
  ) or (
    current_setting('role') = 'crm_agent'
    and p_workspace = (select private.request_workspace_id())
  )
$$;

revoke all on function crm.series_at_limit(uuid, uuid, integer) from public;
grant execute on function crm.series_at_limit(uuid, uuid, integer) to authenticated, crm_agent;

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
          current_setting('role') = 'authenticated'
          and (select private.session_user_id()) is not null
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
          current_setting('role') = 'crm_agent'
          and nullif(current_setting('app.agent_id', true), '')::uuid is not null
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
    and ((completed_at is null and archived_at is null) or private.session_owns_series(series_id, workspace_id))
  );

drop policy if exists tasks_insert_series_agent on crm.tasks;
create policy tasks_insert_series_agent on crm.tasks
  for insert to crm_agent
  with check (
    series_id is not null
    and workspace_id = (select private.request_workspace_id())
    and private.series_occurrence_allowed(series_id, workspace_id, created_by_user_id, created_by_agent_id, owner_id)
    and ((completed_at is null and archived_at is null) or private.agent_owns_series(series_id, workspace_id))
  );

create or replace function private.tasks_bind_series()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_series crm.task_series%rowtype;
  v_old crm.task_series%rowtype;
  v_user uuid := case when current_user = 'authenticated' then (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid end;
  v_agent uuid := case when current_user = 'crm_agent' then nullif(current_setting('app.agent_id', true), '')::uuid end;
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
      (v_user is not null and (v_series.owner_id is not distinct from v_user or v_series.created_by_user_id is not distinct from v_user))
      or (v_agent is not null and v_series.created_by_agent_id is not distinct from v_agent),
      false
    )
  ) then
    raise exception 'That task can''t join this repeating task.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.tasks_bind_series() from public, authenticated, crm_agent;

create or replace function private.task_series_bind_current()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := case when current_user = 'authenticated' then (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid end;
  v_agent uuid := case when current_user = 'crm_agent' then nullif(current_setting('app.agent_id', true), '')::uuid end;
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

revoke all on function private.task_series_bind_current() from public, authenticated, crm_agent;

create or replace function private.task_series_needs_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('role') in ('authenticated', 'crm_agent') and exists (
    select 1 from crm.task_series s
    where s.id = new.id
      and s.current_task_id is null
      and s.split_from_id is null
      and s.ended_at is null
      and s.archived_at is null
  ) then
    raise exception 'A repeating task needs its first task.' using errcode = '23514';
  end if;
  return null;
end;
$$;

revoke all on function private.task_series_needs_task() from public;

drop trigger if exists task_series_needs_task on crm.task_series;
create constraint trigger task_series_needs_task
  after insert on crm.task_series
  deferrable initially deferred
  for each row
  execute function private.task_series_needs_task();

create or replace function private.tasks_leave_series()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from crm.task_series where id = old.series_id for update;
  update crm.task_series
  set current_task_id = null, roll_at = null, roll_pending = false, roll_retry_at = null, ended_at = coalesce(ended_at, now())
  where id = old.series_id and current_task_id = new.id;
  return null;
end;
$$;

revoke all on function private.tasks_leave_series() from public;

create or replace function private.task_participants_keep_series_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('role') is distinct from 'authenticated' or old.user_id is not distinct from (select private.session_user_id()) then
    return old;
  end if;
  if exists (
    select 1 from crm.task_series s
    join crm.tasks t on t.id = s.current_task_id
    join crm.workspace_members m on m.workspace_id = s.workspace_id and m.user_id = s.owner_id
    where s.current_task_id = old.task_id
      and s.owner_id = old.user_id
      and t.owner_id is distinct from old.user_id
      and s.ended_at is null
      and s.archived_at is null
  ) then
    return null;
  end if;
  return old;
end;
$$;

revoke all on function private.task_participants_keep_series_owner() from public;

drop trigger if exists task_participants_keep_series_owner on crm.task_participants;
create trigger task_participants_keep_series_owner
  before delete on crm.task_participants
  for each row
  execute function private.task_participants_keep_series_owner();

create or replace function private.series_anchor_task(p_series uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with recursive up as (
    select s.id, s.split_from_id, s.current_task_id, 0 as depth
    from crm.task_series s
    where s.id = p_series
    union all
    select p.id, p.split_from_id, p.current_task_id, up.depth + 1
    from crm.task_series p
    join up on p.id = up.split_from_id
    where up.current_task_id is null and up.depth < 20
  )
  select up.current_task_id from up where up.current_task_id is not null order by up.depth limit 1
$$;

revoke all on function private.series_anchor_task(uuid) from public;

create or replace function private.series_link_snapshot(p_series crm.task_series)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'workspaceId', p_series.workspace_id,
    'ownerId', p_series.owner_id,
    'companyId', p_series.company_id,
    'contactId', p_series.contact_id,
    'opportunityId', p_series.opportunity_id,
    'at', to_char(p_series.at, 'HH24:MI'),
    'remindMinutes', p_series.remind_minutes
  )
$$;

revoke all on function private.series_link_snapshot(crm.task_series) from public;

create or replace function private.series_follow_move(p_source uuid, p_target uuid)
returns table (series_id uuid, task_id uuid, workspace_id uuid, before jsonb, after jsonb)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  create temporary table if not exists orbit_move_map (
    kind text not null,
    old_id uuid not null,
    new_id uuid,
    merged boolean not null default false,
    stage_id uuid,
    primary key (kind, old_id)
  ) on commit drop;
  create temporary table if not exists orbit_series_follow (
    id uuid primary key,
    root_task uuid,
    followed boolean not null,
    owner_id uuid,
    company_id uuid,
    contact_id uuid,
    opportunity_id uuid,
    in_workspace uuid,
    was jsonb,
    now_is jsonb
  ) on commit drop;
  delete from pg_temp.orbit_series_follow;

  insert into pg_temp.orbit_series_follow (id, root_task, followed, owner_id, company_id, contact_id, opportunity_id, was)
  select s.id, t.id, true,
    case
      when exists (select 1 from crm.workspace_members m where m.workspace_id = p_target and m.user_id = s.owner_id) then s.owner_id
      else t.owner_id
    end,
    coalesce((select m.new_id from pg_temp.orbit_move_map m where m.kind in ('company', 'company_link') and m.old_id = s.company_id order by m.kind limit 1), t.company_id),
    coalesce((select m.new_id from pg_temp.orbit_move_map m where m.kind = 'contact' and m.old_id = s.contact_id limit 1), t.contact_id),
    coalesce((select m.new_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card') and m.old_id = s.opportunity_id order by m.kind limit 1), t.opportunity_id),
    private.series_link_snapshot(s)
  from crm.task_series s
  join crm.tasks t on t.id = s.current_task_id and t.series_id = s.id
  where s.workspace_id = p_source
    and t.workspace_id = p_target;

  with recursive later as (
    select c.id, f.id as root
    from crm.task_series c
    join pg_temp.orbit_series_follow f on f.followed and c.split_from_id = f.id
    where c.workspace_id = p_source and c.current_task_id is null
      and not exists (select 1 from crm.tasks t where t.series_id = c.id)
    union
    select c.id, later.root
    from crm.task_series c
    join later on c.split_from_id = later.id
    where c.workspace_id = p_source and c.current_task_id is null
      and not exists (select 1 from crm.tasks t where t.series_id = c.id)
  )
  insert into pg_temp.orbit_series_follow (id, root_task, followed, owner_id, company_id, contact_id, opportunity_id, was)
  select s.id, f.root_task, false,
    case
      when exists (select 1 from crm.workspace_members m where m.workspace_id = p_target and m.user_id = s.owner_id) then s.owner_id
      else f.owner_id
    end,
    (select m.new_id from pg_temp.orbit_move_map m where m.kind in ('company', 'company_link') and m.old_id = s.company_id order by m.kind limit 1),
    (select m.new_id from pg_temp.orbit_move_map m where m.kind = 'contact' and m.old_id = s.contact_id limit 1),
    (select m.new_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card') and m.old_id = s.opportunity_id order by m.kind limit 1),
    private.series_link_snapshot(s)
  from later
  join crm.task_series s on s.id = later.id
  join pg_temp.orbit_series_follow f on f.id = later.root
  on conflict (id) do nothing;

  update pg_temp.orbit_series_follow f
  set company_id = case when exists (select 1 from crm.companies c where c.id = f.company_id and c.workspace_id = p_target) then f.company_id end,
      contact_id = case when exists (select 1 from crm.contacts c where c.id = f.contact_id and c.workspace_id = p_target) then f.contact_id end,
      opportunity_id = case when exists (select 1 from crm.opportunities o where o.id = f.opportunity_id and o.workspace_id = p_target) then f.opportunity_id end;

  update pg_temp.orbit_series_follow f
  set contact_id = case
        when f.company_id is not null
          and coalesce((select c.company_id from crm.contacts c where c.id = f.contact_id), f.company_id) <> f.company_id
        then null
        else f.contact_id
      end,
      opportunity_id = case
        when f.company_id is not null
          and (select o.company_id from crm.opportunities o where o.id = f.opportunity_id) is distinct from f.company_id
        then null
        else f.opportunity_id
      end;

  update crm.task_series s
  set workspace_id = p_target,
      owner_id = f.owner_id,
      company_id = f.company_id,
      contact_id = f.contact_id,
      opportunity_id = f.opportunity_id,
      at = case when s.owner_id is not null and f.owner_id is distinct from s.owner_id then null else s.at end,
      remind_minutes = case when s.owner_id is not null and f.owner_id is distinct from s.owner_id then null else s.remind_minutes end,
      roll_pending = case when f.followed then true else s.roll_pending end
  from pg_temp.orbit_series_follow f
  where s.id = f.id;

  update crm.task_occurrence_changes c
  set due_at = date_trunc('day', c.due_at at time zone 'Europe/London') at time zone 'Europe/London',
      due_has_time = false
  from pg_temp.orbit_series_follow f
  where c.series_id = f.id
    and c.due_has_time
    and f.was ->> 'ownerId' is not null
    and (f.was ->> 'ownerId')::uuid is distinct from f.owner_id;

  update crm.tasks t
  set series_id = null, occurs_on = null
  from crm.task_series s
  where t.series_id = s.id
    and t.workspace_id is distinct from s.workspace_id
    and t.workspace_id in (p_source, p_target);

  with stale as (
    select s.id, private.series_link_snapshot(s) as was
    from crm.task_series s
    where s.workspace_id in (p_source, p_target)
      and (
        (s.company_id is not null and not exists (select 1 from crm.companies c where c.id = s.company_id and c.workspace_id = s.workspace_id))
        or (s.contact_id is not null and not exists (select 1 from crm.contacts c where c.id = s.contact_id and c.workspace_id = s.workspace_id))
        or (s.opportunity_id is not null and not exists (select 1 from crm.opportunities o where o.id = s.opportunity_id and o.workspace_id = s.workspace_id))
      )
    for update
  ),
  cleared as (
    update crm.task_series s
    set company_id = case when s.company_id is not null and not exists (select 1 from crm.companies c where c.id = s.company_id and c.workspace_id = s.workspace_id) then null else s.company_id end,
        contact_id = case when s.contact_id is not null and not exists (select 1 from crm.contacts c where c.id = s.contact_id and c.workspace_id = s.workspace_id) then null else s.contact_id end,
        opportunity_id = case when s.opportunity_id is not null and not exists (select 1 from crm.opportunities o where o.id = s.opportunity_id and o.workspace_id = s.workspace_id) then null else s.opportunity_id end
    from stale
    where s.id = stale.id
    returning s.id, stale.was
  )
  insert into pg_temp.orbit_series_follow (id, followed, was)
  select cleared.id, false, cleared.was from cleared
  on conflict (id) do nothing;

  update pg_temp.orbit_series_follow f
  set now_is = private.series_link_snapshot(s),
      in_workspace = s.workspace_id,
      root_task = coalesce(f.root_task, private.series_anchor_task(s.id))
  from crm.task_series s
  where s.id = f.id;

  return query
    select f.id, f.root_task, f.in_workspace, f.was, f.now_is
    from pg_temp.orbit_series_follow f;
end;
$$;

revoke all on function private.series_follow_move(uuid, uuid) from public;
grant execute on function private.series_follow_move(uuid, uuid) to crm_app;

create or replace function private.task_series_follow_move(p_source uuid, p_target uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  select count(*)::integer
  from private.series_follow_move(p_source, p_target) f
  where f.before ->> 'workspaceId' is distinct from f.after ->> 'workspaceId'
$$;

revoke all on function private.task_series_follow_move(uuid, uuid) from public;
grant execute on function private.task_series_follow_move(uuid, uuid) to crm_app;

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

  update crm.task_occurrence_changes c
  set due_at = date_trunc('day', c.due_at at time zone 'Europe/London') at time zone 'Europe/London',
      due_has_time = false
  from crm.task_series s
  where c.series_id = s.id
    and s.workspace_id = p_workspace
    and s.owner_id = p_user
    and c.due_has_time;
  insert into crm.task_participants (task_id, user_id, added_by)
  select s.current_task_id, p_actor, p_actor
  from crm.task_series s
  join crm.tasks t on t.id = s.current_task_id
  where s.workspace_id = p_workspace and (s.owner_id = p_user or s.created_by_user_id = p_user)
    and t.owner_id is distinct from p_actor and t.created_by_user_id is distinct from p_actor
  on conflict do nothing;
  with series_events as (
    insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, source, source_url, operation, changes)
    select p_workspace, 'task_series.updated', 'task', handed_series.anchor, 'user', p_actor, p_source, p_source_url, p_operation,
      jsonb_build_object(
        'series', jsonb_build_object('id', handed_series.id),
        'handedOver', jsonb_build_object('from', p_user, 'to', p_actor, 'owner', handed_series.owner_id = p_user, 'creator', handed_series.created_by_user_id = p_user)
      )
    from (
      select s.id, s.owner_id, s.created_by_user_id, coalesce(s.current_task_id, private.series_anchor_task(s.id)) as anchor
      from crm.task_series s
      where s.workspace_id = p_workspace and (s.owner_id = p_user or s.created_by_user_id = p_user)
        and (s.current_task_id is not null or (s.split_from_id is not null and s.ended_at is null and s.archived_at is null))
    ) handed_series
    where handed_series.anchor is not null
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

drop function if exists private.claim_series_outlook(uuid[], uuid, integer);
create function private.claim_series_outlook(p_task_ids uuid[], p_user_id uuid, p_limit integer)
returns table (
  series_id uuid,
  workspace_id uuid,
  owner_id uuid,
  owner_member boolean,
  title text,
  starts_on text,
  at text,
  duration_minutes integer,
  rule jsonb,
  ends jsonb,
  ended boolean,
  current_task_id uuid,
  current_occurs_on text,
  current_due_at timestamptz,
  changes jsonb,
  user_id uuid,
  master_id text,
  create_key uuid,
  create_user_id uuid,
  create_sent_at timestamptz,
  written jsonb,
  dates jsonb,
  version bigint,
  attempts integer,
  lease text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_claimed uuid[];
begin
  with picked as (
    select o.series_id
    from crm.task_series_outlook o
    join crm.task_series s on s.id = o.series_id
    where o.version > o.settled_version
      and (o.claimed_at is null or o.claimed_at < clock_timestamp() - interval '2 minutes')
      and (o.retry_at is null or o.retry_at <= clock_timestamp())
      and (p_task_ids is null or s.current_task_id = any(p_task_ids))
      and (p_user_id is null or s.owner_id = p_user_id or o.user_id = p_user_id or o.create_user_id = p_user_id)
    order by o.updated_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of o skip locked
  ), claimed as (
    update crm.task_series_outlook o
    set claimed_at = clock_timestamp()
    from picked
    where o.series_id = picked.series_id
    returning o.series_id
  )
  select coalesce(array_agg(claimed.series_id), '{}') into v_claimed from claimed;

  return query
  select s.id, s.workspace_id, s.owner_id,
    exists (select 1 from crm.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = s.owner_id),
    s.title, s.starts_on::text, to_char(s.at, 'HH24:MI'), s.duration_minutes, s.rule, s.ends,
    (s.ended_at is not null or s.archived_at is not null),
    s.current_task_id, t.occurs_on::text, t.due_at,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'occursOn', ch.occurs_on::text, 'skip', ch.skip, 'dueAt', ch.due_at, 'dueHasTime', ch.due_has_time,
        'durationMinutes', ch.duration_minutes, 'title', ch.title
      ) order by ch.occurs_on)
      from crm.task_occurrence_changes ch
      where ch.series_id = s.id and (t.occurs_on is null or ch.occurs_on > t.occurs_on)
    ), '[]'::jsonb),
    c.user_id, c.master_id, c.create_key, c.create_user_id, c.create_sent_at, c.written, c.dates, c.version, c.attempts, c.claimed_at::text
  from crm.task_series_outlook c
  join crm.task_series s on s.id = c.series_id
  left join crm.tasks t on t.id = s.current_task_id
  where c.series_id = any(v_claimed);
end;
$$;

revoke all on function private.claim_series_outlook(uuid[], uuid, integer) from public;
grant execute on function private.claim_series_outlook(uuid[], uuid, integer) to crm_app;

drop function if exists private.settle_series_outlook(uuid, bigint, boolean, boolean);
create or replace function private.settle_series_outlook(p_series uuid, p_version bigint, p_requeue boolean, p_waiting boolean, p_lease text)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_series_outlook
  set settled_version = case when p_requeue then settled_version else greatest(settled_version, p_version) end,
      claimed_at = null,
      retry_at = null,
      attempts = 0,
      waiting = p_waiting and not p_requeue
  where series_id = p_series
    and (p_lease is null or claimed_at = p_lease::timestamptz);
$$;

revoke all on function private.settle_series_outlook(uuid, bigint, boolean, boolean, text) from public;
grant execute on function private.settle_series_outlook(uuid, bigint, boolean, boolean, text) to crm_app;

drop function if exists private.defer_series_outlook(uuid, timestamptz);
create or replace function private.defer_series_outlook(p_series uuid, p_until timestamptz, p_version bigint, p_lease text)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_series_outlook
  set claimed_at = null,
      retry_at = case when version > p_version then null else p_until end,
      attempts = case when version > p_version then 0 else attempts + 1 end
  where series_id = p_series
    and (p_lease is null or claimed_at = p_lease::timestamptz);
$$;

revoke all on function private.defer_series_outlook(uuid, timestamptz, bigint, text) from public;
grant execute on function private.defer_series_outlook(uuid, timestamptz, bigint, text) to crm_app;

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
  moved := moved || jsonb_build_object('task_series', private.merge_move('task_series', 'company_id', p_workspace, p_merge, p_keep));

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
  moved := moved || jsonb_build_object('task_series', private.merge_move('task_series', 'contact_id', p_workspace, p_merge, p_keep));
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

create or replace function private.series_outlook_touch(p_series uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into crm.task_series_outlook as o (series_id)
  select s.id from crm.task_series s
  where s.id = p_series
    and (
      s.at is not null
      or exists (select 1 from crm.task_series_outlook x where x.series_id = s.id)
      or exists (select 1 from crm.task_occurrence_changes c where c.series_id = s.id and c.due_has_time)
    )
  on conflict (series_id) do update set version = o.version + 1, retry_at = null, attempts = 0, waiting = false, updated_at = now();
$$;

revoke all on function private.series_outlook_touch(uuid) from public;

create or replace function private.wake_series_outlook(p_user_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  with picked as (
    select o.series_id
    from crm.task_series_outlook o
    join crm.task_series s on s.id = o.series_id
    where o.waiting
      and (s.owner_id = p_user_id or o.user_id = p_user_id or o.create_user_id = p_user_id)
    for update of o skip locked
  ), woken as (
    update crm.task_series_outlook o
    set version = o.version + 1, waiting = false, updated_at = now()
    from picked
    where o.series_id = picked.series_id
    returning 1
  )
  select count(*)::integer from woken;
$$;

revoke all on function private.wake_series_outlook(uuid) from public;
grant execute on function private.wake_series_outlook(uuid) to crm_app;

create or replace function private.series_due_to_roll(p_now timestamptz, p_limit integer)
returns table (
  series_id uuid,
  task_id uuid,
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select due.series_id, due.task_id, due.workspace_id, due.workspace_name, due.user_id, due.role, due.email, due.full_name from (
  select s.id, t.id, w.id, w.name, m.user_id, m.role, p.email, p.full_name, s.roll_pending as pending, s.roll_at as due
  from crm.task_series s
  join crm.tasks t on t.id = s.current_task_id
  join crm.workspaces w on w.id = s.workspace_id
  left join lateral (
    select c.created_by_user_id, c.owner_id
    from crm.task_series c
    where c.split_from_id = s.id and c.workspace_id = s.workspace_id
      and c.current_task_id is null and c.ended_at is null and c.archived_at is null
    order by c.starts_on
    limit 1
  ) part on true
  join lateral (
    select candidate.user_id, candidate.role
    from (
      values
        (1, case when part.created_by_user_id in (s.owner_id, s.created_by_user_id) then part.created_by_user_id end),
        (2, case when part.owner_id in (s.owner_id, s.created_by_user_id) then part.owner_id end),
        (3, s.created_by_user_id),
        (4, s.owner_id),
        (5, t.owner_id),
        (6, t.created_by_user_id),
        (7, (select o.user_id from crm.workspace_members o where o.workspace_id = s.workspace_id and o.role = 'owner' order by o.created_at limit 1))
    ) as wanted (rank, user_id)
    join crm.workspace_members candidate on candidate.workspace_id = s.workspace_id and candidate.user_id = wanted.user_id
    order by wanted.rank
    limit 1
  ) m on true
  left join crm.profiles p on p.id = m.user_id
  where (
      s.roll_pending
      or (s.roll_at is not null and s.roll_at <= p_now)
      or (t.completed_at is not null and (s.roll_at is null or s.roll_at <= p_now))
    )
    and (s.roll_retry_at is null or s.roll_retry_at <= p_now)
    and s.ended_at is null
    and s.archived_at is null
    and t.archived_at is null
    and t.series_id = s.id
  union all
  select c.id, null::uuid, w.id, w.name, m.user_id, m.role, p.email, p.full_name, true, null::timestamptz
  from crm.task_series c
  join crm.task_series parent on parent.id = c.split_from_id
  join crm.workspaces w on w.id = c.workspace_id
  join lateral (
    select candidate.user_id, candidate.role
    from (values (1, c.owner_id), (2, c.created_by_user_id)) as wanted (rank, user_id)
    join crm.workspace_members candidate on candidate.workspace_id = c.workspace_id and candidate.user_id = wanted.user_id
    order by wanted.rank
    limit 1
  ) m on true
  left join crm.profiles p on p.id = m.user_id
  where c.current_task_id is null
    and c.ended_at is null
    and c.archived_at is null
    and (c.roll_retry_at is null or c.roll_retry_at <= p_now)
    and (parent.ended_at is not null or parent.archived_at is not null)
  ) due (series_id, task_id, workspace_id, workspace_name, user_id, role, email, full_name, pending, due_at)
  order by due.pending desc, due.due_at
  limit greatest(1, least(coalesce(p_limit, 50), 200))
$$;

revoke all on function private.series_due_to_roll(timestamptz, integer) from public;
grant execute on function private.series_due_to_roll(timestamptz, integer) to crm_app;

reset lock_timeout;

create index concurrently if not exists task_series_created_by_user_idx on crm.task_series (created_by_user_id) where created_by_user_id is not null;

create index concurrently if not exists task_series_created_by_agent_idx on crm.task_series (created_by_agent_id) where created_by_agent_id is not null;

set lock_timeout = '5s';

insert into crm.task_participants (task_id, user_id, added_by)
select s.current_task_id, s.owner_id, null
from crm.task_series s
join crm.tasks t on t.id = s.current_task_id and t.series_id = s.id
join crm.workspace_members m on m.workspace_id = s.workspace_id and m.user_id = s.owner_id
where s.ended_at is null
  and s.archived_at is null
  and t.completed_at is null
  and t.archived_at is null
  and t.owner_id is distinct from s.owner_id
  and t.created_by_user_id is distinct from s.owner_id
on conflict (task_id, user_id) do nothing;

reset lock_timeout;
