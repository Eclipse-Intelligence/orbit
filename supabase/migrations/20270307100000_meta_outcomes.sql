set lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'Run this as a role that bypasses row-level security: the trigger and private functions write to crm.opportunity_stage_entries, crm.meta_lead_outcomes and crm.meta_outcome_settings, which have no insert policy for them.';
  end if;
end;
$$;

create table if not exists crm.opportunity_stage_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  opportunity_id uuid not null references crm.opportunities (id) on delete cascade,
  pipeline_id uuid not null references crm.pipelines (id) on delete cascade,
  stage_id uuid not null references crm.pipeline_stages (id) on delete cascade,
  entered_at timestamptz not null default now()
);

create index if not exists opportunity_stage_entries_opportunity_idx on crm.opportunity_stage_entries (opportunity_id, entered_at);
create index if not exists opportunity_stage_entries_stage_idx on crm.opportunity_stage_entries (pipeline_id, stage_id);

alter table crm.opportunity_stage_entries enable row level security;
alter table crm.opportunity_stage_entries force row level security;

drop policy if exists opportunity_stage_entries_read on crm.opportunity_stage_entries;
create policy opportunity_stage_entries_read on crm.opportunity_stage_entries for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and exists (
      select 1 from crm.opportunities o
      where o.id = opportunity_id and o.workspace_id in (select private.user_workspace_ids())
    )
  );

revoke all on crm.opportunity_stage_entries from public, anon, authenticated, crm_agent;
grant select on crm.opportunity_stage_entries to authenticated;

create or replace function private.opportunity_stage_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage_id is not null and new.pipeline_id is not null
     and (tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id) then
    insert into crm.opportunity_stage_entries (workspace_id, opportunity_id, pipeline_id, stage_id, entered_at)
    values (new.workspace_id, new.id, new.pipeline_id, new.stage_id, clock_timestamp());
  end if;
  return null;
end;
$$;

revoke all on function private.opportunity_stage_entry() from public;

lock table crm.opportunities in share row exclusive mode;

with events as (
  select e.entity_id as opportunity_id, e.id as event_id, e.created_at as at, e.changes #>> '{after,stageId}' as stage_text
  from crm.audit_events e
  where e.entity_type = 'opportunity'
    and e.event_type in ('opportunity.created', 'opportunity.stage_changed')
    and e.changes #>> '{after,stageId}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
ordered as (
  select ev.*, lag(ev.stage_text) over (partition by ev.opportunity_id order by ev.at, ev.event_id) as previous_text
  from events ev
)
insert into crm.opportunity_stage_entries (workspace_id, opportunity_id, pipeline_id, stage_id, entered_at)
select o.workspace_id, o.id, s.pipeline_id, s.id, c.at
from ordered c
join crm.opportunities o on o.id = c.opportunity_id
join crm.pipeline_stages s on s.id = c.stage_text::uuid and s.workspace_id = o.workspace_id
where c.previous_text is distinct from c.stage_text
  and not exists (select 1 from crm.opportunity_stage_entries x where x.opportunity_id = o.id);

insert into crm.opportunity_stage_entries (workspace_id, opportunity_id, pipeline_id, stage_id, entered_at)
select o.workspace_id, o.id, o.pipeline_id, o.stage_id,
  case when last.stage_id is null then o.created_at else greatest(o.updated_at, last.entered_at) end
from crm.opportunities o
left join lateral (
  select x.stage_id, x.entered_at from crm.opportunity_stage_entries x
  where x.opportunity_id = o.id
  order by x.entered_at desc, x.id desc
  limit 1
) last on true
where o.stage_id is not null and o.pipeline_id is not null
  and last.stage_id is distinct from o.stage_id;

drop trigger if exists opportunity_stage_entries_write on crm.opportunities;
create trigger opportunity_stage_entries_write
  after insert or update of stage_id on crm.opportunities
  for each row execute function private.opportunity_stage_entry();

create table if not exists crm.meta_outcome_settings (
  workspace_id uuid primary key references crm.workspaces (id) on delete cascade,
  dataset_id text,
  pipeline_id uuid references crm.pipelines (id) on delete set null,
  enabled boolean not null default false,
  last_error text,
  last_error_at timestamptz,
  alerted_at timestamptz,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_outcome_settings_dataset check (dataset_id is null or dataset_id ~ '^[0-9]{1,40}$'),
  constraint meta_outcome_settings_enabled check (not enabled or dataset_id is not null),
  constraint meta_outcome_settings_error check (last_error is null or char_length(last_error) <= 500)
);

alter table crm.meta_outcome_settings add column if not exists last_sent_at timestamptz;

alter table crm.meta_outcome_settings enable row level security;
alter table crm.meta_outcome_settings force row level security;

drop policy if exists meta_outcome_settings_read on crm.meta_outcome_settings;
create policy meta_outcome_settings_read on crm.meta_outcome_settings for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists meta_outcome_settings_admin_insert on crm.meta_outcome_settings;
create policy meta_outcome_settings_admin_insert on crm.meta_outcome_settings for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists meta_outcome_settings_admin_update on crm.meta_outcome_settings;
create policy meta_outcome_settings_admin_update on crm.meta_outcome_settings for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id))
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));

revoke all on crm.meta_outcome_settings from public, anon, authenticated, crm_agent;
grant select on crm.meta_outcome_settings to authenticated;
grant insert (workspace_id, dataset_id, pipeline_id, enabled) on crm.meta_outcome_settings to authenticated;
grant update (dataset_id, pipeline_id, enabled, last_error, last_error_at, alerted_at) on crm.meta_outcome_settings to authenticated;

create or replace function private.meta_outcome_settings_dataset_changed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.dataset_id is distinct from old.dataset_id then
    new.last_sent_at := null;
  end if;
  return new;
end;
$$;

revoke all on function private.meta_outcome_settings_dataset_changed() from public;

drop trigger if exists meta_outcome_settings_dataset_changed on crm.meta_outcome_settings;
create trigger meta_outcome_settings_dataset_changed
  before update on crm.meta_outcome_settings
  for each row execute function private.meta_outcome_settings_dataset_changed();

drop trigger if exists meta_outcome_settings_set_updated_at on crm.meta_outcome_settings;
create trigger meta_outcome_settings_set_updated_at
  before update on crm.meta_outcome_settings
  for each row execute function private.set_updated_at();

alter table crm.meta_leads add column if not exists email_hash text;
alter table crm.meta_leads add column if not exists phone_hash text;
alter table crm.meta_leads add column if not exists outcomes_checked_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meta_leads_hashes' and conrelid = 'crm.meta_leads'::regclass) then
    alter table crm.meta_leads add constraint meta_leads_hashes check (
      (email_hash is null or email_hash ~ '^[0-9a-f]{64}$') and (phone_hash is null or phone_hash ~ '^[0-9a-f]{64}$')
    ) not valid;
  end if;
end;
$$;

create index if not exists meta_leads_outcomes_idx on crm.meta_leads (outcomes_checked_at nulls first, filed_at) where filed_at is not null;

grant update (contact_id, company_id, activity_id, filed_at, error, email_hash, phone_hash) on crm.meta_leads to authenticated;

create table if not exists crm.meta_lead_outcomes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  lead_id uuid not null references crm.meta_leads (id) on delete cascade,
  stage_name text not null,
  stage_id uuid references crm.pipeline_stages (id) on delete set null,
  "position" integer not null,
  occurred_at timestamptz not null,
  value numeric(14, 2),
  currency text,
  opportunity_id uuid references crm.opportunities (id) on delete set null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  claimed_until timestamptz,
  isolate boolean not null default false,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  constraint meta_lead_outcomes_status check (status in ('pending', 'sent', 'skipped', 'failed')),
  constraint meta_lead_outcomes_stage_name check (char_length(stage_name) between 1 and 80),
  constraint meta_lead_outcomes_position check ("position" >= 0),
  constraint meta_lead_outcomes_currency check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint meta_lead_outcomes_error check (error is null or char_length(error) <= 500),
  constraint meta_lead_outcomes_unique unique (lead_id, stage_name)
);

alter table crm.meta_lead_outcomes add column if not exists isolate boolean not null default false;

create index if not exists meta_lead_outcomes_pending_idx on crm.meta_lead_outcomes (workspace_id, next_attempt_at) where status = 'pending';
create index if not exists meta_lead_outcomes_lead_idx on crm.meta_lead_outcomes (lead_id, "position");

alter table crm.meta_lead_outcomes enable row level security;
alter table crm.meta_lead_outcomes force row level security;

drop policy if exists meta_lead_outcomes_read on crm.meta_lead_outcomes;
create policy meta_lead_outcomes_read on crm.meta_lead_outcomes for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

revoke all on crm.meta_lead_outcomes from public, anon, authenticated, crm_agent;
grant select (workspace_id, lead_id, stage_name, "position", occurred_at, status, attempts, sent_at, value, currency) on crm.meta_lead_outcomes to authenticated;

reset lock_timeout;

create or replace function private.meta_outcomes_pipeline(p_workspace uuid, p_chosen uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select p.id from crm.pipelines p
      where p.id = p_chosen and p.workspace_id = p_workspace and p.kind = 'sales' and p.archived_at is null
    ),
    (
      select (array_agg(p.id))[1] from crm.pipelines p
      where p.workspace_id = p_workspace and p.kind = 'sales' and p.archived_at is null
      having count(*) = 1
    )
  );
$$;

revoke all on function private.meta_outcomes_pipeline(uuid, uuid) from public;
grant execute on function private.meta_outcomes_pipeline(uuid, uuid) to crm_app;

create or replace function private.meta_outcomes_pipeline_unresolved(p_workspace uuid, p_chosen uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.meta_outcomes_pipeline(p_workspace, p_chosen) is null
    and (select count(*) from crm.pipelines p where p.workspace_id = p_workspace and p.kind = 'sales' and p.archived_at is null) > 1;
$$;

revoke all on function private.meta_outcomes_pipeline_unresolved(uuid, uuid) from public;
grant execute on function private.meta_outcomes_pipeline_unresolved(uuid, uuid) to crm_app;

create or replace function private.meta_outcomes_sync_pipeline_error(p_workspace uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update crm.meta_outcome_settings s
  set last_error = 'Choose a pipeline in Settings › Tools.',
      last_error_at = case when s.last_error = 'Choose a pipeline in Settings › Tools.' then coalesce(s.last_error_at, now()) else now() end,
      alerted_at = case when s.last_error = 'Choose a pipeline in Settings › Tools.' then s.alerted_at else null end
  where s.workspace_id = p_workspace and s.enabled and s.dataset_id is not null
    and private.meta_outcomes_pipeline_unresolved(s.workspace_id, s.pipeline_id)
    and (s.last_error is null or s.last_error = 'Choose a pipeline in Settings › Tools.');
  update crm.meta_outcome_settings s
  set last_error = null, last_error_at = null, alerted_at = null
  where s.workspace_id = p_workspace
    and s.last_error = 'Choose a pipeline in Settings › Tools.'
    and not (s.enabled and s.dataset_id is not null and private.meta_outcomes_pipeline_unresolved(s.workspace_id, s.pipeline_id));
end;
$$;

revoke all on function private.meta_outcomes_sync_pipeline_error(uuid) from public;

create or replace function private.meta_outcomes_pipeline_status()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  for v_workspace in
    select s.workspace_id from crm.meta_outcome_settings s
    where s.last_error = 'Choose a pipeline in Settings › Tools.' or (s.enabled and s.dataset_id is not null)
  loop
    perform private.meta_outcomes_sync_pipeline_error(v_workspace);
  end loop;
end;
$$;

revoke all on function private.meta_outcomes_pipeline_status() from public;
grant execute on function private.meta_outcomes_pipeline_status() to crm_app;

create or replace function private.meta_outcomes_proven(p_workspace uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return exists (
    select 1 from crm.meta_outcome_settings s
    where s.workspace_id = p_workspace
      and s.last_sent_at > now() - interval '1 day'
      and (s.last_error is null or s.last_error = 'Choose a pipeline in Settings › Tools.')
  );
end;
$$;

revoke all on function private.meta_outcomes_proven(uuid) from public;
grant execute on function private.meta_outcomes_proven(uuid) to crm_app;

create or replace function private.meta_outcomes_work_due()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return exists (select 1 from crm.meta_outcome_settings s where s.enabled and s.dataset_id is not null);
end;
$$;

revoke all on function private.meta_outcomes_work_due() from public;
grant execute on function private.meta_outcomes_work_due() to crm_app;

create or replace function private.meta_lead_same_workspace()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('orbit.merging', true) = 'on' and current_user not in ('authenticated', 'crm_agent', 'crm_app') then
    return new;
  end if;
  if new.contact_id is not null and new.contact_id is distinct from old.contact_id and not exists (
    select 1 from crm.contacts c where c.id = new.contact_id and c.workspace_id is not distinct from new.workspace_id
  ) then
    raise exception 'contact belongs to another workspace' using errcode = '23514';
  end if;
  if new.company_id is not null and new.company_id is distinct from old.company_id and not exists (
    select 1 from crm.companies c where c.id = new.company_id and c.workspace_id is not distinct from new.workspace_id
  ) then
    raise exception 'company belongs to another workspace' using errcode = '23514';
  end if;
  if new.activity_id is not null and new.activity_id is distinct from old.activity_id and not exists (
    select 1 from crm.activities a where a.id = new.activity_id and a.workspace_id is not distinct from new.workspace_id
  ) then
    raise exception 'activity belongs to another workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.meta_lead_same_workspace() from public;

create or replace function private.meta_leads_unhashed(p_limit integer)
returns table (id uuid, answers jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select l.id, l.answers
  from crm.meta_leads l
  join crm.meta_outcome_settings s on s.workspace_id = l.workspace_id and s.enabled and s.dataset_id is not null
  where l.filed_at is not null and l.outcomes_checked_at is null and l.email_hash is null and l.phone_hash is null
  order by l.filed_at desc
  limit p_limit;
end;
$$;

revoke all on function private.meta_leads_unhashed(integer) from public;
grant execute on function private.meta_leads_unhashed(integer) to crm_app;

create or replace function private.meta_lead_hashes_set(p_lead uuid, p_email text, p_phone text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.meta_leads
  set email_hash = coalesce(email_hash, p_email), phone_hash = coalesce(phone_hash, p_phone)
  where id = p_lead;
end;
$$;

revoke all on function private.meta_lead_hashes_set(uuid, text, text) from public;
grant execute on function private.meta_lead_hashes_set(uuid, text, text) to crm_app;

drop function if exists private.meta_lead_outcomes_due(integer, uuid, uuid);

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
    select st.id, st.pipeline_id, st.name, st."position", st.is_won
    from crm.pipeline_stages st
    where st.pipeline_id in (select pipeline_id from lead)
      and not st.is_lost
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
  ),
  reached as (
    select r.lead_id, r.stage_id, r.entered_at, r.opportunity_id, r.value, r.currency
    from (
      select en.*, row_number() over (partition by en.lead_id, en.stage_id order by en.entered_at, en.entry_id) as rn
      from entries en
    ) r
    where r.rn = 1
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
    select c.lead_id, max(c.pos) as top_pos from candidates c group by c.lead_id
  ),
  everything as (
    select c.lead_id, c.stage_id, c.stage_name, c.pos, c.own_time, c.opportunity_id, c.value, c.currency from candidates c
    union all
    select ld.id, st.id, st.name, st."position" + 1, null::timestamptz, null::uuid, null::numeric, null::text
    from lead ld
    join top t on t.lead_id = ld.id
    join stages st on st.pipeline_id = ld.pipeline_id and st."position" + 1 < t.top_pos
    where not exists (select 1 from candidates c where c.lead_id = ld.id and c.stage_id = st.id)
    union all
    select ld.id, null::uuid, 'Lead', 0, ld.filed_at, null::uuid, null::numeric, null::text
    from lead ld
  ),
  timed as (
    select ev.*, min(ev.own_time) over (partition by ev.lead_id order by ev.pos desc rows between unbounded preceding and current row) as final_time
    from everything ev
  )
  select t.lead_id, ld.workspace_id, t.stage_name, t.stage_id, t.pos, t.final_time, t.value, t.currency, t.opportunity_id
  from timed t
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

create or replace function private.meta_lead_outcomes_record(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with written as (
    insert into crm.meta_lead_outcomes as o (
      workspace_id, lead_id, stage_name, stage_id, "position", occurred_at, value, currency, opportunity_id, status, error
    )
    select l.workspace_id, r.lead_id, r.stage_name, r.stage_id, r."position", r.occurred_at, r.value, r.currency, r.opportunity_id,
      case when r.occurred_at < now() - interval '6.5 days' then 'skipped' else 'pending' end,
      case when r.occurred_at < now() - interval '6.5 days' then 'Too old for Meta.' end
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r (
      lead_id uuid, stage_name text, stage_id uuid, "position" integer, occurred_at timestamptz, value numeric, currency text, opportunity_id uuid
    )
    join crm.meta_leads l on l.id = r.lead_id and l.workspace_id is not null
    join crm.meta_outcome_settings s on s.workspace_id = l.workspace_id and s.enabled and s.dataset_id is not null
    on conflict (lead_id, stage_name) do update
      set stage_id = excluded.stage_id,
          "position" = excluded."position",
          occurred_at = excluded.occurred_at,
          value = excluded.value,
          currency = excluded.currency,
          opportunity_id = excluded.opportunity_id,
          status = excluded.status,
          attempts = 0,
          next_attempt_at = null,
          claimed_until = null,
          isolate = false,
          error = excluded.error
      where o.status in ('skipped', 'failed')
    returning 1
  )
  select count(*)::integer into v_count from written;
  return v_count;
end;
$$;

revoke all on function private.meta_lead_outcomes_record(jsonb) from public;
grant execute on function private.meta_lead_outcomes_record(jsonb) to crm_app;

drop function if exists private.meta_lead_outcomes_claim(integer);

create or replace function private.meta_lead_outcomes_claim(p_limit integer)
returns table (
  id uuid,
  workspace_id uuid,
  dataset_id text,
  leadgen_id text,
  stage_name text,
  "position" integer,
  occurred_at timestamptz,
  value numeric,
  currency text,
  email_hash text,
  phone_hash text,
  attempts integer,
  isolate boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update crm.meta_lead_outcomes o
  set occurred_at = f.fresh_time, status = 'pending', attempts = 0, next_attempt_at = null, claimed_until = null, isolate = false, error = null
  from (
    select u.id, (
      select min(x.occurred_at) from crm.meta_lead_outcomes x
      where x.lead_id = u.lead_id and x."position" > u."position" and x.status = 'pending'
        and x.occurred_at >= now() - interval '6.5 days'
    ) as fresh_time
    from crm.meta_lead_outcomes u
    where u.status in ('pending', 'skipped', 'failed')
      and u.occurred_at < now() - interval '6.5 days'
      and (u.claimed_until is null or u.claimed_until <= now())
  ) f
  where o.id = f.id and f.fresh_time is not null;

  update crm.meta_lead_outcomes o
  set status = case when o.attempts > 0 then 'failed' else 'skipped' end,
      claimed_until = null,
      error = case when o.attempts > 0 then 'Not sent within 6.5 days.' else 'Too old for Meta.' end
  where o.status = 'pending'
    and o.occurred_at < now() - interval '6.5 days'
    and (o.claimed_until is null or o.claimed_until <= now());

  return query
  with ready as (
    select o.id, o.lead_id
    from crm.meta_lead_outcomes o
    join crm.meta_outcome_settings s on s.workspace_id = o.workspace_id and s.enabled and s.dataset_id is not null
    where o.status = 'pending'
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
      and (o.claimed_until is null or o.claimed_until <= now())
  ),
  eligible as (
    select r.id, r.lead_id
    from ready r
    join crm.meta_lead_outcomes o on o.id = r.id
    where not exists (
      select 1 from crm.meta_lead_outcomes b
      where b.lead_id = o.lead_id and b."position" < o."position" and b.status <> 'sent'
        and b.id not in (select x.id from ready x)
    )
  ),
  picked as (
    select l.id
    from crm.meta_leads l
    where l.id in (select e.lead_id from eligible e)
    order by l.filed_at
    limit p_limit
    for update of l skip locked
  ),
  claimed as (
    update crm.meta_lead_outcomes o
    set claimed_until = now() + interval '2 minutes'
    where o.lead_id in (select p.id from picked p)
      and o.id in (select e.id from eligible e)
      and o.status = 'pending'
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
      and (o.claimed_until is null or o.claimed_until <= now())
      and not exists (
        select 1 from crm.meta_lead_outcomes b
        where b.lead_id = o.lead_id and b."position" < o."position" and b.status <> 'sent'
          and b.id not in (select x.id from ready x)
      )
    returning o.id, o.workspace_id, o.lead_id, o.stage_name, o."position", o.occurred_at, o.value, o.currency, o.attempts, o.isolate
  )
  select c.id, c.workspace_id, s.dataset_id, l.leadgen_id, c.stage_name, c."position", c.occurred_at, c.value, c.currency,
    l.email_hash, l.phone_hash, c.attempts, c.isolate
  from claimed c
  join crm.meta_leads l on l.id = c.lead_id
  join crm.meta_outcome_settings s on s.workspace_id = c.workspace_id;
end;
$$;

revoke all on function private.meta_lead_outcomes_claim(integer) from public;
grant execute on function private.meta_lead_outcomes_claim(integer) to crm_app;

drop function if exists private.meta_lead_outcomes_finish(uuid[], jsonb, uuid[], uuid[], text);

create or replace function private.meta_lead_outcomes_finish(
  p_sent uuid[],
  p_failed jsonb,
  p_retry uuid[],
  p_release uuid[],
  p_error text,
  p_split uuid[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.meta_lead_outcomes o
  set status = 'sent', sent_at = now(), claimed_until = null, next_attempt_at = null, isolate = false, error = null
  where o.id = any(coalesce(p_sent, '{}'));
  update crm.meta_outcome_settings s
  set last_sent_at = now()
  where s.workspace_id in (select o.workspace_id from crm.meta_lead_outcomes o where o.id = any(coalesce(p_sent, '{}')));
  update crm.meta_lead_outcomes o
  set status = 'failed', claimed_until = null, next_attempt_at = null, isolate = false, error = left(f.error, 500)
  from jsonb_to_recordset(coalesce(p_failed, '[]'::jsonb)) as f (id uuid, error text)
  where o.id = f.id;
  update crm.meta_lead_outcomes o
  set attempts = o.attempts + 1,
      claimed_until = null,
      next_attempt_at = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(o.attempts, 10))),
      error = left(p_error, 500)
  where o.id = any(coalesce(p_retry, '{}'));
  update crm.meta_lead_outcomes o
  set attempts = o.attempts + 1,
      claimed_until = null,
      isolate = true,
      next_attempt_at = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(o.attempts, 10)))
  where o.id = any(coalesce(p_split, '{}'));
  update crm.meta_lead_outcomes o
  set claimed_until = null
  where o.id = any(coalesce(p_release, '{}'));
end;
$$;

revoke all on function private.meta_lead_outcomes_finish(uuid[], jsonb, uuid[], uuid[], text, uuid[]) from public;
grant execute on function private.meta_lead_outcomes_finish(uuid[], jsonb, uuid[], uuid[], text, uuid[]) to crm_app;

create or replace function private.meta_outcomes_workspace_result(p_workspace uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_error is null then
    update crm.meta_outcome_settings s
    set last_error = null, last_error_at = null, alerted_at = null
    where s.workspace_id = p_workspace
      and s.last_error is distinct from 'Choose a pipeline in Settings › Tools.'
      and (s.last_error is not null or s.last_error_at is not null or s.alerted_at is not null);
    perform private.meta_outcomes_sync_pipeline_error(p_workspace);
  else
    update crm.meta_outcome_settings s
    set last_error = left(p_error, 500),
        last_error_at = case when s.last_error is null then now() else coalesce(s.last_error_at, now()) end
    where s.workspace_id = p_workspace;
  end if;
end;
$$;

revoke all on function private.meta_outcomes_workspace_result(uuid, text) from public;
grant execute on function private.meta_outcomes_workspace_result(uuid, text) to crm_app;

create or replace function private.meta_outcomes_alert_due()
returns table (workspace_id uuid, last_error text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  update crm.meta_outcome_settings s
  set alerted_at = now()
  where s.enabled and s.last_error is not null and s.last_error_at < now() - interval '24 hours' and s.alerted_at is null
  returning s.workspace_id, s.last_error;
end;
$$;

revoke all on function private.meta_outcomes_alert_due() from public;
grant execute on function private.meta_outcomes_alert_due() to crm_app;

create or replace function private.merge_contact_references(
  p_workspace uuid,
  p_user uuid,
  p_agent uuid,
  p_keep uuid,
  p_merge uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  keep_row crm.contacts%rowtype;
  merge_row crm.contacts%rowtype;
  moved jsonb := '{}'::jsonb;
  target text;
  calendar_replaced integer;
  calendar_shared integer;
  marks integer;
  follow_ups integer;
  routes integer;
  links_dropped integer;
  links_moved integer;
  prospect record;
  prospects_combined integer := 0;
  suppressions_moved integer;
  prospects_stopped integer;
  merged_emails text[];
  merged_linkedins text[];
  stop_reason_for_duplicate text;
begin
  perform private.merge_actor_check(p_workspace, p_user, p_agent);
  if p_keep = p_merge then
    raise exception 'Pick a different person to merge into.' using errcode = '22023';
  end if;
  perform 1 from crm.contacts c
    where c.workspace_id = p_workspace and c.id in (p_keep, p_merge)
    order by c.id
    for update;
  select * into keep_row from crm.contacts c where c.id = p_keep and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The person to keep isn''t in this workspace.' using errcode = 'P0002';
  end if;
  select * into merge_row from crm.contacts c where c.id = p_merge and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The person to merge isn''t in this workspace.' using errcode = 'P0002';
  end if;
  if keep_row.archived_at is not null then
    raise exception '% is archived, so they can''t be merged into.',
      coalesce(nullif(trim(concat_ws(' ', keep_row.first_name, keep_row.last_name)), ''), keep_row.email, 'This person')
      using errcode = '22023';
  end if;
  if merge_row.archived_at is not null then
    raise exception '% is already archived, so they can''t be merged.',
      coalesce(nullif(trim(concat_ws(' ', merge_row.first_name, merge_row.last_name)), ''), merge_row.email, 'This person')
      using errcode = '22023';
  end if;

  perform set_config('orbit.merging', 'on', true);

  foreach target in array array[
    'tasks', 'activities', 'email_messages', 'call_records', 'call_insights',
    'conversation_imports', 'workflow_runs', 'documents'
  ] loop
    moved := moved || jsonb_build_object(target, private.merge_move(target, 'contact_id', p_workspace, p_merge, p_keep));
  end loop;
  moved := moved || jsonb_build_object('task_series', private.merge_move('task_series', 'contact_id', p_workspace, p_merge, p_keep));
  moved := moved || jsonb_build_object(
    'opportunities', private.merge_move('opportunities', 'primary_contact_id', p_workspace, p_merge, p_keep)
  );

  with changed as (
    update crm.calendar_events e
    set contact_ids = array_replace(e.contact_ids, p_merge, p_keep)
    where e.workspace_id = p_workspace and p_merge = any(e.contact_ids) and not (p_keep = any(e.contact_ids))
    returning e.id
  )
  select count(*)::integer into calendar_replaced from changed;
  with changed as (
    update crm.calendar_events e
    set contact_ids = array_remove(e.contact_ids, p_merge)
    where e.workspace_id = p_workspace and p_merge = any(e.contact_ids)
    returning e.id
  )
  select count(*)::integer into calendar_shared from changed;

  with changed as (
    update crm.workflow_record_marks m
    set record_id = p_keep
    where m.workspace_id = p_workspace and m.record_id = p_merge
      and not exists (
        select 1 from crm.workflow_record_marks k
        where k.workflow_id = m.workflow_id and k.record_id = p_keep
      )
    returning m.workflow_id
  )
  select count(*)::integer into marks from changed;

  update crm.follow_up_suggestions f set contact_id = p_keep where f.contact_id = p_merge;
  get diagnostics follow_ups = row_count;
  update crm.mail_thread_routes r set contact_id = p_keep where r.contact_id = p_merge;
  get diagnostics routes = row_count;

  merged_emails := array_remove(array[keep_row.normalized_email, merge_row.normalized_email], null);
  merged_linkedins := array_remove(array[keep_row.normalized_linkedin, merge_row.normalized_linkedin], null);
  if exists (
    select 1 from crm.suppressions s
    where s.workspace_id = p_workspace and s.reason <> 'bounced'
      and (s.contact_id in (p_keep, p_merge) or (s.kind = 'email' and s.value = any(merged_emails)) or (s.kind = 'linkedin' and s.value = any(merged_linkedins)))
  ) then
    stop_reason_for_duplicate := 'suppressed';
  elsif exists (
    select 1 from crm.campaign_prospects p
    where p.workspace_id = p_workspace and p.replied_at is not null
      and (p.contact_id in (p_keep, p_merge) or p.email = any(merged_emails) or p.linkedin = any(merged_linkedins))
  ) then
    stop_reason_for_duplicate := 'replied';
  end if;

  for prospect in
    select dup.id as merge_id, kept.id as keep_id, dup.replied_at, dup.last_event_at, dup.external_lead_id, dup.email, dup.linkedin,
      dup.stop_requested_at, dup.stopped_at, dup.stop_reason,
      dup.state in ('pushing', 'pushed') and private.campaign_prospect_active(dup.state, dup.stopped_at, dup.lead_status, k.status) as live
    from crm.campaign_prospects dup
    join crm.campaigns k on k.id = dup.campaign_id
    join crm.campaign_prospects kept
      on kept.campaign_id = dup.campaign_id and kept.contact_id = p_keep and kept.workspace_id = p_workspace
    where dup.workspace_id = p_workspace and dup.contact_id = p_merge
    order by dup.id
    for update of dup, kept
  loop
    if stop_reason_for_duplicate is not null and prospect.live and prospect.replied_at is null then
      update crm.campaign_messages m set prospect_id = prospect.keep_id where m.prospect_id = prospect.merge_id;
      update crm.campaign_prospects d
      set contact_id = null,
          stop_requested_at = coalesce(d.stop_requested_at, now()),
          stop_reason = coalesce(d.stop_reason, stop_reason_for_duplicate)
      where d.id = prospect.merge_id;
      update crm.campaign_prospects k
      set replied_at = case
            when k.replied_at is null then prospect.replied_at
            when prospect.replied_at is null then k.replied_at
            else least(k.replied_at, prospect.replied_at)
          end,
          email = coalesce(k.email, prospect.email),
          linkedin = coalesce(k.linkedin, prospect.linkedin)
      where k.id = prospect.keep_id;
      prospects_combined := prospects_combined + 1;
      continue;
    end if;
    update crm.campaign_events e set prospect_id = prospect.keep_id where e.prospect_id = prospect.merge_id;
    update crm.campaign_messages m set prospect_id = prospect.keep_id where m.prospect_id = prospect.merge_id;
    update crm.campaign_prospects k
    set replied_at = case
          when k.replied_at is null then prospect.replied_at
          when prospect.replied_at is null then k.replied_at
          else least(k.replied_at, prospect.replied_at)
        end,
        last_event_at = greatest(k.last_event_at, prospect.last_event_at),
        stop_requested_at = case
          when prospect.stop_requested_at is not null and prospect.stopped_at is null and k.stopped_at is null
            then coalesce(k.stop_requested_at, prospect.stop_requested_at)
          else k.stop_requested_at
        end,
        stop_reason = case
          when prospect.stop_requested_at is not null and prospect.stopped_at is null and k.stopped_at is null
            then coalesce(k.stop_reason, prospect.stop_reason)
          else k.stop_reason
        end
    where k.id = prospect.keep_id;
    delete from crm.campaign_prospects d where d.id = prospect.merge_id;
    update crm.campaign_prospects k
    set external_lead_id = coalesce(k.external_lead_id, prospect.external_lead_id),
        email = coalesce(k.email, prospect.email),
        linkedin = coalesce(k.linkedin, prospect.linkedin)
    where k.id = prospect.keep_id
      and (k.external_lead_id is null or k.email is null or k.linkedin is null);
    prospects_combined := prospects_combined + 1;
  end loop;
  moved := moved || jsonb_build_object(
    'campaign_prospects', private.merge_move('campaign_prospects', 'contact_id', p_workspace, p_merge, p_keep)
  );

  update crm.suppressions s set contact_id = p_keep
  where s.workspace_id = p_workspace
    and (
      s.contact_id = p_merge
      or (
        s.contact_id is null and s.reason <> 'bounced'
        and ((s.kind = 'email' and s.value = merge_row.normalized_email) or (s.kind = 'linkedin' and s.value = merge_row.normalized_linkedin))
      )
    );
  get diagnostics suppressions_moved = row_count;

  delete from crm.page_links l
  where l.target_kind = 'contact' and l.target_record_id = p_merge
    and exists (
      select 1 from crm.page_links k
      where k.page_id = l.page_id and k.target_kind = 'contact' and k.target_record_id = p_keep
    );
  get diagnostics links_dropped = row_count;
  update crm.page_links l
  set target_record_id = p_keep
  where l.target_kind = 'contact' and l.target_record_id = p_merge;
  get diagnostics links_moved = row_count;

  prospects_stopped := private.campaign_stop_merged_person(
    p_workspace, p_keep,
    array_remove(array[keep_row.normalized_email, merge_row.normalized_email], null),
    array_remove(array[keep_row.normalized_linkedin, merge_row.normalized_linkedin], null)
  );

  update crm.meta_leads l set contact_id = p_keep where l.contact_id = p_merge;

  perform set_config('orbit.merging', 'off', true);

  return moved || jsonb_build_object(
    'calendar_events', calendar_replaced,
    'calendar_events_shared', calendar_shared,
    'workflow_record_marks', marks,
    'follow_up_suggestions', follow_ups,
    'mail_thread_routes', routes,
    'page_links', links_dropped + links_moved,
    'campaign_prospects_combined', prospects_combined,
    'suppressions', suppressions_moved,
    'campaign_prospects_stopped', prospects_stopped
  );
end;
$$;

create or replace function private.merge_company_references(
  p_workspace uuid,
  p_user uuid,
  p_agent uuid,
  p_keep uuid,
  p_merge uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  keep_row crm.companies%rowtype;
  merge_row crm.companies%rowtype;
  moved jsonb := '{}'::jsonb;
  target text;
  calendar_replaced integer;
  calendar_shared integer;
  marks integer;
  web_state text := 'none';
  ai_winners uuid[];
  ai_moved integer;
  follow_ups integer;
  links_dropped integer;
  links_moved integer;
  card record;
  combined jsonb := '[]'::jsonb;
begin
  perform private.merge_actor_check(p_workspace, p_user, p_agent);
  if p_keep = p_merge then
    raise exception 'Pick a different company to merge into.' using errcode = '22023';
  end if;
  perform 1 from crm.companies c
    where c.workspace_id = p_workspace and c.id in (p_keep, p_merge)
    order by c.id
    for update;
  select * into keep_row from crm.companies c where c.id = p_keep and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The company to keep isn''t in this workspace.' using errcode = 'P0002';
  end if;
  select * into merge_row from crm.companies c where c.id = p_merge and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The company to merge isn''t in this workspace.' using errcode = 'P0002';
  end if;
  if keep_row.archived_at is not null then
    raise exception '% is archived, so it can''t be merged into.', keep_row.name using errcode = '22023';
  end if;
  if merge_row.archived_at is not null then
    raise exception '% is already archived, so it can''t be merged.', merge_row.name using errcode = '22023';
  end if;

  perform set_config('orbit.merging', 'on', true);

  for card in
    select dup.id as dup_id, kept.id as kept_id, dup.pipeline_id
    from crm.opportunities dup
    join crm.pipelines p on p.id = dup.pipeline_id and p.kind = 'board'
    join lateral (
      select k.id from crm.opportunities k
      where k.workspace_id = p_workspace and k.pipeline_id = dup.pipeline_id
        and k.company_id = p_keep and k.archived_at is null
      order by k.created_at, k.id
      limit 1
    ) kept on true
    where dup.workspace_id = p_workspace and dup.company_id = p_merge and dup.archived_at is null
    order by dup.created_at, dup.id
  loop
    update crm.activities set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.tasks set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.task_series set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.documents set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.opportunities set archived_at = now() where id = card.dup_id;
    combined := combined || jsonb_build_array(jsonb_build_object(
      'id', card.dup_id, 'keptId', card.kept_id, 'pipelineId', card.pipeline_id
    ));
  end loop;

  foreach target in array array[
    'contacts', 'opportunities', 'tasks', 'activities', 'email_messages', 'call_records',
    'call_insights', 'conversation_imports', 'workflow_runs', 'documents', 'memories',
    'market_notes', 'watchlist', 'knowledge_items', 'company_signals'
  ] loop
    moved := moved || jsonb_build_object(target, private.merge_move(target, 'company_id', p_workspace, p_merge, p_keep));
  end loop;
  moved := moved || jsonb_build_object('task_series', private.merge_move('task_series', 'company_id', p_workspace, p_merge, p_keep));
  moved := moved || jsonb_build_object('campaign_prospects', private.merge_move('campaign_prospects', 'company_id', p_workspace, p_merge, p_keep));

  with changed as (
    update crm.calendar_events e
    set company_ids = array_replace(e.company_ids, p_merge, p_keep)
    where e.workspace_id = p_workspace and p_merge = any(e.company_ids) and not (p_keep = any(e.company_ids))
    returning e.id
  )
  select count(*)::integer into calendar_replaced from changed;
  with changed as (
    update crm.calendar_events e
    set company_ids = array_remove(e.company_ids, p_merge)
    where e.workspace_id = p_workspace and p_merge = any(e.company_ids)
    returning e.id
  )
  select count(*)::integer into calendar_shared from changed;

  with changed as (
    update crm.workflow_record_marks m
    set record_id = p_keep
    where m.workspace_id = p_workspace and m.record_id = p_merge
      and not exists (
        select 1 from crm.workflow_record_marks k
        where k.workflow_id = m.workflow_id and k.record_id = p_keep
      )
    returning m.workflow_id
  )
  select count(*)::integer into marks from changed;

  update crm.follow_up_suggestions f set company_id = p_keep where f.company_id = p_merge;
  get diagnostics follow_ups = row_count;

  select coalesce(array_agg(m.field_id), '{}'::uuid[])
  into ai_winners
  from crm.ai_field_answers m
  left join crm.ai_field_answers k on k.field_id = m.field_id and k.company_id = p_keep
  where m.company_id = p_merge
    and m.workspace_id = p_workspace
    and (case when m.manual then 3 when m.state = 'answered' then 2 else 1 end)
      > (case when k.field_id is null then 0 when k.manual then 3 when k.state = 'answered' then 2 else 1 end);
  delete from crm.ai_field_answers k
  where k.company_id = p_keep and k.field_id = any(ai_winners);
  update crm.ai_field_answers m
  set company_id = p_keep
  where m.company_id = p_merge and m.field_id = any(ai_winners);
  get diagnostics ai_moved = row_count;

  delete from crm.page_links l
  where l.target_kind = 'company' and l.target_record_id = p_merge
    and exists (
      select 1 from crm.page_links k
      where k.page_id = l.page_id and k.target_kind = 'company' and k.target_record_id = p_keep
    );
  get diagnostics links_dropped = row_count;
  update crm.page_links l
  set target_record_id = p_keep
  where l.target_kind = 'company' and l.target_record_id = p_merge;
  get diagnostics links_moved = row_count;

  if exists (select 1 from crm.company_web_state w where w.company_id = p_merge) then
    if exists (select 1 from crm.company_web_state w where w.company_id = p_keep) then
      web_state := 'kept';
    else
      update crm.company_web_state set company_id = p_keep where company_id = p_merge;
      web_state := 'moved';
    end if;
  end if;

  update crm.meta_leads l set company_id = p_keep where l.company_id = p_merge;

  perform set_config('orbit.merging', 'off', true);

  return moved || jsonb_build_object(
    'calendar_events', calendar_replaced,
    'calendar_events_shared', calendar_shared,
    'workflow_record_marks', marks,
    'company_web_state', web_state,
    'ai_field_answers', ai_moved,
    'follow_up_suggestions', follow_ups,
    'page_links', links_dropped + links_moved,
    'combined_cards', combined
  );
end;
$$;

create or replace function private.move_records_to_workspace(
  p_user uuid,
  p_source uuid,
  p_target uuid,
  p_input jsonb,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_copy boolean := coalesce((p_input ->> 'copy')::boolean, false);
  v_copy_deals boolean := coalesce((p_input ->> 'copyDeals')::boolean, false);
  v_include_company boolean := coalesce((p_input ->> 'includeCompany')::boolean, false);
  v_include_contacts boolean := coalesce((p_input ->> 'includeContacts')::boolean, true);
  v_company_ids uuid[];
  v_contact_ids uuid[];
  v_pipeline uuid := nullif(p_input ->> 'pipelineId', '')::uuid;
  v_stage uuid := nullif(p_input ->> 'stageId', '')::uuid;
  v_pipeline_kind text;
  v_pipeline_name text;
  v_source_name text;
  v_target_name text;
  v_missing integer;
  v_conflict text;
  v_proposal_conflict text;
  v_campaign_conflict text;
  v_link record;
  v_match uuid;
  v_now timestamptz := now();
  v_source_role text;
  v_can_move boolean;
  v_result jsonb;
  v_task_moves jsonb := '[]'::jsonb;
  v_tasks_left jsonb := '[]'::jsonb;
begin
  select coalesce(array_agg(distinct value::uuid), '{}') into v_company_ids
  from jsonb_array_elements_text(coalesce(p_input -> 'companyIds', '[]'::jsonb));
  select coalesce(array_agg(distinct value::uuid), '{}') into v_contact_ids
  from jsonb_array_elements_text(coalesce(p_input -> 'contactIds', '[]'::jsonb));

  if p_source = p_target then
    raise exception 'Pick another workspace.' using errcode = '22023';
  end if;
  select w.name, m.role into v_source_name, v_source_role
  from crm.workspaces w
  join crm.workspace_members m on m.workspace_id = w.id and m.user_id = p_user
  where w.id = p_source;
  if not found then
    raise exception 'You''re not in that workspace.' using errcode = '42501';
  end if;
  select w.name into v_target_name
  from crm.workspaces w
  join crm.workspace_members m on m.workspace_id = w.id and m.user_id = p_user
  where w.id = p_target;
  if not found then
    raise exception 'You''re not in that workspace.' using errcode = '42501';
  end if;
  v_can_move := v_source_role in ('owner', 'admin');
  if not v_copy and not v_can_move and not p_dry_run then
    raise exception 'Only an owner or admin of % can move records out of it. You can copy them instead.', v_source_name using errcode = '42501';
  end if;
  if cardinality(v_company_ids) + cardinality(v_contact_ids) = 0 then
    raise exception 'Pick a company or contact to move.' using errcode = '22023';
  end if;
  if cardinality(v_company_ids) + cardinality(v_contact_ids) > 100 then
    raise exception 'Move up to 100 records at a time.' using errcode = '22023';
  end if;

  perform 1 from crm.companies c where c.id = any(v_company_ids) order by c.id for update;
  perform 1 from crm.contacts c where c.id = any(v_contact_ids) order by c.id for update;

  select count(*) into v_missing
  from unnest(v_company_ids) as wanted(id)
  where not exists (
    select 1 from crm.companies c where c.id = wanted.id and c.workspace_id = p_source and c.archived_at is null
  );
  if v_missing > 0 then
    raise exception 'Some of these companies aren''t in %, or are archived.', v_source_name using errcode = 'P0002';
  end if;
  select count(*) into v_missing
  from unnest(v_contact_ids) as wanted(id)
  where not exists (
    select 1 from crm.contacts c where c.id = wanted.id and c.workspace_id = p_source and c.archived_at is null
  );
  if v_missing > 0 then
    raise exception 'Some of these people aren''t in %, or are archived.', v_source_name using errcode = 'P0002';
  end if;

  create temporary table if not exists orbit_move_map (
    kind text not null,
    old_id uuid not null,
    new_id uuid,
    merged boolean not null default false,
    stage_id uuid,
    primary key (kind, old_id)
  ) on commit drop;
  delete from pg_temp.orbit_move_map;

  insert into pg_temp.orbit_move_map (kind, old_id)
  select 'company', id from unnest(v_company_ids) as id
  on conflict do nothing;

  for v_link in
    select distinct c.company_id
    from crm.contacts c
    where c.id = any(v_contact_ids)
      and c.company_id is not null
      and not (c.company_id = any(v_company_ids))
  loop
    v_match := case when v_include_company then null else private.move_company_match(v_link.company_id, p_target) end;
    if v_include_company then
      insert into pg_temp.orbit_move_map (kind, old_id)
      values ('company', v_link.company_id)
      on conflict do nothing;
    elsif v_match is not null then
      insert into pg_temp.orbit_move_map (kind, old_id, new_id, merged)
      values ('company_link', v_link.company_id, v_match, true);
    elsif exists (
      select 1 from crm.contacts o
      where o.workspace_id = p_source
        and o.company_id = v_link.company_id
        and o.archived_at is null
        and not (o.id = any(v_contact_ids))
    ) then
      insert into pg_temp.orbit_move_map (kind, old_id, new_id, merged)
      values ('company_link', v_link.company_id, gen_random_uuid(), false);
    else
      insert into pg_temp.orbit_move_map (kind, old_id)
      values ('company', v_link.company_id)
      on conflict do nothing;
    end if;
  end loop;

  update pg_temp.orbit_move_map m
  set new_id = coalesce(found.match, case when v_copy then gen_random_uuid() else m.old_id end),
      merged = found.match is not null
  from (
    select item.old_id, private.move_company_match(item.old_id, p_target) as match
    from pg_temp.orbit_move_map item
    where item.kind = 'company'
  ) found
  where m.kind = 'company' and m.old_id = found.old_id;

  insert into pg_temp.orbit_move_map (kind, old_id)
  select 'contact', id from unnest(v_contact_ids) as id
  on conflict do nothing;
  insert into pg_temp.orbit_move_map (kind, old_id)
  select 'contact', c.id
  from crm.contacts c
  where c.workspace_id = p_source
    and c.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
    and (not v_copy or c.archived_at is null)
    and (v_include_contacts or not (c.company_id = any(v_company_ids)))
  on conflict do nothing;

  if not v_copy then
    insert into pg_temp.orbit_move_map (kind, old_id)
    select distinct 'proposal_contact', c.id
    from crm.documents d
    join crm.contacts c on c.id = d.contact_id
    where d.workspace_id = p_source
      and d.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
      and c.workspace_id = p_source
      and not exists (select 1 from pg_temp.orbit_move_map item where item.kind = 'contact' and item.old_id = c.id)
    on conflict do nothing;
    insert into pg_temp.orbit_move_map (kind, old_id)
    select 'contact', m.old_id from pg_temp.orbit_move_map m where m.kind = 'proposal_contact'
    on conflict do nothing;
    for v_link in
      select distinct c.company_id
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      where m.kind = 'proposal_contact'
        and c.company_id is not null
        and not exists (
          select 1 from pg_temp.orbit_move_map item where item.kind in ('company', 'company_link') and item.old_id = c.company_id
        )
    loop
      v_match := private.move_company_match(v_link.company_id, p_target);
      insert into pg_temp.orbit_move_map (kind, old_id, new_id, merged)
      values ('company_link', v_link.company_id, coalesce(v_match, gen_random_uuid()), v_match is not null);
    end loop;
  end if;

  if not v_include_contacts then
    insert into pg_temp.orbit_move_map (kind, old_id)
    select 'contact_stay', c.id
    from crm.contacts c
    where c.workspace_id = p_source
      and c.company_id = any(v_company_ids)
      and not exists (select 1 from pg_temp.orbit_move_map item where item.kind = 'contact' and item.old_id = c.id)
    on conflict do nothing;
  end if;

  update pg_temp.orbit_move_map m
  set new_id = coalesce(found.match, case when v_copy then gen_random_uuid() else m.old_id end),
      merged = found.match is not null
  from (
    select item.old_id, private.move_contact_match(item.old_id, p_target) as match
    from pg_temp.orbit_move_map item
    where item.kind = 'contact'
  ) found
  where m.kind = 'contact' and m.old_id = found.old_id;

  insert into pg_temp.orbit_move_map (kind, old_id, new_id)
  select
    case when p.kind = 'board' then 'board_card' else 'deal' end,
    o.id,
    case when p.kind = 'board' then null when v_copy then gen_random_uuid() else o.id end
  from crm.opportunities o
  left join crm.pipelines p on p.id = o.pipeline_id
  where o.workspace_id = p_source
    and o.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
    and (not v_copy or (v_copy_deals and o.archived_at is null and coalesce(p.kind, 'sales') <> 'board'));

  if exists (select 1 from pg_temp.orbit_move_map m where m.kind = 'deal') or p_dry_run then
    if v_pipeline is null then
      select p.id into v_pipeline
      from crm.pipelines p
      where p.workspace_id = p_target and p.archived_at is null
      order by p.is_default desc, (p.kind = 'sales') desc, p.position, p.created_at
      limit 1;
    end if;
    select p.kind, p.name into v_pipeline_kind, v_pipeline_name
    from crm.pipelines p
    where p.id = v_pipeline and p.workspace_id = p_target and p.archived_at is null;
    if not found and exists (select 1 from pg_temp.orbit_move_map m where m.kind = 'deal') then
      raise exception 'Pick where the deals go in %.', v_target_name using errcode = '22023';
    end if;
    if v_stage is not null and not exists (
      select 1 from crm.pipeline_stages s where s.id = v_stage and s.pipeline_id = v_pipeline
    ) then
      raise exception 'Pick a stage on %.', coalesce(v_pipeline_name, 'that board') using errcode = '22023';
    end if;
    if exists (select 1 from pg_temp.orbit_move_map m where m.kind = 'deal')
      and not exists (select 1 from crm.pipeline_stages s where s.pipeline_id = v_pipeline) then
      raise exception '% has no stages.', v_pipeline_name using errcode = '22023';
    end if;
  end if;

  update pg_temp.orbit_move_map m
  set stage_id = private.move_deal_stage(o.stage_id, o.status, v_pipeline, v_stage)
  from crm.opportunities o
  where m.kind = 'deal' and o.id = m.old_id;

  if v_pipeline_kind = 'board' then
    select s.name into v_conflict
    from pg_temp.orbit_move_map mc
    join crm.companies s on s.id = mc.old_id
    where mc.kind = 'company'
      and (
        select count(*) from pg_temp.orbit_move_map d
        join crm.opportunities o on o.id = d.old_id
        where d.kind = 'deal' and o.company_id = mc.old_id and o.archived_at is null
      ) + (
        select count(*) from crm.opportunities e
        where e.workspace_id = p_target and e.pipeline_id = v_pipeline and e.company_id = mc.new_id and e.archived_at is null
      ) > 1
    limit 1;
    if v_conflict is not null and not p_dry_run then
      raise exception '% would have more than one card on %. Put the deals on a pipeline instead.', v_conflict, v_pipeline_name using errcode = '22023';
    end if;
  end if;

  insert into pg_temp.orbit_move_map (kind, old_id, new_id)
  select 'activity', a.id, case when v_copy then gen_random_uuid() else a.id end
  from crm.activities a
  where a.workspace_id = p_source
    and (not v_copy or a.archived_at is null)
    and (v_copy or not exists (select 1 from pg_temp.orbit_move_map s where s.kind = 'contact_stay' and s.old_id = a.contact_id))
    and (
      a.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
      or a.contact_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'contact')
      or a.opportunity_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind in ('deal', 'board_card'))
    );

  if not v_copy then
    insert into pg_temp.orbit_move_map (kind, old_id, new_id)
    select 'task', t.id, t.id
    from crm.tasks t
    where t.workspace_id = p_source
      and not exists (select 1 from pg_temp.orbit_move_map s where s.kind = 'contact_stay' and s.old_id = t.contact_id)
      and (
        t.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
        or t.contact_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'contact')
        or t.opportunity_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind in ('deal', 'board_card'))
      );
    insert into pg_temp.orbit_move_map (kind, old_id, new_id)
    select 'document', d.id, d.id
    from crm.documents d
    where d.workspace_id = p_source
      and (
        d.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
        or (
          d.contact_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'contact')
          and d.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company_link')
        )
      );
    select format(
      '%s is named on the %s%s %s ''%s''. Move %s too, or change the %s''s contact first.',
      coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Someone'),
      case when d.archived_at is not null then 'archived ' else '' end,
      co.name,
      case when d.kind = 'nda' then 'NDA' else 'proposal' end,
      d.title,
      co.name,
      case when d.kind = 'nda' then 'NDA' else 'proposal' end
    ) into v_proposal_conflict
    from crm.documents d
    join pg_temp.orbit_move_map m on m.kind = 'contact' and m.old_id = d.contact_id
    join crm.contacts c on c.id = d.contact_id
    join crm.companies co on co.id = d.company_id
    where d.workspace_id = p_source
      and not exists (select 1 from pg_temp.orbit_move_map item where item.kind = 'document' and item.old_id = d.id)
    order by d.archived_at is not null, co.name, d.title, d.id
    limit 1;
    if v_proposal_conflict is not null and not p_dry_run then
      raise exception '%', v_proposal_conflict using errcode = '22023';
    end if;
    select format(
      '%s is in %s. Remove them from campaigns first.',
      coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Someone'),
      coalesce(nullif(k.name, ''), 'a campaign')
    ) into v_campaign_conflict
    from pg_temp.orbit_move_map m
    join crm.campaign_prospects p on p.contact_id = m.old_id and p.workspace_id = p_source
    join crm.campaigns k on k.id = p.campaign_id
    join crm.contacts c on c.id = m.old_id
    where m.kind = 'contact'
      and private.campaign_prospect_active(p.state, p.stopped_at, p.lead_status, k.status)
    order by c.first_name, c.last_name, k.name, p.id
    limit 1;
    if v_campaign_conflict is not null and not p_dry_run then
      raise exception '%', v_campaign_conflict using errcode = '22023';
    end if;
    insert into pg_temp.orbit_move_map (kind, old_id, new_id)
    select 'knowledge', k.id, k.id
    from crm.knowledge_items k
    where k.workspace_id = p_source
      and k.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company');
  end if;

  v_result := jsonb_build_object(
    'source', jsonb_build_object('id', p_source, 'name', v_source_name),
    'target', jsonb_build_object('id', p_target, 'name', v_target_name),
    'copy', v_copy,
    'companies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.old_id, 'name', c.name, 'targetId', m.new_id, 'merged', m.merged,
        'targetName', t.name, 'selected', m.old_id = any(v_company_ids),
        'deals', coalesce((
          select jsonb_agg(jsonb_build_object('id', o.id, 'targetId', d.new_id, 'name', o.name, 'stage', st.name) order by o.name)
          from pg_temp.orbit_move_map d
          join crm.opportunities o on o.id = d.old_id
          left join crm.pipeline_stages st on st.id = d.stage_id
          where d.kind = 'deal' and o.company_id = m.old_id
        ), '[]'::jsonb),
        'boardCards', (
          select count(*) from pg_temp.orbit_move_map d
          join crm.opportunities o on o.id = d.old_id
          where d.kind = 'board_card' and o.company_id = m.old_id
        )
      ) order by c.name)
      from pg_temp.orbit_move_map m
      join crm.companies c on c.id = m.old_id
      left join crm.companies t on t.id = m.new_id and m.merged
      where m.kind = 'company'
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.old_id, 'name', c.name, 'targetId', m.new_id, 'merged', m.merged, 'targetName', coalesce(t.name, c.name)
      ) order by c.name)
      from pg_temp.orbit_move_map m
      join crm.companies c on c.id = m.old_id
      left join crm.companies t on t.id = m.new_id and m.merged
      where m.kind = 'company_link'
    ), '[]'::jsonb),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.old_id,
        'name', coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Unnamed'),
        'targetId', m.new_id, 'merged', m.merged,
        'targetName', coalesce(nullif(btrim(concat_ws(' ', t.first_name, t.last_name)), ''), t.email),
        'selected', m.old_id = any(v_contact_ids),
        'archived', c.archived_at is not null,
        'companyId', c.company_id
      ) order by c.first_name, c.last_name)
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      left join crm.contacts t on t.id = m.new_id and m.merged
      where m.kind = 'contact'
    ), '[]'::jsonb),
    'deals', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'deal'),
    'dealsAvailable', (
      select count(*) from crm.opportunities o
      left join crm.pipelines p on p.id = o.pipeline_id
      where o.workspace_id = p_source and o.archived_at is null and coalesce(p.kind, 'sales') <> 'board'
        and o.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
    ),
    'dealStages', coalesce((
      select jsonb_agg(distinct s.name)
      from crm.opportunities o
      left join crm.pipelines p on p.id = o.pipeline_id
      join crm.pipeline_stages s on s.id = o.stage_id
      where o.workspace_id = p_source and o.archived_at is null and coalesce(p.kind, 'sales') <> 'board'
        and o.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
    ), '[]'::jsonb),
    'boardCards', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'board_card'),
    'boards', coalesce((
      select jsonb_agg(distinct p.name)
      from pg_temp.orbit_move_map m
      join crm.opportunities o on o.id = m.old_id
      join crm.pipelines p on p.id = o.pipeline_id
      where m.kind = 'board_card' and o.archived_at is null
    ), '[]'::jsonb),
    'activities', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'activity'),
    'tasks', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'task'),
    'clickupTasks', (
      select count(*) from pg_temp.orbit_move_map m join crm.tasks ct on ct.id = m.old_id
      where m.kind = 'task' and ct.clickup_task_id is not null and ct.archived_at is null
    ),
    'documents', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'document'),
    'knowledge', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'knowledge'),
    'pipelineId', v_pipeline,
    'pipelineName', v_pipeline_name,
    'pipelineKind', v_pipeline_kind,
    'stageName', (select s.name from crm.pipeline_stages s where s.id = v_stage),
    'canMove', v_can_move,
    'boardConflict', v_conflict,
    'proposalConflict', v_proposal_conflict,
    'campaignConflict', v_campaign_conflict,
    'includeCompany', v_include_company,
    'includeContacts', v_include_contacts,
    'contactCompanies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', co.id,
        'name', co.name,
        'others', (
          select count(*) from crm.contacts o
          where o.workspace_id = p_source and o.company_id = co.id and (not v_copy or o.archived_at is null)
            and not (o.id = any(v_contact_ids))
        )
      ) order by co.name)
      from crm.companies co
      where co.workspace_id = p_source
        and not (co.id = any(v_company_ids))
        and co.id in (select c.company_id from crm.contacts c where c.id = any(v_contact_ids))
    ), '[]'::jsonb),
    'companyContacts', (
      select count(*) from crm.contacts o
      where o.workspace_id = p_source and o.company_id = any(v_company_ids) and (not v_copy or o.archived_at is null)
        and not (o.id = any(v_contact_ids))
    ),
    'leftBehind', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Unnamed'),
        'companyId', c.company_id,
        'archived', c.archived_at is not null
      ) order by c.first_name, c.last_name)
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      where m.kind = 'contact_stay' and not v_copy
    ), '[]'::jsonb),
    'notCopied', coalesce((
      select jsonb_agg(coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Unnamed') order by c.first_name, c.last_name)
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      where m.kind = 'contact_stay' and v_copy and c.archived_at is null
    ), '[]'::jsonb),
    'proposalContacts', coalesce((
      select jsonb_agg(coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Unnamed') order by c.first_name, c.last_name)
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      where m.kind = 'proposal_contact'
    ), '[]'::jsonb),
    'dealsLosingContact', (
      select count(*) from pg_temp.orbit_move_map d
      join crm.opportunities o on o.id = d.old_id
      join pg_temp.orbit_move_map s on s.kind = 'contact_stay' and s.old_id = o.primary_contact_id
      where d.kind = 'deal'
    )
  );

  if p_dry_run then
    return v_result;
  end if;

  perform set_config('orbit.merging', 'on', true);

  if not v_copy then
    update crm.companies c
    set workspace_id = p_target,
        owner_id = private.move_owner(c.owner_id, p_target, p_user),
        archived_at = case when m.merged then v_now else c.archived_at end
    from pg_temp.orbit_move_map m
    where m.kind = 'company' and m.old_id = c.id;

    update crm.contacts p
    set company_id = null
    from pg_temp.orbit_move_map m
    where m.kind = 'contact_stay' and m.old_id = p.id and p.workspace_id = p_source;
  end if;

  insert into crm.companies (
    id, workspace_id, name, normalized_name, domain, website, description, industry, size_category,
    lifecycle, owner_id, source, source_reference, created_by_user_id, tags, linkedin_url, phone,
    address, logo_url, enriched_at, brand, archived_at
  )
  select
    m.new_id, p_target, c.name, c.normalized_name, c.domain, c.website, c.description, c.industry, c.size_category,
    c.lifecycle, private.move_owner(c.owner_id, p_target, p_user), c.source, c.source_reference, p_user, c.tags,
    c.linkedin_url, c.phone, c.address, c.logo_url, c.enriched_at, c.brand, c.archived_at
  from pg_temp.orbit_move_map m
  join crm.companies c on c.id = m.old_id
  where not m.merged and (m.kind = 'company_link' or (v_copy and m.kind = 'company'));

  if not v_copy then
    update crm.contacts p
    set workspace_id = p_target,
        company_id = (
          select mc.new_id from pg_temp.orbit_move_map mc
          where mc.kind in ('company', 'company_link') and mc.old_id = p.company_id
        ),
        owner_id = private.move_owner(p.owner_id, p_target, p_user),
        archived_at = case when m.merged then coalesce(p.archived_at, v_now) else p.archived_at end
    from pg_temp.orbit_move_map m
    where m.kind = 'contact' and m.old_id = p.id;
  else
    insert into crm.contacts (
      id, workspace_id, company_id, first_name, last_name, email, normalized_email, phone, job_title,
      linkedin_url, normalized_linkedin, owner_id, source, source_reference, notes, created_by_user_id,
      tags, location, sales_navigator_url
    )
    select
      m.new_id, p_target,
      (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind in ('company', 'company_link') and mc.old_id = p.company_id),
      p.first_name, p.last_name, p.email, p.normalized_email, p.phone, p.job_title,
      p.linkedin_url, p.normalized_linkedin, private.move_owner(p.owner_id, p_target, p_user), p.source,
      p.source_reference, p.notes, p_user, p.tags, p.location, p.sales_navigator_url
    from pg_temp.orbit_move_map m
    join crm.contacts p on p.id = m.old_id
    where m.kind = 'contact' and not m.merged;
    update crm.contacts k
    set company_id = (
      select mc.new_id from pg_temp.orbit_move_map mc
      where mc.kind in ('company', 'company_link') and mc.old_id = p.company_id
    )
    from pg_temp.orbit_move_map m
    join crm.contacts p on p.id = m.old_id
    where m.kind = 'contact' and m.merged and k.id = m.new_id and k.company_id is null and p.company_id is not null;
  end if;

  if not v_copy then
    update crm.opportunities o
    set workspace_id = p_target,
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = o.company_id),
        primary_contact_id = (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = o.primary_contact_id),
        pipeline_id = v_pipeline,
        stage_id = m.stage_id,
        status = case when s.is_won then 'won' when s.is_lost then 'lost' else 'open' end,
        owner_id = private.move_owner(o.owner_id, p_target, p_user)
    from pg_temp.orbit_move_map m
    join crm.pipeline_stages s on s.id = m.stage_id
    where m.kind = 'deal' and m.old_id = o.id;

    update crm.opportunity_stage_entries e
    set workspace_id = p_target
    from pg_temp.orbit_move_map m
    where m.kind = 'deal' and m.old_id = e.opportunity_id and e.workspace_id is distinct from p_target;
  else
    insert into crm.opportunities (
      id, workspace_id, company_id, primary_contact_id, pipeline_id, stage_id, name, value, currency,
      probability, expected_close_date, owner_id, status, source, created_by_user_id
    )
    select
      m.new_id, p_target,
      (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = o.company_id),
      (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = o.primary_contact_id),
      v_pipeline, m.stage_id, o.name, o.value, o.currency, o.probability, o.expected_close_date,
      private.move_owner(o.owner_id, p_target, p_user),
      case when s.is_won then 'won' when s.is_lost then 'lost' else 'open' end,
      o.source, p_user
    from pg_temp.orbit_move_map m
    join crm.opportunities o on o.id = m.old_id
    join crm.pipeline_stages s on s.id = m.stage_id
    where m.kind = 'deal';
  end if;

  if not v_copy then
    with prior as (
      select x.id, x.owner_id, x.due_at, x.due_has_time, x.scheduled_by, x.remind_minutes,
        x.clickup_task_id, x.clickup_list_id, x.clickup_url,
        case
          when x.owner_id is null
            and (
              x.created_by_user_id is null
              or not exists (select 1 from crm.workspace_members wm where wm.workspace_id = p_target and wm.user_id = x.created_by_user_id)
            )
          then p_user
          else private.move_owner(x.owner_id, p_target, p_user)
        end as next_owner
      from pg_temp.orbit_move_map m
      join crm.tasks x on x.id = m.old_id
      where m.kind = 'task'
      for no key update of x
    ),
    moved as (
    update crm.tasks t
    set workspace_id = p_target,
        company_id = coalesce(
          (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind in ('company', 'company_link') and mc.old_id = t.company_id),
          (select mc.new_id from crm.opportunities o join pg_temp.orbit_move_map mc on mc.kind = 'company' and mc.old_id = o.company_id
           where o.id = t.opportunity_id),
          (select mc.new_id from crm.contacts p join pg_temp.orbit_move_map mc on mc.kind in ('company', 'company_link') and mc.old_id = p.company_id
           where p.id = t.contact_id and t.company_id is not null)
        ),
        contact_id = (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = t.contact_id),
        opportunity_id = (select md.new_id from pg_temp.orbit_move_map md where md.kind = 'deal' and md.old_id = t.opportunity_id),
        owner_id = h.next_owner,
        due_at = case
          when t.due_has_time and t.due_at is not null and (t.owner_id is not null and h.next_owner is distinct from t.owner_id)
          then date_trunc('day', t.due_at at time zone 'Europe/London') at time zone 'Europe/London'
          else t.due_at
        end,
        scheduled_by = case when t.due_has_time and (t.owner_id is not null and h.next_owner is distinct from t.owner_id) then null else t.scheduled_by end,
        remind_minutes = case when t.due_has_time and (t.owner_id is not null and h.next_owner is distinct from t.owner_id) then null else t.remind_minutes end,
        due_has_time = case when (t.owner_id is not null and h.next_owner is distinct from t.owner_id) then false else t.due_has_time end,
        clickup_task_id = null,
        clickup_list_id = null,
        clickup_url = null,
        clickup_error = null,
        clickup_synced_at = null,
        clickup_sync = '{}'::jsonb
    from prior h
    where h.id = t.id
    returning t.id, t.owner_id, t.due_at, t.due_has_time, t.scheduled_by, t.remind_minutes, t.clickup_task_id, t.clickup_list_id, t.clickup_url
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', moved.id,
      'before', jsonb_build_object(
        'ownerId', prior.owner_id,
        'dueAt', private.handover_instant(prior.due_at),
        'dueHasTime', coalesce(prior.due_has_time and prior.due_at is not null, false),
        'scheduledBy', prior.scheduled_by,
        'remindMinutes', prior.remind_minutes,
        'clickupTaskId', prior.clickup_task_id,
        'clickupListId', prior.clickup_list_id,
        'clickupUrl', prior.clickup_url
      ),
      'after', jsonb_build_object(
        'ownerId', moved.owner_id,
        'dueAt', private.handover_instant(moved.due_at),
        'dueHasTime', coalesce(moved.due_has_time and moved.due_at is not null, false),
        'scheduledBy', moved.scheduled_by,
        'remindMinutes', moved.remind_minutes,
        'clickupTaskId', moved.clickup_task_id,
        'clickupListId', moved.clickup_list_id,
        'clickupUrl', moved.clickup_url
      )
    )), '[]'::jsonb)
    into v_task_moves
    from moved
    join prior on prior.id = moved.id
    where moved.owner_id is distinct from prior.owner_id
      or prior.clickup_task_id is not null
      or prior.clickup_list_id is not null;

    update crm.activities a
    set workspace_id = p_target,
        company_id = coalesce(
          (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind in ('company', 'company_link') and mc.old_id = a.company_id),
          (select mc.new_id from crm.opportunities o join pg_temp.orbit_move_map mc on mc.kind = 'company' and mc.old_id = o.company_id
           where o.id = a.opportunity_id),
          (select mc.new_id from crm.contacts p join pg_temp.orbit_move_map mc on mc.kind in ('company', 'company_link') and mc.old_id = p.company_id
           where p.id = a.contact_id and a.company_id is not null)
        ),
        contact_id = (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = a.contact_id),
        opportunity_id = (select md.new_id from pg_temp.orbit_move_map md where md.kind = 'deal' and md.old_id = a.opportunity_id)
    from pg_temp.orbit_move_map m
    where m.kind = 'activity' and m.old_id = a.id;

    update crm.activities a
    set company_id = case when a.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else a.company_id end,
        opportunity_id = case when a.opportunity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card')) then null else a.opportunity_id end
    where a.workspace_id = p_source
      and (
        a.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or a.opportunity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card'))
      );

    with prior as (
      select x.id, x.company_id, x.opportunity_id
      from crm.tasks x
      where x.workspace_id = p_source
        and (
          x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
          or x.opportunity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card'))
        )
      for no key update of x
    ),
    stripped as (
    update crm.tasks t
    set company_id = case when t.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else t.company_id end,
        opportunity_id = case when t.opportunity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card')) then null else t.opportunity_id end
    from prior
    where prior.id = t.id
    returning t.id, t.company_id, t.opportunity_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', stripped.id,
      'before', jsonb_build_object('companyId', prior.company_id, 'opportunityId', prior.opportunity_id),
      'after', jsonb_build_object('companyId', stripped.company_id, 'opportunityId', stripped.opportunity_id)
    )), '[]'::jsonb)
    into v_tasks_left
    from stripped
    join prior on prior.id = stripped.id;

    update crm.companies c
    set health_activity_id = null
    where c.workspace_id = p_source
      and c.health_activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity');

    update crm.companies c
    set health_activity_id = null
    from crm.activities a
    where c.id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
      and a.id = c.health_activity_id
      and a.workspace_id <> c.workspace_id;

    update crm.activity_tones x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'activity' and m.old_id = x.activity_id;
    update crm.activity_tone_failures x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'activity' and m.old_id = x.activity_id;

    update crm.call_insights x
    set workspace_id = p_target,
        company_id = a.company_id,
        contact_id = a.contact_id
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity' and x.activity_id = m.old_id;

    update crm.follow_up_suggestions x
    set workspace_id = p_target,
        company_id = a.company_id,
        contact_id = a.contact_id
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity' and x.activity_id = m.old_id;

    update crm.call_records x
    set workspace_id = p_target,
        company_id = a.company_id,
        contact_id = a.contact_id
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity' and x.activity_id = m.old_id and x.workspace_id = p_source
      and not exists (
        select 1 from crm.call_records y where y.workspace_id = p_target and y.provider_call_id = x.provider_call_id
      );

    update crm.email_messages x
    set workspace_id = p_target,
        company_id = a.company_id,
        contact_id = a.contact_id
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity' and x.activity_id = m.old_id and x.workspace_id = p_source
      and not exists (
        select 1 from crm.email_messages y where y.workspace_id = p_target and y.provider_message_id = x.provider_message_id
      );

    update crm.conversation_imports x
    set workspace_id = p_target,
        company_id = a.company_id,
        contact_id = a.contact_id
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity' and x.activity_id = m.old_id and x.workspace_id = p_source
      and not exists (
        select 1 from crm.conversation_imports y
        where y.workspace_id = p_target and y.source = x.source and y.external_id = x.external_id
          and (x.source = 'granola' or y.user_id = x.user_id)
      );

    update crm.call_records x
    set activity_id = case when x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity') then null else x.activity_id end,
        company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end,
        contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end
    where x.workspace_id = p_source
      and (
        x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity')
        or x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );

    update crm.email_messages x
    set activity_id = case when x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity') then null else x.activity_id end,
        company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end,
        contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end
    where x.workspace_id = p_source
      and (
        x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity')
        or x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );

    update crm.conversation_imports x
    set activity_id = case when x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity') then null else x.activity_id end,
        company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end,
        contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end
    where x.workspace_id = p_source
      and (
        x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity')
        or x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );

    update crm.follow_up_suggestions x
    set company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end,
        contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end
    where x.workspace_id = p_source
      and (
        x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );

    update crm.campaign_prospects x
    set contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end,
        company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end
    where x.workspace_id = p_source
      and (
        x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
        or x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
      );

    update crm.call_insights x
    set company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end,
        contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end
    where x.workspace_id = p_source
      and (
        x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );

    update crm.documents d
    set workspace_id = p_target,
        company_id = (
          select mc.new_id from pg_temp.orbit_move_map mc
          where mc.kind in ('company', 'company_link') and mc.old_id = d.company_id
        ),
        contact_id = (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = d.contact_id),
        opportunity_id = (select md.new_id from pg_temp.orbit_move_map md where md.kind = 'deal' and md.old_id = d.opportunity_id),
        template_id = case
          when exists (select 1 from crm.document_templates t where t.id = d.template_id and t.workspace_id = p_target) then d.template_id
          else null
        end,
        owner_id = private.move_owner(d.owner_id, p_target, p_user)
    from pg_temp.orbit_move_map m
    where m.kind = 'document' and m.old_id = d.id;
    update crm.document_versions x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.document_events x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.document_files x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.document_links x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.document_signatures x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.document_steps x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.knowledge_items k
    set workspace_id = p_target,
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = k.company_id),
        source_ref = case
          when k.source_ref is not null and exists (
            select 1 from crm.knowledge_items y
            where y.workspace_id = p_target and y.source_ref = k.source_ref and y.archived_at is null
          ) then null
          else k.source_ref
        end
    from pg_temp.orbit_move_map m
    where m.kind = 'knowledge' and m.old_id = k.id;
    update crm.knowledge_chunks x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'knowledge' and m.old_id = x.item_id;
    update crm.readwise_documents x set knowledge_item_id = null
    where x.workspace_id = p_source
      and x.knowledge_item_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'knowledge');

    update crm.memories x
    set workspace_id = p_target,
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = x.company_id)
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');

    update crm.market_notes x
    set workspace_id = p_target,
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = x.company_id)
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
      and (x.url is null or not exists (select 1 from crm.market_notes y where y.workspace_id = p_target and y.url = x.url));
    update crm.market_notes x set company_id = null
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');

    update crm.watchlist x
    set workspace_id = p_target,
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = x.company_id)
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
      and not exists (
        select 1 from crm.watchlist y where y.workspace_id = p_target and y.kind = x.kind and lower(y.label) = lower(x.label)
      );
    update crm.watchlist x set company_id = null
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');

    update crm.enrichment_lookups x
    set workspace_id = p_target,
        record_id = m.new_id
    from pg_temp.orbit_move_map m
    where x.workspace_id = p_source
      and ((x.record_type = 'company' and m.kind = 'company') or (x.record_type = 'contact' and m.kind = 'contact'))
      and m.old_id = x.record_id;

    delete from crm.company_web_state x
    where x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');
    delete from crm.company_signals x
    where x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');
    delete from crm.ai_field_answers x
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');

    update crm.opportunities o
    set primary_contact_id = null
    where o.workspace_id = p_source
      and o.primary_contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact');

    update crm.documents d set opportunity_id = null
    where d.opportunity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'board_card');
    delete from crm.opportunities o
    where o.id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'board_card');

    update crm.mail_thread_routes x
    set contact_id = m.new_id
    from pg_temp.orbit_move_map m
    where m.kind = 'contact' and m.merged and x.contact_id = m.old_id;
  else
    insert into crm.activities (
      id, workspace_id, type, title, body, occurred_at, company_id, contact_id, opportunity_id,
      actor_user_id, actor_agent_id, metadata
    )
    select
      m.new_id, p_target, a.type, a.title, a.body, a.occurred_at,
      coalesce(
        (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind in ('company', 'company_link') and mc.old_id = a.company_id),
        (select mc.new_id from crm.opportunities o join pg_temp.orbit_move_map mc on mc.kind = 'company' and mc.old_id = o.company_id
         where o.id = a.opportunity_id),
        (select mc.new_id from crm.contacts p join pg_temp.orbit_move_map mc on mc.kind in ('company', 'company_link') and mc.old_id = p.company_id
         where p.id = a.contact_id and a.company_id is not null)
      ),
      (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = a.contact_id),
      (select md.new_id from pg_temp.orbit_move_map md where md.kind = 'deal' and md.old_id = a.opportunity_id),
      a.actor_user_id, a.actor_agent_id, a.metadata
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity';

    insert into crm.call_insights (
      workspace_id, activity_id, contact_id, company_id, source, transcript, summary, key_points,
      action_items, model, status, error, sentiment, sentiment_reason, sentiment_checked_at
    )
    select
      p_target, m.new_id, a.contact_id, a.company_id, x.source, x.transcript, x.summary, x.key_points,
      x.action_items, x.model, x.status, x.error, x.sentiment, x.sentiment_reason, x.sentiment_checked_at
    from pg_temp.orbit_move_map m
    join crm.call_insights x on x.activity_id = m.old_id
    join crm.activities a on a.id = m.new_id
    where m.kind = 'activity';
  end if;

  if not v_copy then
    update crm.calendar_events e
    set company_ids = array(
          select x from unnest(e.company_ids) as x
          where not exists (select 1 from pg_temp.orbit_move_map m where m.kind = 'company' and m.old_id = x)
        ),
        contact_ids = array(
          select x from unnest(e.contact_ids) as x
          where not exists (select 1 from pg_temp.orbit_move_map m where m.kind = 'contact' and m.old_id = x)
        )
    where e.workspace_id = p_source
      and (
        e.company_ids && array(select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or e.contact_ids && array(select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );
  end if;

  update crm.calendar_events e
  set company_ids = array_replace(e.company_ids, m.old_id, m.new_id)
  from pg_temp.orbit_move_map m
  where m.kind = 'company' and m.merged and not v_copy
    and m.old_id = any(e.company_ids) and not (m.new_id = any(e.company_ids));
  update crm.calendar_events e
  set company_ids = array_remove(e.company_ids, m.old_id)
  from pg_temp.orbit_move_map m
  where m.kind = 'company' and m.merged and not v_copy and m.old_id = any(e.company_ids);
  update crm.calendar_events e
  set contact_ids = array_replace(e.contact_ids, m.old_id, m.new_id)
  from pg_temp.orbit_move_map m
  where m.kind = 'contact' and m.merged and not v_copy
    and m.old_id = any(e.contact_ids) and not (m.new_id = any(e.contact_ids));
  update crm.calendar_events e
  set contact_ids = array_remove(e.contact_ids, m.old_id)
  from pg_temp.orbit_move_map m
  where m.kind = 'contact' and m.merged and not v_copy and m.old_id = any(e.contact_ids);

  if not v_copy then
    update crm.meta_leads l
    set contact_id = m.new_id
    from pg_temp.orbit_move_map m
    where m.kind = 'contact' and m.merged and l.contact_id = m.old_id;
    update crm.meta_leads l
    set company_id = m.new_id
    from pg_temp.orbit_move_map m
    where m.kind = 'company' and m.merged and l.company_id = m.old_id;
  end if;

  perform set_config('orbit.merging', 'off', true);

  return v_result || jsonb_build_object(
    'activityIds', coalesce((select jsonb_agg(m.new_id) from pg_temp.orbit_move_map m where m.kind = 'activity'), '[]'::jsonb),
    'taskMoves', v_task_moves,
    'tasksLeft', v_tasks_left
  );
end;
$$;
