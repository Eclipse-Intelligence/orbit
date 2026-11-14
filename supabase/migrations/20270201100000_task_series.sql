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
        and (
          s.owner_id = (select private.session_user_id())
          or s.created_by_user_id = (select private.session_user_id())
          or exists (
            select 1 from crm.tasks t
            where t.id = s.current_task_id
              and (t.owner_id = (select private.session_user_id()) or t.created_by_user_id = (select private.session_user_id()))
          )
        )
    )
  )
  with check (
    exists (
      select 1 from crm.task_series s
      where s.id = task_occurrence_changes.series_id
        and (
          s.owner_id = (select private.session_user_id())
          or s.created_by_user_id = (select private.session_user_id())
          or exists (
            select 1 from crm.tasks t
            where t.id = s.current_task_id
              and (t.owner_id = (select private.session_user_id()) or t.created_by_user_id = (select private.session_user_id()))
          )
        )
    )
  );

drop policy if exists task_occurrence_changes_write_agent on crm.task_occurrence_changes;
create policy task_occurrence_changes_write_agent on crm.task_occurrence_changes
  for all to crm_agent
  using (exists (select 1 from crm.task_series s where s.id = task_occurrence_changes.series_id))
  with check (exists (select 1 from crm.task_series s where s.id = task_occurrence_changes.series_id));

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
          and s.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
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
  set current_task_id = new.id, roll_pending = true
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
        (1, case when t.completed_at is null then t.owner_id else s.owner_id end),
        (2, case when t.completed_at is null then t.created_by_user_id else s.created_by_user_id end),
        (3, s.owner_id),
        (4, s.created_by_user_id),
        (5, t.owner_id),
        (6, (select o.user_id from crm.workspace_members o where o.workspace_id = s.workspace_id and o.role = 'owner' order by o.created_at limit 1))
    ) as wanted (rank, user_id)
    join crm.workspace_members candidate on candidate.workspace_id = s.workspace_id and candidate.user_id = wanted.user_id
    order by wanted.rank
    limit 1
  ) m on true
  left join crm.profiles p on p.id = m.user_id
  where (s.roll_pending or (s.roll_at is not null and s.roll_at <= p_now) or t.completed_at is not null)
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
        owner_id = t.owner_id,
        company_id = t.company_id,
        contact_id = t.contact_id,
        opportunity_id = t.opportunity_id,
        at = case when t.due_has_time then s.at else null end,
        remind_minutes = case when t.due_has_time then s.remind_minutes else null end
    from crm.tasks t
    where s.workspace_id = p_source
      and t.id = s.current_task_id
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

  update crm.task_series s
  set current_task_id = null, ended_at = coalesce(s.ended_at, now()), roll_at = null
  where s.workspace_id = p_source
    and s.current_task_id is not null
    and not exists (select 1 from crm.tasks t where t.id = s.current_task_id and t.series_id = s.id);

  return v_moved;
end;
$$;

revoke all on function private.task_series_follow_move(uuid, uuid) from public;
grant execute on function private.task_series_follow_move(uuid, uuid) to crm_app;

create or replace function private.delay_series_roll(p_series uuid, p_until timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_series set roll_at = greatest(coalesce(roll_at, p_until), p_until), roll_pending = false
  where id = p_series and ended_at is null and archived_at is null;
$$;

revoke all on function private.delay_series_roll(uuid, timestamptz) from public;
grant execute on function private.delay_series_roll(uuid, timestamptz) to crm_app;

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
  if not found or v_series.workspace_id <> new.workspace_id or v_series.archived_at is not null then
    raise exception 'That repeating task isn''t in this workspace.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
    v_series.current_task_id is not null and v_series.current_task_id <> new.id
    or not (
      v_series.owner_id = (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid
      or v_series.created_by_user_id = (nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid
      or (v_series.created_by_agent_id is not null and v_series.created_by_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid)
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

create or replace function private.task_series_bind_current()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.current_task_id is not null
    and (tg_op = 'INSERT' or old.current_task_id is distinct from new.current_task_id or old.workspace_id is distinct from new.workspace_id)
    and not exists (
      select 1 from crm.tasks t
      where t.id = new.current_task_id and t.series_id = new.id and t.workspace_id = new.workspace_id
    ) then
    raise exception 'A repeating task''s open task must belong to it.' using errcode = '23514';
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
  before insert or update of current_task_id, workspace_id, owner_id on crm.task_series
  for each row
  execute function private.task_series_bind_current();

drop policy if exists tasks_series_binding on crm.tasks;
create policy tasks_series_binding on crm.tasks
  as restrictive
  for insert to authenticated, crm_agent
  with check (series_id is null or private.series_occurrence_allowed(series_id, workspace_id, created_by_user_id, created_by_agent_id));

reset lock_timeout;

create unique index concurrently if not exists tasks_series_occurs_idx on crm.tasks (series_id, occurs_on) where series_id is not null and archived_at is null;

create unique index concurrently if not exists tasks_series_open_idx on crm.tasks (series_id) where series_id is not null and completed_at is null and archived_at is null;

create index concurrently if not exists tasks_series_idx on crm.tasks (series_id, occurs_on desc) where series_id is not null;
