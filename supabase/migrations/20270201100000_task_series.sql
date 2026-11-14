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
  constraint task_series_rule_shape check (
    jsonb_typeof(rule) = 'object'
    and rule ->> 'freq' in ('daily', 'weekly', 'monthly', 'yearly')
    and case when jsonb_typeof(rule -> 'interval') = 'number' then (rule ->> 'interval')::numeric between 1 and 99 else false end
    and (rule ->> 'freq' <> 'weekly' or (jsonb_typeof(rule -> 'weekdays') = 'array' and jsonb_array_length(rule -> 'weekdays') between 1 and 7))
  ),
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
        where t.id = task_series.current_task_id and t.owner_id = (select private.session_user_id())
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
          or exists (select 1 from crm.tasks t where t.id = s.current_task_id and t.owner_id = (select private.session_user_id()))
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
          or exists (select 1 from crm.tasks t where t.id = s.current_task_id and t.owner_id = (select private.session_user_id()))
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
            or exists (select 1 from crm.tasks c where c.id = s.current_task_id and c.owner_id = (select private.session_user_id()))
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
      values (1, t.owner_id), (2, t.created_by_user_id), (3, s.owner_id), (4, s.created_by_user_id)
    ) as wanted (rank, user_id)
    join crm.workspace_members candidate on candidate.workspace_id = s.workspace_id and candidate.user_id = wanted.user_id
    order by wanted.rank
    limit 1
  ) m on true
  left join crm.profiles p on p.id = m.user_id
  where (s.roll_pending or (s.roll_at is not null and s.roll_at <= p_now))
    and s.ended_at is null
    and s.archived_at is null
    and t.completed_at is null
    and t.archived_at is null
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

reset lock_timeout;

create unique index concurrently if not exists tasks_series_occurs_idx on crm.tasks (series_id, occurs_on) where series_id is not null and archived_at is null;

create unique index concurrently if not exists tasks_series_open_idx on crm.tasks (series_id) where series_id is not null and completed_at is null and archived_at is null;

create index concurrently if not exists tasks_series_idx on crm.tasks (series_id, occurs_on desc) where series_id is not null;
