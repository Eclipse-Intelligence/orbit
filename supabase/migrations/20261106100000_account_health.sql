alter table crm.call_insights add column if not exists sentiment text;
alter table crm.call_insights add column if not exists sentiment_reason text;
alter table crm.call_insights add column if not exists sentiment_checked_at timestamptz;

alter table crm.call_insights drop constraint if exists call_insights_sentiment;
alter table crm.call_insights add constraint call_insights_sentiment
  check (sentiment is null or sentiment in ('healthy', 'watch', 'at_risk'));
alter table crm.call_insights drop constraint if exists call_insights_sentiment_reason;
alter table crm.call_insights add constraint call_insights_sentiment_reason
  check (sentiment_reason is null or char_length(sentiment_reason) <= 500);

grant update (summary, key_points, action_items, model, status, error, sentiment, sentiment_reason, sentiment_checked_at)
  on crm.call_insights to authenticated, crm_agent;

alter table crm.companies add column if not exists health text;
alter table crm.companies add column if not exists health_reason text;
alter table crm.companies add column if not exists health_at timestamptz;
alter table crm.companies add column if not exists health_activity_id uuid references crm.activities (id) on delete set null;

alter table crm.companies drop constraint if exists companies_health;
alter table crm.companies add constraint companies_health
  check (health is null or health in ('healthy', 'watch', 'at_risk'));
alter table crm.companies drop constraint if exists companies_health_reason;
alter table crm.companies add constraint companies_health_reason
  check (health_reason is null or char_length(health_reason) <= 500);

create index if not exists companies_health_idx
  on crm.companies (workspace_id, health)
  where archived_at is null and health is not null;

create or replace function private.claim_unjudged_calls(p_limit integer)
returns table (activity_id uuid, workspace_id uuid, user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select i.id, i.activity_id, i.workspace_id,
      coalesce(
        (select m.user_id from crm.workspace_members m where m.workspace_id = i.workspace_id and m.user_id = a.actor_user_id),
        (select m.user_id from crm.workspace_members m where m.workspace_id = i.workspace_id and m.role = 'owner' order by m.created_at limit 1)
      ) as user_id
    from crm.call_insights i
    join crm.activities a on a.id = i.activity_id
    where i.status = 'ready'
      and i.sentiment is null
      and i.sentiment_checked_at is null
    order by a.occurred_at desc
    limit greatest(1, least(p_limit, 20))
    for update of i skip locked
  )
  update crm.call_insights i
    set sentiment_checked_at = now()
  from due
  where i.id = due.id and due.user_id is not null
  returning due.activity_id, due.workspace_id, due.user_id;
end;
$$;

revoke all on function private.claim_unjudged_calls(integer) from public;
grant execute on function private.claim_unjudged_calls(integer) to crm_app;
