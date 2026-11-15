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

create table if not exists crm.task_series_outlook (
  series_id uuid primary key references crm.task_series (id) on delete cascade,
  user_id uuid references crm.profiles (id) on delete set null,
  master_id text,
  create_key uuid,
  create_user_id uuid references crm.profiles (id) on delete set null,
  create_sent_at timestamptz,
  written jsonb,
  dates jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  settled_version bigint not null default 0,
  claimed_at timestamptz,
  retry_at timestamptz,
  attempts integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table crm.task_series_outlook enable row level security;
alter table crm.task_series_outlook force row level security;
revoke all on crm.task_series_outlook from public, anon, authenticated, crm_agent;

do $$
begin
  execute 'drop policy if exists task_series_outlook_definer on crm.task_series_outlook';
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    execute format('create policy task_series_outlook_definer on crm.task_series_outlook for all to %I using (true) with check (true)', current_user);
  end if;
end;
$$;

create or replace function private.series_outlook_touch(p_series uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into crm.task_series_outlook as o (series_id)
  select s.id from crm.task_series s
  where s.id = p_series
    and (s.at is not null or exists (select 1 from crm.task_series_outlook x where x.series_id = s.id))
  on conflict (series_id) do update set version = o.version + 1, retry_at = null, updated_at = now();
$$;

create or replace function private.task_series_outlook_enqueue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'task_series' then
    perform private.series_outlook_touch(new.id);
  elsif tg_table_name = 'task_occurrence_changes' then
    perform private.series_outlook_touch(case when tg_op = 'DELETE' then old.series_id else new.series_id end);
  elsif tg_table_name = 'tasks' then
    perform private.series_outlook_touch(new.series_id);
    if old.series_id is distinct from new.series_id and old.series_id is not null then
      perform private.series_outlook_touch(old.series_id);
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists task_series_outlook_enqueue on crm.task_series;
create trigger task_series_outlook_enqueue
  after insert or update of workspace_id, owner_id, title, starts_on, at, duration_minutes, rule, ends, current_task_id, ended_at, archived_at
  on crm.task_series
  for each row execute function private.task_series_outlook_enqueue();

drop trigger if exists task_occurrence_changes_outlook_enqueue on crm.task_occurrence_changes;
create trigger task_occurrence_changes_outlook_enqueue
  after insert or update or delete on crm.task_occurrence_changes
  for each row execute function private.task_series_outlook_enqueue();

drop trigger if exists tasks_series_outlook_enqueue on crm.tasks;
create trigger tasks_series_outlook_enqueue
  after update of due_at, occurs_on, series_id on crm.tasks
  for each row
  when (new.series_id is not null or old.series_id is not null)
  execute function private.task_series_outlook_enqueue();

create or replace function private.claim_series_outlook(p_task_ids uuid[], p_user_id uuid, p_limit integer)
returns table (
  series_id uuid,
  workspace_id uuid,
  owner_id uuid,
  owner_member boolean,
  title text,
  starts_on date,
  at text,
  duration_minutes integer,
  rule jsonb,
  ends jsonb,
  ended boolean,
  current_task_id uuid,
  current_occurs_on date,
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
  attempts integer
)
language sql
security definer
set search_path = ''
as $$
  with picked as (
    select o.series_id
    from crm.task_series_outlook o
    join crm.task_series s on s.id = o.series_id
    where o.version > o.settled_version
      and (o.claimed_at is null or o.claimed_at < clock_timestamp() - interval '2 minutes')
      and (o.retry_at is null or o.retry_at <= clock_timestamp())
      and (p_task_ids is null or s.current_task_id = any(p_task_ids))
      and (p_user_id is null or s.owner_id = p_user_id or o.user_id = p_user_id)
    order by o.updated_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of o skip locked
  ), claimed as (
    update crm.task_series_outlook o
    set claimed_at = clock_timestamp()
    from picked
    where o.series_id = picked.series_id
    returning o.*
  )
  select s.id, s.workspace_id, s.owner_id,
    exists (select 1 from crm.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = s.owner_id),
    s.title, s.starts_on, to_char(s.at, 'HH24:MI'), s.duration_minutes, s.rule, s.ends,
    (s.ended_at is not null or s.archived_at is not null),
    s.current_task_id, t.occurs_on, t.due_at,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'occursOn', ch.occurs_on::text, 'skip', ch.skip, 'dueAt', ch.due_at, 'dueHasTime', ch.due_has_time,
        'durationMinutes', ch.duration_minutes, 'title', ch.title
      ) order by ch.occurs_on)
      from crm.task_occurrence_changes ch
      where ch.series_id = s.id and (t.occurs_on is null or ch.occurs_on > t.occurs_on)
    ), '[]'::jsonb),
    c.user_id, c.master_id, c.create_key, c.create_user_id, c.create_sent_at, c.written, c.dates, c.version, c.attempts
  from claimed c
  join crm.task_series s on s.id = c.series_id
  left join crm.tasks t on t.id = s.current_task_id
$$;

create or replace function private.begin_series_outlook_create(p_series uuid, p_user_id uuid)
returns uuid
language sql
security definer
set search_path = ''
as $$
  update crm.task_series_outlook
  set create_key = case when create_key is not null and create_user_id = p_user_id then create_key else gen_random_uuid() end,
      create_user_id = p_user_id,
      create_sent_at = clock_timestamp()
  where series_id = p_series
  returning create_key;
$$;

create or replace function private.save_series_outlook(p_series uuid, p_user_id uuid, p_master_id text, p_written jsonb, p_dates jsonb, p_clear_key boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_series_outlook
  set user_id = p_user_id,
      master_id = p_master_id,
      written = p_written,
      dates = coalesce(p_dates, '{}'::jsonb),
      create_key = case when p_clear_key then null else create_key end,
      create_user_id = case when p_clear_key then null else create_user_id end,
      create_sent_at = case when p_clear_key then null else create_sent_at end,
      updated_at = now()
  where series_id = p_series;
$$;

create or replace function private.settle_series_outlook(p_series uuid, p_version bigint, p_requeue boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_series_outlook
  set settled_version = case when p_requeue then settled_version else greatest(settled_version, p_version) end,
      claimed_at = null,
      retry_at = null,
      attempts = 0
  where series_id = p_series;
$$;

create or replace function private.defer_series_outlook(p_series uuid, p_until timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_series_outlook
  set claimed_at = null, retry_at = p_until, attempts = attempts + 1
  where series_id = p_series;
$$;

create or replace function private.series_outlook_events(p_user_id uuid)
returns table (event_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.master_id from crm.task_series_outlook o where o.user_id = p_user_id and o.master_id is not null
  union
  select d.value ->> 'single'
  from crm.task_series_outlook o, jsonb_each(o.dates) d
  where o.user_id = p_user_id and d.value ->> 'single' is not null;
$$;

create or replace function private.queue_series_outlook(p_user_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  with touched as (
    insert into crm.task_series_outlook as o (series_id)
    select s.id from crm.task_series s
    where s.owner_id = p_user_id and s.at is not null and s.ended_at is null and s.archived_at is null
    on conflict (series_id) do update set version = o.version + 1, retry_at = null, updated_at = now()
    returning 1
  )
  select count(*)::integer from touched;
$$;

revoke all on function private.queue_series_outlook(uuid) from public;
grant execute on function private.queue_series_outlook(uuid) to crm_app;
revoke all on function private.series_outlook_touch(uuid) from public;
revoke all on function private.claim_series_outlook(uuid[], uuid, integer) from public;
revoke all on function private.begin_series_outlook_create(uuid, uuid) from public;
revoke all on function private.save_series_outlook(uuid, uuid, text, jsonb, jsonb, boolean) from public;
revoke all on function private.settle_series_outlook(uuid, bigint, boolean) from public;
revoke all on function private.defer_series_outlook(uuid, timestamptz) from public;
revoke all on function private.series_outlook_events(uuid) from public;
grant execute on function private.claim_series_outlook(uuid[], uuid, integer) to crm_app;
grant execute on function private.begin_series_outlook_create(uuid, uuid) to crm_app;
grant execute on function private.save_series_outlook(uuid, uuid, text, jsonb, jsonb, boolean) to crm_app;
grant execute on function private.settle_series_outlook(uuid, bigint, boolean) to crm_app;
grant execute on function private.defer_series_outlook(uuid, timestamptz) to crm_app;
grant execute on function private.series_outlook_events(uuid) to crm_app;

insert into crm.task_series_outlook (series_id)
select s.id from crm.task_series s
where s.at is not null and s.ended_at is null and s.archived_at is null
on conflict (series_id) do nothing;

reset lock_timeout;
