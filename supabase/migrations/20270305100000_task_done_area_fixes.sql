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
language sql
security definer
set search_path = ''
as $$
  delete from crm.task_done_offers where activity_id = p_activity and state = 'offered';
$$;

drop function if exists private.retry_task_done_queue(uuid, uuid, integer);

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

revoke all on function private.claim_task_done_queue(integer) from public;
revoke all on function private.reset_task_done_offers(uuid) from public;
revoke all on function private.retry_task_done_queue(uuid, uuid, integer, uuid[]) from public;
grant execute on function private.claim_task_done_queue(integer) to crm_app;
grant execute on function private.reset_task_done_offers(uuid) to crm_app;
grant execute on function private.retry_task_done_queue(uuid, uuid, integer, uuid[]) to crm_app;
