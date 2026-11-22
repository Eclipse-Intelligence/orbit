set lock_timeout = '5s';

create table if not exists crm.task_done_offers (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references crm.tasks (id) on delete cascade,
  activity_id uuid not null references crm.activities (id) on delete cascade,
  kind text not null,
  note text,
  next_title text,
  next_due date,
  state text not null default 'offered',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references crm.profiles (id) on delete set null,
  constraint task_done_offers_kind check (kind in ('email', 'call', 'meeting')),
  constraint task_done_offers_state check (state in ('offered', 'closed', 'dismissed')),
  constraint task_done_offers_note_length check (note is null or char_length(note) <= 1000),
  constraint task_done_offers_next_title_length check (next_title is null or char_length(next_title) between 1 and 200),
  constraint task_done_offers_once unique (task_id, activity_id)
);

create unique index if not exists task_done_offers_one_open_idx on crm.task_done_offers (task_id) where state = 'offered';
create index if not exists task_done_offers_activity_idx on crm.task_done_offers (activity_id);
create index if not exists task_done_offers_decided_by_idx on crm.task_done_offers (decided_by) where decided_by is not null;

alter table crm.task_done_offers enable row level security;
alter table crm.task_done_offers force row level security;

drop policy if exists task_done_offers_select on crm.task_done_offers;
create policy task_done_offers_select on crm.task_done_offers
  for select to authenticated, crm_agent
  using (task_id in (select t.id from crm.tasks t));

drop policy if exists task_done_offers_update on crm.task_done_offers;
create policy task_done_offers_update on crm.task_done_offers
  for update to authenticated
  using (
    state = 'offered'
    and exists (
      select 1 from crm.tasks t
      where t.id = task_done_offers.task_id
        and t.workspace_id in (select private.user_workspace_ids())
        and (
          t.owner_id = (select private.session_user_id())
          or t.created_by_user_id = (select private.session_user_id())
        )
    )
  )
  with check (
    state in ('closed', 'dismissed')
    and decided_by = (select private.session_user_id())
  );

revoke all on crm.task_done_offers from anon, authenticated, crm_agent;
grant select on crm.task_done_offers to authenticated, crm_agent;
grant update (state, decided_at, decided_by) on crm.task_done_offers to authenticated;

alter table crm.task_outcomes add column if not exists note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_outcomes_note_length') then
    alter table crm.task_outcomes add constraint task_outcomes_note_length check (note is null or char_length(note) <= 4000);
  end if;
end;
$$;

create table if not exists crm.task_done_queue (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references crm.activities (id) on delete cascade,
  reason text not null,
  queued_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts integer not null default 0,
  claimed_at timestamptz,
  claim_token uuid,
  constraint task_done_queue_reason check (reason in ('created', 'updated', 'summary'))
);

create index if not exists task_done_queue_due_idx on crm.task_done_queue (next_attempt_at, id);
create index if not exists task_done_queue_activity_idx on crm.task_done_queue (activity_id);

alter table crm.task_done_queue enable row level security;
alter table crm.task_done_queue force row level security;

drop policy if exists task_done_queue_insert on crm.task_done_queue;
create policy task_done_queue_insert on crm.task_done_queue
  for insert to authenticated, crm_agent
  with check (activity_id in (select a.id from crm.activities a));

revoke all on crm.task_done_queue from anon, authenticated, crm_agent;
grant insert on crm.task_done_queue to authenticated, crm_agent;

create or replace function private.task_done_activity(p_activity uuid)
returns table (
  workspace_id uuid,
  kind text,
  title text,
  body text,
  summary text,
  occurred_at timestamptz,
  contact_id uuid,
  company_id uuid,
  contact_name text,
  company_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.workspace_id, a.type, a.title, a.body,
    (select i.summary from crm.call_insights i where i.activity_id = a.id and i.status = 'ready'),
    a.occurred_at, a.contact_id, a.company_id,
    nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
    co.name
  from crm.activities a
  left join crm.contacts c on c.id = a.contact_id
  left join crm.companies co on co.id = a.company_id
  where a.id = p_activity
    and a.archived_at is null
    and a.occurred_at <= now()
    and (a.contact_id is not null or a.company_id is not null)
    and (
      a.type = 'call'
      or (a.type = 'meeting' and coalesce(a.metadata->>'source', '') <> 'orbit')
      or (
        a.type = 'email'
        and a.metadata->>'campaignMessageId' is null
        and (
          a.metadata->>'direction' = 'outbound'
          or (a.metadata->>'direction' is null and coalesce(a.metadata->>'source', '') <> 'microsoft')
        )
      )
    );
$$;

create or replace function private.task_done_candidates(p_activity uuid)
returns table (
  task_id uuid,
  assignee_id uuid,
  title text,
  notes text,
  due_at timestamptz,
  candidate boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, coalesce(t.owner_id, t.created_by_user_id), t.title, t.description, t.due_at,
    (
      a.occurred_at > t.created_at
      and case when t.contact_id is not null then t.contact_id = a.contact_id else t.company_id = a.company_id end
      and not exists (select 1 from crm.task_done_offers o where o.task_id = t.id and o.activity_id = a.id)
    )
  from crm.activities a
  join crm.tasks t on t.workspace_id = a.workspace_id
  where a.id = p_activity
    and t.completed_at is null
    and t.archived_at is null
    and (t.contact_id = a.contact_id or t.company_id = a.company_id)
    and exists (
      select 1 from crm.workspace_members m
      where m.workspace_id = t.workspace_id and m.user_id = coalesce(t.owner_id, t.created_by_user_id)
    );
$$;

create or replace function private.offer_task_done(
  p_task uuid,
  p_activity uuid,
  p_note text,
  p_next_title text,
  p_next_due date
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_at timestamptz;
  v_workspace uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('task-done|' || p_task::text, 0));
  select a.type, a.occurred_at, a.workspace_id into v_kind, v_at, v_workspace
  from crm.activities a
  where a.id = p_activity and a.archived_at is null and a.occurred_at <= now() and a.type in ('email', 'call', 'meeting');
  if not found then
    return false;
  end if;
  perform 1 from crm.tasks t
  where t.id = p_task and t.workspace_id = v_workspace and t.completed_at is null and t.archived_at is null and t.created_at < v_at;
  if not found then
    return false;
  end if;
  if exists (select 1 from crm.task_done_offers o where o.task_id = p_task and o.activity_id = p_activity) then
    return false;
  end if;
  if exists (
    select 1 from crm.task_done_offers o
    join crm.activities oa on oa.id = o.activity_id
    where o.task_id = p_task and o.state = 'offered' and oa.occurred_at >= v_at
  ) then
    return false;
  end if;
  update crm.task_done_offers set state = 'dismissed', decided_at = now()
  where task_id = p_task and state = 'offered';
  insert into crm.task_done_offers (task_id, activity_id, kind, note, next_title, next_due)
  values (
    p_task, p_activity, v_kind,
    nullif(left(trim(coalesce(p_note, '')), 1000), ''),
    nullif(left(trim(coalesce(p_next_title, '')), 200), ''),
    case when nullif(trim(coalesce(p_next_title, '')), '') is null then null else p_next_due end
  );
  return true;
end;
$$;

create or replace function private.claim_task_done_queue(p_limit integer)
returns table (id uuid, activity_id uuid, claim_token uuid, attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  delete from crm.task_done_queue q
  where q.attempts >= 5 and (q.claimed_at is null or q.claimed_at <= now() - interval '5 minutes');
  return query
  with due as (
    select q.id from crm.task_done_queue q
    where q.next_attempt_at <= now()
      and (q.claimed_at is null or q.claimed_at <= now() - interval '5 minutes')
    order by q.next_attempt_at, q.id
    limit greatest(1, least(p_limit, 20))
    for update skip locked
  )
  update crm.task_done_queue q
    set claimed_at = now(), claim_token = gen_random_uuid(), attempts = q.attempts + 1
  from due
  where q.id = due.id
  returning q.id, q.activity_id, q.claim_token, q.attempts;
end;
$$;

create or replace function private.finish_task_done_queue(p_id uuid, p_token uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from crm.task_done_queue where id = p_id and claim_token = p_token;
$$;

create or replace function private.retry_task_done_queue(p_id uuid, p_token uuid, p_delay_seconds integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from crm.task_done_queue where id = p_id and claim_token = p_token and attempts >= 5;
  update crm.task_done_queue
    set claimed_at = null, claim_token = null, next_attempt_at = now() + make_interval(secs => greatest(0, p_delay_seconds))
  where id = p_id and claim_token = p_token;
end;
$$;

revoke all on function private.task_done_activity(uuid) from public;
revoke all on function private.task_done_candidates(uuid) from public;
revoke all on function private.offer_task_done(uuid, uuid, text, text, date) from public;
revoke all on function private.claim_task_done_queue(integer) from public;
revoke all on function private.finish_task_done_queue(uuid, uuid) from public;
revoke all on function private.retry_task_done_queue(uuid, uuid, integer) from public;
grant execute on function private.task_done_activity(uuid) to crm_app;
grant execute on function private.task_done_candidates(uuid) to crm_app;
grant execute on function private.offer_task_done(uuid, uuid, text, text, date) to crm_app;
grant execute on function private.claim_task_done_queue(integer) to crm_app;
grant execute on function private.finish_task_done_queue(uuid, uuid) to crm_app;
grant execute on function private.retry_task_done_queue(uuid, uuid, integer) to crm_app;
