set lock_timeout = '5s';

alter table crm.task_done_queue drop constraint if exists task_done_queue_reason;
alter table crm.task_done_queue add constraint task_done_queue_reason check (reason in ('created', 'updated', 'moved', 'summary'));

drop function if exists private.claim_task_done_queue(integer);

create or replace function private.claim_task_done_queue(p_limit integer)
returns table (id uuid, activity_id uuid, claim_token uuid, attempts integer, asked uuid[], reason text)
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
  returning q.id, q.activity_id, q.claim_token, q.attempts, q.asked, q.reason;
end;
$$;

create or replace function private.reset_task_done_offers(p_activity uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task uuid;
  v_back uuid;
begin
  for v_task in
    delete from crm.task_done_offers where activity_id = p_activity and state = 'offered' returning task_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('task-done|' || v_task::text, 0));
    if exists (select 1 from crm.task_done_offers o where o.task_id = v_task and o.state = 'offered') then
      continue;
    end if;
    select o.id into v_back
    from crm.task_done_offers o
    join crm.tasks t on t.id = o.task_id
    join crm.activities a on a.id = o.activity_id
    where o.task_id = v_task and o.state = 'dismissed' and o.decided_by is null
      and t.completed_at is null and t.archived_at is null
      and a.archived_at is null and a.workspace_id = t.workspace_id
      and a.occurred_at > t.created_at and a.occurred_at <= now()
      and (t.contact_id = a.contact_id or t.company_id = a.company_id)
      and case when t.contact_id is not null then t.contact_id = a.contact_id else t.company_id = a.company_id end
    order by o.created_at desc
    limit 1;
    if v_back is not null then
      update crm.task_done_offers set state = 'offered', decided_at = null where id = v_back;
    end if;
  end loop;
end;
$$;

create or replace function private.retry_task_done_queue(p_id uuid, p_token uuid, p_delay_seconds integer, p_asked uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from crm.task_done_queue where id = p_id and claim_token = p_token and attempts >= 5;
  update crm.task_done_queue
    set claimed_at = null, claim_token = null, next_attempt_at = now() + make_interval(secs => greatest(0, p_delay_seconds)),
        asked = (select coalesce(array_agg(distinct x), '{}') from unnest(asked || coalesce(p_asked, '{}')) as x)
  where id = p_id and claim_token = p_token;
end;
$$;

create or replace function private.retry_task_done_queue(p_id uuid, p_token uuid, p_delay_seconds integer)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.retry_task_done_queue(p_id, p_token, p_delay_seconds, '{}'::uuid[]);
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
  v_contact uuid;
  v_company uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('task-done|' || p_task::text, 0));
  select a.type, a.occurred_at, a.workspace_id, a.contact_id, a.company_id into v_kind, v_at, v_workspace, v_contact, v_company
  from crm.activities a
  where a.id = p_activity and a.archived_at is null and a.occurred_at <= now() and a.type in ('email', 'call', 'meeting');
  if not found then
    return false;
  end if;
  perform 1 from crm.tasks t
  where t.id = p_task and t.workspace_id = v_workspace and t.completed_at is null and t.archived_at is null and t.created_at < v_at
    and (t.contact_id = v_contact or t.company_id = v_company)
    and case when t.contact_id is not null then t.contact_id = v_contact else t.company_id = v_company end;
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

create table if not exists crm.mail_task_judgements (
  user_id uuid not null references crm.profiles (id) on delete cascade,
  message_id uuid not null references crm.mail_messages (id) on delete cascade,
  worth boolean not null,
  decided_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

alter table crm.mail_task_judgements enable row level security;
alter table crm.mail_task_judgements force row level security;

drop policy if exists mail_task_judgements_owner on crm.mail_task_judgements;
create policy mail_task_judgements_owner on crm.mail_task_judgements
  for all to authenticated
  using (user_id = (select private.session_user_id()))
  with check (user_id = (select private.session_user_id()));

revoke all on crm.mail_task_judgements from anon, authenticated, crm_agent;
grant select, insert, update on crm.mail_task_judgements to authenticated;

create index if not exists mail_task_judgements_message_idx on crm.mail_task_judgements (message_id);

revoke all on function private.claim_task_done_queue(integer) from public;
revoke all on function private.offer_task_done(uuid, uuid, text, text, date) from public;
revoke all on function private.retry_task_done_queue(uuid, uuid, integer) from public;
grant execute on function private.offer_task_done(uuid, uuid, text, text, date) to crm_app;
grant execute on function private.retry_task_done_queue(uuid, uuid, integer) to crm_app;
revoke all on function private.reset_task_done_offers(uuid) from public;
revoke all on function private.retry_task_done_queue(uuid, uuid, integer, uuid[]) from public;
grant execute on function private.claim_task_done_queue(integer) to crm_app;
grant execute on function private.reset_task_done_offers(uuid) to crm_app;
grant execute on function private.retry_task_done_queue(uuid, uuid, integer, uuid[]) to crm_app;
