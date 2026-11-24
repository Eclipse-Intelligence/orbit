set lock_timeout = '5s';

create or replace function private.meta_lead_outcomes_due(p_limit integer, p_contact uuid default null, p_company uuid default null, p_leads uuid[] default null)
returns table (
  lead_id uuid,
  workspace_id uuid,
  stage_name text,
  stage_id uuid,
  stage_position integer,
  occurred_at timestamptz,
  value numeric,
  currency text,
  opportunity_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_leads uuid[];
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(array_agg(x.id), '{}') into v_leads
  from (
    select l.id
    from crm.meta_leads l
    join crm.meta_outcome_settings s on s.workspace_id = l.workspace_id and s.enabled and s.dataset_id is not null
    where l.filed_at is not null
      and (
        case
          when p_leads is not null then l.id = any(p_leads)
          when p_contact is null and p_company is null then l.filed_at > now() - interval '90 days'
          else l.contact_id = p_contact or l.company_id = p_company
        end
      )
    order by l.outcomes_checked_at nulls first, l.filed_at
    limit p_limit
  ) x;
  update crm.meta_leads l set outcomes_checked_at = now() where l.id = any(v_leads);

  return query
  with lead as (
    select l.id, l.workspace_id, l.contact_id, l.company_id, l.filed_at,
      coalesce(l.lead_created_at, l.filed_at) as lead_time,
      private.meta_outcomes_pipeline(l.workspace_id, s.pipeline_id) as pipeline_id
    from crm.meta_leads l
    join crm.meta_outcome_settings s on s.workspace_id = l.workspace_id
    where l.id = any(v_leads)
  ),
  stages as (
    select st.id, st.pipeline_id, st.name, st."position", st.is_won, st.is_lost
    from crm.pipeline_stages st
    where st.pipeline_id in (select pipeline_id from lead)
      and st."position" > (select min(f."position") from crm.pipeline_stages f where f.pipeline_id = st.pipeline_id)
      and lower(st.name) <> 'lead'
  ),
  entries as (
    select ld.id as lead_id, o.id as opportunity_id, o.value, o.currency, st.id as stage_id, e.entered_at, e.id as entry_id
    from lead ld
    join crm.opportunities o
      on o.pipeline_id = ld.pipeline_id and o.archived_at is null and o.created_at >= ld.lead_time
      and (o.primary_contact_id = ld.contact_id or o.company_id = ld.company_id)
    join crm.opportunity_stage_entries e on e.opportunity_id = o.id and e.pipeline_id = ld.pipeline_id
    join stages st on st.id = e.stage_id
    join crm.pipeline_stages cur on cur.id = o.stage_id
    left join lateral (
      select n.entered_at from crm.opportunity_stage_entries n
      where n.opportunity_id = o.id and (n.entered_at, n.id) > (e.entered_at, e.id)
      order by n.entered_at, n.id
      limit 1
    ) nxt on true
    where e.entered_at <= now() - interval '5 minutes'
      and (
        (nxt.entered_at is null and o.stage_id = e.stage_id)
        or (nxt.entered_at is not null and nxt.entered_at - e.entered_at >= interval '5 minutes')
        or (not cur.is_lost and cur."position" > st."position")
      )
      and (not st.is_lost or (nxt.entered_at is null and o.stage_id = e.stage_id))
  ),
  reached as (
    select r.lead_id, r.stage_id, r.entered_at, r.opportunity_id, r.value, r.currency
    from (
      select en.*, row_number() over (partition by en.lead_id, en.stage_id order by en.entered_at desc, en.entry_id desc) as rn_last,
      row_number() over (partition by en.lead_id, en.stage_id order by en.entered_at, en.entry_id) as rn
      from entries en
    ) r
    join stages s on s.id = r.stage_id
    where (not s.is_lost and r.rn = 1)
      or (
        s.is_lost and r.rn_last = 1
        and not exists (
          select 1 from lead ld
          join crm.opportunities o2
            on o2.pipeline_id = ld.pipeline_id and o2.archived_at is null and o2.created_at >= ld.lead_time
            and (o2.primary_contact_id = ld.contact_id or o2.company_id = ld.company_id)
          where ld.id = r.lead_id and o2.status in ('open', 'won')
        )
      )
  ),
  candidates as (
    select r.lead_id, st.id as stage_id, st.name as stage_name, st."position" + 1 as pos, r.entered_at as own_time,
      r.opportunity_id,
      case when st.is_won then r.value end as value,
      case when st.is_won and r.value is not null then r.currency end as currency
    from reached r
    join stages st on st.id = r.stage_id
  ),
  top as (
    select c.lead_id, max(c.pos) as top_pos from candidates c join stages s on s.id = c.stage_id where not s.is_lost group by c.lead_id
  ),
  everything as (
    select c.lead_id, c.stage_id, c.stage_name, c.pos, c.own_time, c.opportunity_id, c.value, c.currency from candidates c
    union all
    select ld.id, st.id, st.name, st."position" + 1, null::timestamptz, null::uuid, null::numeric, null::text
    from lead ld
    join top t on t.lead_id = ld.id
    join stages st on st.pipeline_id = ld.pipeline_id and st."position" + 1 < t.top_pos and not st.is_lost
    where not exists (select 1 from candidates c where c.lead_id = ld.id and c.stage_id = st.id)
    union all
    select ld.id, null::uuid, 'Lead', 0, ld.filed_at, null::uuid, null::numeric, null::text
    from lead ld
  ),
  timed as (
    select ev.*,
      case when ev.is_lost then ev.own_time
        else min(ev.own_time) filter (where not ev.is_lost) over (partition by ev.lead_id order by ev.pos desc rows between unbounded preceding and current row)
      end as later_time
    from (select e2.*, coalesce((select s.is_lost from stages s where s.id = e2.stage_id), false) as is_lost from everything e2) ev
  )
  select t.lead_id, ld.workspace_id, t.stage_name, t.stage_id, t.pos, t.final_time, t.value, t.currency, t.opportunity_id
  from (select tm.*, case when tm.pos = 0 then least(tm.later_time, coalesce((select min(l2.own_time) from everything l2 join stages s2 on s2.id = l2.stage_id where l2.lead_id = tm.lead_id and s2.is_lost), tm.later_time)) else tm.later_time end as final_time from timed tm) t
  join lead ld on ld.id = t.lead_id
  where t.final_time is not null
    and not exists (
      select 1 from crm.meta_lead_outcomes x
      where x.lead_id = t.lead_id and (x.stage_name = t.stage_name or (t.stage_id is not null and x.stage_id = t.stage_id))
    )
  order by t.lead_id, t.pos;
end;
$$;

revoke all on function private.meta_lead_outcomes_due(integer, uuid, uuid, uuid[]) from public;
grant execute on function private.meta_lead_outcomes_due(integer, uuid, uuid, uuid[]) to crm_app;

reset lock_timeout;
