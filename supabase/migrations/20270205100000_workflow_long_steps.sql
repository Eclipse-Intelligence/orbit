create or replace function private.claim_workflow_runs(p_limit integer, p_long boolean)
returns table (run_id uuid, workspace_id uuid, owner_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select r.id
    from crm.workflow_runs r
    where (r.status = 'queued'
       or (r.status = 'waiting' and r.waiting_for = 'delay' and r.resume_at <= now())
       or (r.status = 'running' and r.claimed_at < now() - interval '10 minutes'))
      and (p_long or coalesce(r.state->>'needsTime', 'false') <> 'true')
      and exists (select 1 from crm.workspace_members m where m.workspace_id = r.workspace_id and m.user_id = r.owner_id)
    order by coalesce(r.resume_at, r.created_at)
    limit greatest(1, least(p_limit, 50))
    for update skip locked
  )
  update crm.workflow_runs r
    set status = 'running', claimed_at = now(), started_at = coalesce(r.started_at, now()), waiting_for = null, resume_at = null
  from due
  where r.id = due.id
  returning r.id, r.workspace_id, r.owner_id;
end;
$$;
revoke all on function private.claim_workflow_runs(integer, boolean) from public;
grant execute on function private.claim_workflow_runs(integer, boolean) to crm_app;
