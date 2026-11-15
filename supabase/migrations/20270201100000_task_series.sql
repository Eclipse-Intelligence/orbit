set lock_timeout = '5s';

create table if not exists crm.task_series (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  owner_id uuid references crm.profiles (id) on delete set null,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_by_agent_id uuid references crm.agents (id) on delete set null,
  title text not null,
  description text,
  priority text not null default 'normal',
  company_id uuid references crm.companies (id) on delete set null,
  contact_id uuid references crm.contacts (id) on delete set null,
  opportunity_id uuid references crm.opportunities (id) on delete set null,
  starts_on date not null,
  at time,
  duration_minutes integer not null default 15,
  remind_minutes integer,
  rule jsonb not null,
  ends jsonb not null default '{"never": true}'::jsonb,
  current_task_id uuid references crm.tasks (id) on delete set null,
  roll_at timestamptz,
  roll_pending boolean not null default false,
  roll_retry_at timestamptz,
  split_from_id uuid references crm.task_series (id) on delete set null,
  ended_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_series_title_length check (char_length(title) between 1 and 200),
  constraint task_series_priority check (priority in ('low', 'normal', 'high')),
  constraint task_series_duration check (duration_minutes between 5 and 480),
  constraint task_series_reminder check (remind_minutes is null or (at is not null and remind_minutes between 0 and 10080)),
  constraint task_series_actor_exclusive check (num_nonnulls(created_by_user_id, created_by_agent_id) <= 1),
  constraint task_series_ends_shape check (
    jsonb_typeof(ends) = 'object'
    and (
      ends = '{"never": true}'::jsonb
      or case when jsonb_typeof(ends -> 'count') = 'number' then (ends ->> 'count')::numeric between 1 and 999 else false end
      or (jsonb_typeof(ends -> 'until') = 'string' and (ends ->> 'until') ~ '^\d{4}-\d{2}-\d{2}$')
    )
  )
);

create index if not exists task_series_workspace_owner_idx on crm.task_series (workspace_id, owner_id) where archived_at is null;
create index if not exists task_series_roll_idx on crm.task_series (roll_at) where roll_at is not null and ended_at is null and archived_at is null;
create index if not exists task_series_roll_pending_idx on crm.task_series (id) where roll_pending and ended_at is null and archived_at is null;
create index if not exists task_series_current_idx on crm.task_series (current_task_id);
create index if not exists task_series_split_idx on crm.task_series (split_from_id) where split_from_id is not null;
create index if not exists task_series_company_idx on crm.task_series (company_id) where company_id is not null;
create index if not exists task_series_contact_idx on crm.task_series (contact_id) where contact_id is not null;
create index if not exists task_series_opportunity_idx on crm.task_series (opportunity_id) where opportunity_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'task_series_rule_shape' and conrelid = 'crm.task_series'::regclass
      and pg_get_constraintdef(oid) like '%monthWeek%weekday%'
  ) then
    alter table crm.task_series drop constraint if exists task_series_rule_shape;
    alter table crm.task_series add constraint task_series_rule_shape check (
        jsonb_typeof(rule) = 'object'
        and rule ->> 'freq' in ('daily', 'weekly', 'monthly', 'yearly')
        and (rule - 'freq' - 'interval' - 'weekdays' - 'monthDay' - 'monthWeek') = '{}'::jsonb
        and case when jsonb_typeof(rule -> 'interval') = 'number' then (rule ->> 'interval') ~ '^[1-9][0-9]?$' else false end
        and case
          when rule ->> 'freq' = 'weekly' then
            jsonb_typeof(rule -> 'weekdays') = 'array'
            and jsonb_array_length(rule -> 'weekdays') between 1 and 7
            and (rule -> 'weekdays') <@ '["mo", "tu", "we", "th", "fr", "sa", "su"]'::jsonb
            and not (rule ? 'monthDay') and not (rule ? 'monthWeek')
          when rule ->> 'freq' = 'monthly' then
            not (rule ? 'weekdays')
            and not (rule ? 'monthDay' and rule ? 'monthWeek')
            and (not (rule ? 'monthDay') or (jsonb_typeof(rule -> 'monthDay') = 'number' and (rule ->> 'monthDay') in ('1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30','31')))
            and (not (rule ? 'monthWeek') or (
              jsonb_typeof(rule -> 'monthWeek') = 'object'
              and (rule -> 'monthWeek' ->> 'n') in ('1', '2', '3', '4', '-1')
              and (rule -> 'monthWeek' ->> 'weekday') in ('mo', 'tu', 'we', 'th', 'fr', 'sa', 'su')
            ))
          else not (rule ? 'weekdays') and not (rule ? 'monthDay') and not (rule ? 'monthWeek')
        end
      );
  end if;
end
$$;

alter table crm.task_series add column if not exists roll_retry_at timestamptz;

alter table crm.task_series enable row level security;
alter table crm.task_series force row level security;

alter table crm.tasks add column if not exists series_id uuid references crm.task_series (id) on delete set null;
alter table crm.tasks add column if not exists occurs_on date;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_occurrence_day' and conrelid = 'crm.tasks'::regclass
  ) then
    alter table crm.tasks
      add constraint tasks_occurrence_day check (series_id is null or occurs_on is not null) not valid;
  end if;
end
$$;

alter table crm.tasks validate constraint tasks_occurrence_day;

create table if not exists crm.task_occurrence_changes (
  series_id uuid not null references crm.task_series (id) on delete cascade,
  occurs_on date not null,
  skip boolean not null default false,
  due_at timestamptz,
  due_has_time boolean,
  duration_minutes integer,
  title text,
  description text,
  created_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (series_id, occurs_on),
  constraint task_occurrence_changes_duration check (duration_minutes is null or duration_minutes between 5 and 480),
  constraint task_occurrence_changes_title check (title is null or char_length(title) between 1 and 200),
  constraint task_occurrence_changes_due check ((due_at is null) = (due_has_time is null))
);

alter table crm.task_occurrence_changes enable row level security;
alter table crm.task_occurrence_changes force row level security;

drop trigger if exists task_series_set_updated_at on crm.task_series;
create trigger task_series_set_updated_at
  before update on crm.task_series
  for each row execute function private.set_updated_at();

drop trigger if exists task_series_same_workspace on crm.task_series;
create trigger task_series_same_workspace
  before insert or update on crm.task_series
  for each row execute function private.assert_same_workspace();

create or replace function private.task_series_keep_creator()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'crm_agent') then
    raise exception 'A repeating task''s creator and workspace can''t be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.task_series_keep_creator() from public;

drop trigger if exists task_series_keep_creator on crm.task_series;
create trigger task_series_keep_creator
  before update of created_by_user_id, created_by_agent_id, workspace_id on crm.task_series
  for each row
  when (
    old.created_by_user_id is distinct from new.created_by_user_id
    or old.created_by_agent_id is distinct from new.created_by_agent_id
    or old.workspace_id is distinct from new.workspace_id
  )
  execute function private.task_series_keep_creator();

drop policy if exists task_series_select_member on crm.task_series;
create policy task_series_select_member on crm.task_series
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      owner_id = (select private.session_user_id())
      or created_by_user_id = (select private.session_user_id())
      or exists (select 1 from crm.tasks t where t.id = task_series.current_task_id)
    )
  );

drop policy if exists task_series_insert_member on crm.task_series;
create policy task_series_insert_member on crm.task_series
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and created_by_user_id = (select private.session_user_id())
    and created_by_agent_id is null
  );

drop policy if exists task_series_update_member on crm.task_series;
create policy task_series_update_member on crm.task_series
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      owner_id = (select private.session_user_id())
      or created_by_user_id = (select private.session_user_id())
      or exists (
        select 1 from crm.tasks t
        where t.id = task_series.current_task_id
          and (t.owner_id = (select private.session_user_id()) or t.created_by_user_id = (select private.session_user_id()))
      )
    )
  )
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists task_series_select_agent on crm.task_series;
create policy task_series_select_agent on crm.task_series
  for select to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and (
      created_by_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
      or exists (select 1 from crm.tasks t where t.id = task_series.current_task_id)
    )
  );

drop policy if exists task_series_insert_agent on crm.task_series;
create policy task_series_insert_agent on crm.task_series
  for insert to crm_agent
  with check (
    workspace_id = (select private.request_workspace_id())
    and created_by_user_id is null
    and created_by_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
  );

drop policy if exists task_series_update_agent on crm.task_series;
create policy task_series_update_agent on crm.task_series
  for update to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and (
      created_by_agent_id = (select nullif(current_setting('app.agent_id', true), '')::uuid)
      or exists (select 1 from crm.tasks t where t.id = task_series.current_task_id)
    )
  )
  with check (workspace_id = (select private.request_workspace_id()));

drop policy if exists task_occurrence_changes_select on crm.task_occurrence_changes;
create policy task_occurrence_changes_select on crm.task_occurrence_changes
  for select to authenticated, crm_agent
  using (exists (select 1 from crm.task_series s where s.id = task_occurrence_changes.series_id));

drop policy if exists task_occurrence_changes_write_member on crm.task_occurrence_changes;
create policy task_occurrence_changes_write_member on crm.task_occurrence_changes
  for all to authenticated
  using (
    exists (
      select 1 from crm.task_series s
      where s.id = task_occurrence_changes.series_id
        and (s.owner_id = (select private.session_user_id()) or s.created_by_user_id = (select private.session_user_id()))
    )
  )
  with check (
    exists (
      select 1 from crm.task_series s
      where s.id = task_occurrence_changes.series_id
        and (s.owner_id = (select private.session_user_id()) or s.created_by_user_id = (select private.session_user_id()))
    )
  );

drop policy if exists task_occurrence_changes_write_agent on crm.task_occurrence_changes;
create policy task_occurrence_changes_write_agent on crm.task_occurrence_changes
  for all to crm_agent
  using (exists (
    select 1 from crm.task_series s
    where s.id = task_occurrence_changes.series_id and s.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
  ))
  with check (exists (
    select 1 from crm.task_series s
    where s.id = task_occurrence_changes.series_id and s.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
  ));

create or replace function private.series_occurrence_allowed(p_series uuid, p_workspace uuid, p_user uuid, p_agent uuid)
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
            )
          )
        )
      )
  )
$$;

revoke all on function private.series_occurrence_allowed(uuid, uuid, uuid, uuid) from public;
grant execute on function private.series_occurrence_allowed(uuid, uuid, uuid, uuid) to authenticated, crm_agent;

drop policy if exists tasks_insert_series_member on crm.tasks;
create policy tasks_insert_series_member on crm.tasks
  for insert to authenticated
  with check (
    series_id is not null
    and workspace_id in (select private.user_workspace_ids())
    and private.series_occurrence_allowed(series_id, workspace_id, created_by_user_id, created_by_agent_id)
  );

drop policy if exists tasks_insert_series_agent on crm.tasks;
create policy tasks_insert_series_agent on crm.tasks
  for insert to crm_agent
  with check (
    series_id is not null
    and workspace_id = (select private.request_workspace_id())
    and private.series_occurrence_allowed(series_id, workspace_id, created_by_user_id, created_by_agent_id)
  );

revoke all on crm.task_series, crm.task_occurrence_changes from anon, authenticated, crm_agent;
grant select, insert, update on crm.task_series to authenticated, crm_agent;
grant select, insert, update, delete on crm.task_occurrence_changes to authenticated, crm_agent;

create or replace function private.task_series_take_occurrence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into crm.task_participants (task_id, user_id, added_by)
  select new.id, p.user_id, p.added_by
  from crm.task_series s
  join crm.task_participants p on p.task_id = s.current_task_id
  join crm.workspace_members m on m.workspace_id = new.workspace_id and m.user_id = p.user_id
  where s.id = new.series_id
    and s.current_task_id is distinct from new.id
    and p.user_id is distinct from new.owner_id
  on conflict (task_id, user_id) do nothing;
  insert into crm.task_docs (task_id, page_id, workspace_id, created_by, created_by_agent_id, page_archived)
  select new.id, d.page_id, new.workspace_id, d.created_by, d.created_by_agent_id, d.page_archived
  from crm.task_series s
  join crm.task_docs d on d.task_id = s.current_task_id
  where s.id = new.series_id
    and s.current_task_id is distinct from new.id
    and d.workspace_id = new.workspace_id
  on conflict (task_id, page_id) do nothing;
  update crm.task_series
  set current_task_id = new.id, roll_pending = (roll_pending or roll_at is null or roll_at <= now())
  where id = new.series_id and current_task_id is distinct from new.id;
  return null;
end;
$$;

revoke all on function private.task_series_take_occurrence() from public;

drop trigger if exists tasks_series_take_occurrence on crm.tasks;
create trigger tasks_series_take_occurrence
  after insert on crm.tasks
  for each row
  when (new.series_id is not null and new.completed_at is null and new.archived_at is null)
  execute function private.task_series_take_occurrence();

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
  select s.id, t.id, w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.task_series s
  join crm.tasks t on t.id = s.current_task_id
  join crm.workspaces w on w.id = s.workspace_id
  join lateral (
    select candidate.user_id, candidate.role
    from (
      values
        (1, s.created_by_user_id),
        (2, s.owner_id),
        (3, t.owner_id),
        (4, t.created_by_user_id),
        (5, (select o.user_id from crm.workspace_members o where o.workspace_id = s.workspace_id and o.role = 'owner' order by o.created_at limit 1))
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
  order by s.roll_pending desc, s.roll_at
  limit greatest(1, least(coalesce(p_limit, 50), 200))
$$;

revoke all on function private.series_due_to_roll(timestamptz, integer) from public;
grant execute on function private.series_due_to_roll(timestamptz, integer) to crm_app;

create or replace function private.task_series_follow_move(p_source uuid, p_target uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_moved integer := 0;
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
        remind_minutes = case when t.due_has_time then s.remind_minutes else null end
    from crm.tasks t
    where s.workspace_id = p_source
      and t.id = s.current_task_id
      and t.series_id = s.id
      and t.workspace_id = p_target
    returning s.id
  )
  select count(*) into v_moved from followed;

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
  where s.workspace_id = p_source
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

drop function if exists private.delay_series_roll(uuid, timestamptz);

create or replace function private.delay_series_roll(p_series uuid, p_until timestamptz, p_now timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_series s set roll_retry_at = p_until
  where s.id = p_series and s.ended_at is null and s.archived_at is null
    and (
      s.roll_pending
      or s.roll_at <= p_now
      or (s.roll_at is null and exists (select 1 from crm.tasks t where t.id = s.current_task_id and t.completed_at is not null))
    );
$$;

revoke all on function private.delay_series_roll(uuid, timestamptz, timestamptz) from public;
grant execute on function private.delay_series_roll(uuid, timestamptz, timestamptz) to crm_app;

create or replace function private.tasks_bind_series()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_series crm.task_series%rowtype;
begin
  if current_user not in ('authenticated', 'crm_agent') then
    return new;
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

drop trigger if exists tasks_bind_series on crm.tasks;
create trigger tasks_bind_series
  before insert or update of series_id, workspace_id on crm.tasks
  for each row
  execute function private.tasks_bind_series();

create or replace function private.tasks_keep_completion()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid;
  v_agent uuid := nullif(current_setting('app.agent_id', true), '')::uuid;
begin
  if current_user = 'authenticated' and v_user is not null and (old.owner_id is not distinct from v_user or old.created_by_user_id is not distinct from v_user) then
    return new;
  end if;
  if current_user = 'crm_agent' and v_agent is not null and old.created_by_agent_id is not distinct from v_agent then
    return new;
  end if;
  if current_user in ('authenticated', 'crm_agent') then
    raise exception 'Only the assignee or the task''s creator can complete or reopen it.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.tasks_keep_completion() from public;

drop trigger if exists tasks_keep_completion on crm.tasks;
create trigger tasks_keep_completion
  before update of completed_at on crm.tasks
  for each row
  when (old.completed_at is distinct from new.completed_at)
  execute function private.tasks_keep_completion();

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
      or (old.roll_pending and not new.roll_pending)
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

drop trigger if exists task_series_bind_current on crm.task_series;
create trigger task_series_bind_current
  before insert or update on crm.task_series
  for each row
  execute function private.task_series_bind_current();

create or replace function private.tasks_leave_series()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update crm.task_series
  set current_task_id = null, roll_at = null, roll_pending = false, ended_at = coalesce(ended_at, now())
  where id = old.series_id and current_task_id = new.id;
  return null;
end;
$$;

revoke all on function private.tasks_leave_series() from public;

drop trigger if exists tasks_leave_series on crm.tasks;
create trigger tasks_leave_series
  after update of series_id on crm.tasks
  for each row
  when (old.series_id is not null and old.series_id is distinct from new.series_id)
  execute function private.tasks_leave_series();

drop policy if exists tasks_select_series_owner on crm.tasks;
drop policy if exists tasks_update_series_owner on crm.tasks;
drop function if exists private.owns_series(uuid);

drop function if exists private.series_write_occurrence(uuid, uuid, uuid, jsonb);
drop function if exists private.series_lock_occurrence(uuid, uuid, uuid);
drop function if exists private.series_check_occurrence(uuid, uuid, uuid);

create or replace function private.session_owns_series(p_series uuid, p_workspace uuid)
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
      and (s.owner_id = (select private.session_user_id()) or s.created_by_user_id = (select private.session_user_id()))
  )
$$;

revoke all on function private.session_owns_series(uuid, uuid) from public;
grant execute on function private.session_owns_series(uuid, uuid) to authenticated;

create or replace function private.agent_owns_series(p_series uuid, p_workspace uuid)
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
      and s.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
  )
$$;

revoke all on function private.agent_owns_series(uuid, uuid) from public;
grant execute on function private.agent_owns_series(uuid, uuid) to crm_agent;

drop policy if exists tasks_update_series_member on crm.tasks;
create policy tasks_update_series_member on crm.tasks
  for update to authenticated
  using (
    series_id is not null
    and completed_at is null
    and workspace_id in (select private.user_workspace_ids())
    and private.session_owns_series(series_id, workspace_id)
  )
  with check (
    series_id is not null
    and completed_at is null
    and workspace_id in (select private.user_workspace_ids())
    and private.session_owns_series(series_id, workspace_id)
  );

drop policy if exists tasks_update_series_agent on crm.tasks;
create policy tasks_update_series_agent on crm.tasks
  for update to crm_agent
  using (
    series_id is not null
    and completed_at is null
    and workspace_id = (select private.request_workspace_id())
    and private.agent_owns_series(series_id, workspace_id)
  )
  with check (
    series_id is not null
    and completed_at is null
    and workspace_id = (select private.request_workspace_id())
    and private.agent_owns_series(series_id, workspace_id)
  );

drop policy if exists tasks_series_binding on crm.tasks;
create policy tasks_series_binding on crm.tasks
  as restrictive
  for insert to authenticated, crm_agent
  with check (series_id is null or private.series_occurrence_allowed(series_id, workspace_id, created_by_user_id, created_by_agent_id));

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

  insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, source, source_url, operation, changes)
  select p_workspace, 'task_series.updated', 'task', s.current_task_id, 'user', p_actor, p_source, p_source_url, p_operation,
    jsonb_build_object(
      'series', jsonb_build_object('id', s.id),
      'handedOver', jsonb_build_object('from', p_user, 'to', p_actor, 'owner', s.owner_id = p_user, 'creator', s.created_by_user_id = p_user)
    )
  from crm.task_series s
  where s.workspace_id = p_workspace and (s.owner_id = p_user or s.created_by_user_id = p_user) and s.current_task_id is not null;
  insert into crm.task_participants (task_id, user_id, added_by)
  select s.current_task_id, p_actor, p_actor
  from crm.task_series s
  where s.workspace_id = p_workspace and (s.owner_id = p_user or s.created_by_user_id = p_user) and s.current_task_id is not null
  on conflict do nothing;
  update crm.task_series s set owner_id = p_actor
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

reset lock_timeout;

create unique index concurrently if not exists tasks_series_occurs_idx on crm.tasks (series_id, occurs_on) where series_id is not null and archived_at is null;

create unique index concurrently if not exists tasks_series_open_idx on crm.tasks (series_id) where series_id is not null and completed_at is null and archived_at is null;

create index concurrently if not exists tasks_series_idx on crm.tasks (series_id, occurs_on desc) where series_id is not null;
