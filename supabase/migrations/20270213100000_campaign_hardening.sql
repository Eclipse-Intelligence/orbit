set lock_timeout = '5s';

alter table crm.campaign_prospects add column if not exists stop_error text;
alter table crm.campaign_prospects add column if not exists stop_tried_at timestamptz;
alter table crm.campaign_prospects add column if not exists thread_error text;
alter table crm.campaign_events add column if not exists handle_attempts integer not null default 0;

create table if not exists crm.campaign_block_lifts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  value text not null,
  attempts integer not null default 0,
  last_tried_at timestamptz,
  created_at timestamptz not null default now(),
  constraint campaign_block_lifts_value_length check (char_length(value) between 1 and 500),
  constraint campaign_block_lifts_unique unique (workspace_id, value)
);

alter table crm.campaign_block_lifts add column if not exists last_tried_at timestamptz;

alter table crm.campaign_block_lifts enable row level security;
alter table crm.campaign_block_lifts force row level security;
revoke all on crm.campaign_block_lifts from anon, authenticated, crm_agent;
grant select on crm.campaign_block_lifts to authenticated, crm_agent;

drop policy if exists campaign_block_lifts_select_member on crm.campaign_block_lifts;
create policy campaign_block_lifts_select_member on crm.campaign_block_lifts
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists campaign_block_lifts_select_agent on crm.campaign_block_lifts;
create policy campaign_block_lifts_select_agent on crm.campaign_block_lifts
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));

create or replace function private.campaign_person_block(
  p_workspace uuid,
  p_channel text,
  p_campaign uuid,
  p_except uuid,
  p_contact uuid,
  p_email text,
  p_linkedin text,
  p_full boolean
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_lifecycle text;
begin
  if exists (
    select 1 from crm.suppressions s
    where s.workspace_id = p_workspace and s.reason <> 'bounced'
      and (
        (p_contact is not null and s.contact_id = p_contact)
        or (p_email is not null and s.kind = 'email' and s.value = p_email)
        or (p_linkedin is not null and s.kind = 'linkedin' and s.value = p_linkedin)
      )
  ) then
    return 'Do not contact';
  end if;
  if p_channel = 'email' and p_email is not null and exists (
    select 1 from crm.suppressions s
    where s.workspace_id = p_workspace and s.kind = 'email' and s.value = p_email and s.reason = 'bounced'
  ) then
    return 'Bounced';
  end if;
  if p_channel = 'email' and p_email is not null and exists (
    select 1 from crm.campaign_block_lifts b where b.workspace_id = p_workspace and b.value = p_email
  ) then
    return 'Smartlead''s block list still has this address';
  end if;
  if exists (
    select 1 from crm.campaign_prospects p
    where p.workspace_id = p_workspace
      and p.replied_at is not null
      and (p_except is null or p.id <> p_except)
      and (
        (p_contact is not null and p.contact_id = p_contact)
        or (p_email is not null and p.email = p_email)
        or (p_linkedin is not null and p.linkedin = p_linkedin)
      )
  ) then
    return 'Already replied';
  end if;
  if not p_full then
    return null;
  end if;
  if p_contact is not null then
    select c.company_id, co.lifecycle into v_company, v_lifecycle
    from crm.contacts c
    left join crm.companies co on co.id = c.company_id and co.workspace_id = c.workspace_id
    where c.id = p_contact and c.workspace_id = p_workspace;
  end if;
  if lower(btrim(coalesce(v_lifecycle, ''))) = 'customer' then
    return 'Customer';
  end if;
  if exists (
    select 1 from crm.opportunities o
    where o.workspace_id = p_workspace and o.archived_at is null and o.status = 'open'
      and ((p_contact is not null and o.primary_contact_id = p_contact) or (v_company is not null and o.company_id = v_company))
  ) then
    return 'Open opportunity';
  end if;
  if p_email is not null and private.workspace_knows_address(p_workspace, p_email) then
    return 'Written to or met';
  end if;
  if exists (
    select 1 from crm.campaign_prospects p
    join crm.campaigns k on k.id = p.campaign_id
    where p.workspace_id = p_workspace
      and k.channel = p_channel
      and p.campaign_id <> p_campaign
      and (p_except is null or p.id <> p_except)
      and (
        (p_contact is not null and p.contact_id = p_contact)
        or (p_email is not null and p.email = p_email)
        or (p_linkedin is not null and p.linkedin = p_linkedin)
      )
      and private.campaign_prospect_active(p.state, p.stopped_at, p.lead_status, k.status)
      and p.stop_requested_at is null
  ) then
    return 'In another campaign';
  end if;
  return null;
end;
$$;

create or replace function private.campaign_run_ended(p_run uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case r.status
    when 'cancelled' then 'The workflow run was stopped.'
    when 'failed' then 'The workflow run failed.'
  end
  from crm.workflow_runs r
  where r.id = p_run;
$$;

create or replace function private.campaign_stop_reason_line(p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_reason
    when 'suppressed' then 'Do not contact'
    when 'replied' then 'Already replied'
    else 'Removed'
  end;
$$;

create or replace function private.campaign_claim_fill(p_workspace uuid, p_prospect uuid, p_holder text)
returns table (prospect_id uuid, state text, claimed boolean, filled boolean, skip_reason text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row crm.campaign_prospects%rowtype;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set state = case when p.state = 'queued' then 'filling' else p.state end,
      claimed_at = now(),
      claimed_by = left(p_holder, 100)
  where p.id = p_prospect and p.workspace_id = p_workspace
    and p.state in ('queued', 'filling', 'pushing')
    and (
      p.claimed_by = p_holder
      or p.claimed_at is null
      or p.claimed_at < now() - interval '10 minutes'
      or (p.added_by_run_id is not null and p_holder = 'run:' || p.added_by_run_id::text)
    )
  returning * into v_row;
  if v_row.id is not null then
    prospect_id := v_row.id;
    state := v_row.state;
    claimed := true;
    filled := v_row.filled_at is not null;
    skip_reason := v_row.skip_reason;
    return next;
    return;
  end if;
  select * into v_row from crm.campaign_prospects p where p.id = p_prospect and p.workspace_id = p_workspace;
  if v_row.id is null then
    return;
  end if;
  prospect_id := v_row.id;
  state := v_row.state;
  claimed := false;
  filled := v_row.filled_at is not null;
  skip_reason := v_row.skip_reason;
  return next;
end;
$$;

drop function if exists private.claim_campaign_fills(integer, text);

create or replace function private.claim_campaign_fills(p_limit integer, p_holder text)
returns table (prospect_id uuid, campaign_id uuid, workspace_id uuid, added_by_user_id uuid, provider text, run_ended text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_campaign uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set state = 'failed', skip_reason = private.campaign_run_ended(p.added_by_run_id), claimed_at = null, claimed_by = null
  where p.id in (
    select x.id from crm.campaign_prospects x
    join crm.workflow_runs r on r.id = x.added_by_run_id and r.status in ('cancelled', 'failed')
    where x.state in ('queued', 'filling')
    order by x.created_at
    limit 500
  )
    and p.state in ('queued', 'filling');
  select p.campaign_id into v_campaign
  from crm.campaign_prospects p
  where p.state in ('queued', 'filling', 'pushing') and private.campaign_fill_claimable(p)
  order by p.created_at, p.id
  limit 1
  for update of p skip locked;
  if v_campaign is null then
    return;
  end if;
  return query
  with picked as (
    select p.id
    from crm.campaign_prospects p
    where p.campaign_id = v_campaign and p.state in ('queued', 'filling', 'pushing') and private.campaign_fill_claimable(p)
    order by p.created_at, p.id
    limit least(greatest(coalesce(p_limit, 1), 1), 100)
    for update of p skip locked
  )
  update crm.campaign_prospects p
  set state = case when p.state = 'queued' then 'filling' else p.state end,
      claimed_at = now(),
      claimed_by = left(p_holder, 100)
  from picked
  where p.id = picked.id
  returning p.id, p.campaign_id, p.workspace_id, p.added_by_user_id,
    (select k.provider from crm.campaigns k where k.id = p.campaign_id),
    case when p.added_by_run_id is not null then private.campaign_run_ended(p.added_by_run_id) end;
end;
$$;

create or replace function private.campaign_push_begin(p_workspace uuid, p_prospect uuid, p_holder text)
returns table (ok boolean, reason text, email text, linkedin text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row crm.campaign_prospects%rowtype;
  v_channel text;
  v_email text;
  v_linkedin text;
  v_reason text;
  v_state text := 'skipped';
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_row from crm.campaign_prospects p where p.id = p_prospect and p.workspace_id = p_workspace for update;
  if v_row.id is null or v_row.state not in ('filling', 'pushing') or v_row.claimed_by is distinct from p_holder then
    ok := false;
    reason := null;
    return next;
    return;
  end if;
  select k.channel into v_channel from crm.campaigns k where k.id = v_row.campaign_id;
  select c.normalized_email, c.normalized_linkedin into v_email, v_linkedin
  from crm.contacts c where c.id = v_row.contact_id and c.workspace_id = p_workspace and c.archived_at is null;
  v_email := coalesce(v_email, v_row.email);
  v_linkedin := coalesce(v_linkedin, v_row.linkedin);
  if v_row.stop_requested_at is not null or v_row.stop_reason is not null then
    v_reason := private.campaign_stop_reason_line(v_row.stop_reason);
  elsif v_row.added_by_run_id is not null and private.campaign_run_ended(v_row.added_by_run_id) is not null then
    v_reason := private.campaign_run_ended(v_row.added_by_run_id);
    v_state := 'failed';
  elsif v_row.contact_id is null then
    v_reason := 'Not in Orbit';
  elsif v_channel = 'email' and v_email is null then
    v_reason := 'No email';
  elsif v_channel = 'linkedin' and v_linkedin is null then
    v_reason := 'No LinkedIn profile';
  else
    v_reason := private.campaign_person_block(p_workspace, v_channel, v_row.campaign_id, v_row.id, v_row.contact_id, v_email, v_linkedin, false);
  end if;
  if v_reason is not null then
    update crm.campaign_prospects p
    set state = v_state, skip_reason = v_reason, claimed_at = null, claimed_by = null,
        stop_requested_at = null, stop_reason = null
    where p.id = v_row.id;
    ok := false;
    reason := v_reason;
    return next;
    return;
  end if;
  update crm.campaign_prospects p
  set state = 'pushing', email = v_email, linkedin = v_linkedin, claimed_at = now()
  where p.id = v_row.id;
  ok := true;
  reason := null;
  email := v_email;
  linkedin := v_linkedin;
  return next;
end;
$$;

create or replace function private.campaign_run_gave_up(p_workspace uuid, p_prospect uuid, p_run uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set state = 'failed',
      skip_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Couldn''t add this person. Try again.'), 500),
      claimed_at = null,
      claimed_by = null
  where p.id = p_prospect and p.workspace_id = p_workspace and p.added_by_run_id = p_run
    and p.state in ('queued', 'filling')
  returning p.state into v_state;
  return v_state;
end;
$$;

create or replace function private.campaign_prospect_lead_id(p_workspace uuid, p_prospect uuid, p_lead text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set external_lead_id = left(p_lead, 200)
  where p.id = p_prospect and p.workspace_id = p_workspace and p.external_lead_id is null
    and nullif(btrim(p_lead), '') is not null
    and not exists (
      select 1 from crm.campaign_prospects o
      where o.campaign_id = p.campaign_id and o.external_lead_id = left(p_lead, 200) and o.id <> p.id
    );
  return found;
end;
$$;


create or replace function private.campaign_stops_due(p_workspace uuid, p_provider text, p_limit integer)
returns table (
  prospect_id uuid,
  campaign_id uuid,
  campaign_external_id text,
  external_lead_id text,
  email text,
  linkedin text,
  sender_id text,
  stop_reason text,
  pushed_at timestamptz,
  leads_at timestamptz
)
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
  select p.id, p.campaign_id, k.external_id, p.external_lead_id, p.email, p.linkedin, p.sender_id, p.stop_reason, p.pushed_at,
    case when (k.sync_state ->> 'leadsAt') ~ '^\d{4}-' then (k.sync_state ->> 'leadsAt')::timestamptz end
  from crm.campaign_prospects p
  join crm.campaigns k on k.id = p.campaign_id
  where p.workspace_id = p_workspace and k.provider = p_provider
    and p.stop_requested_at is not null and p.stopped_at is null
    and p.state = 'pushed'
    and (p.stop_error is null or p.stop_tried_at is null or p.stop_tried_at < now() - interval '1 hour')
  order by (p.stop_error is not null), p.stop_requested_at, p.id
  limit least(greatest(p_limit, 1), 500);
end;
$$;

create or replace function private.campaign_stop_confirmed(p_workspace uuid, p_prospect uuid, p_lead_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set stopped_at = coalesce(p.stopped_at, now()),
      stop_error = null,
      stop_tried_at = null,
      thread_error = null,
      lead_status = coalesce(left(nullif(p_lead_status, ''), 100), p.lead_status)
  where p.id = p_prospect and p.workspace_id = p_workspace and p.stop_requested_at is not null;
end;
$$;

create or replace function private.campaign_stop_refused(p_workspace uuid, p_prospect uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set stop_error = left(coalesce(nullif(btrim(p_error), ''), 'Couldn''t stop this person. Try again.'), 500),
      stop_tried_at = now()
  where p.id = p_prospect and p.workspace_id = p_workspace and p.stop_requested_at is not null and p.stopped_at is null;
end;
$$;

create or replace function private.campaign_thread_unread(p_prospect uuid, p_line text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set thread_error = left(coalesce(nullif(btrim(p_line), ''), 'Couldn''t read the reply.'), 500),
      sync_requested_at = coalesce(p.sync_requested_at, now())
  where p.id = p_prospect;
end;
$$;

create or replace function private.campaign_thread_request_done(p_prospect uuid, p_requested_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set sync_claimed_at = null,
      sync_requested_at = case
        when p_requested_at is not null and date_trunc('milliseconds', p.sync_requested_at) <= p_requested_at then null
        else p.sync_requested_at
      end
  where p.id = p_prospect;
end;
$$;

create or replace function private.campaign_unread_note(p_campaign uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (
    select p.thread_error from crm.campaign_prospects p
    join crm.campaigns k on k.id = p.campaign_id
    where p.campaign_id = p_campaign and p.thread_error is not null
      and p.stopped_at is null and p.stop_reason is distinct from 'removed' and k.status <> 'archived'
    order by p.updated_at desc, p.id
    limit 1
  );
end;
$$;

create or replace function private.campaign_thread_fetched(p_prospect uuid, p_requested_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set thread_fetched_at = now(),
      thread_error = null,
      sync_claimed_at = case when p_requested_at is null then p.sync_claimed_at end,
      sync_requested_at = case
        when p_requested_at is not null and date_trunc('milliseconds', p.sync_requested_at) <= p_requested_at then null
        else p.sync_requested_at
      end
  where p.id = p_prospect;
end;
$$;

create or replace function private.campaign_events_attempted(p_campaign uuid, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_events e set handle_attempts = e.handle_attempts + 1
  where e.campaign_id = p_campaign and e.id = any(p_ids) and e.handled_at is null;
end;
$$;

create or replace function private.campaign_sync_update(p_campaign uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaigns k
  set sequence = case when p_patch ? 'sequence' then p_patch -> 'sequence' else k.sequence end,
      variables = case
        when p_patch ? 'variables' then array(select jsonb_array_elements_text(p_patch -> 'variables'))
        else k.variables
      end,
      stats = case when p_patch ? 'stats' then p_patch -> 'stats' else k.stats end,
      step_stats = case when p_patch ? 'stepStats' then p_patch -> 'stepStats' else k.step_stats end,
      day_stats = case when jsonb_typeof(p_patch -> 'dayStats') = 'array' then p_patch -> 'dayStats' else k.day_stats end,
      sender_ids = case
        when p_patch ? 'senderIds' then array(select jsonb_array_elements_text(p_patch -> 'senderIds'))
        else k.sender_ids
      end,
      sync_state = case
        when p_patch ? 'syncState' then jsonb_strip_nulls(k.sync_state || (p_patch -> 'syncState'))
        else k.sync_state
      end,
      sync_error = case when p_patch ? 'syncError' then left(p_patch ->> 'syncError', 500) else k.sync_error end,
      status = case
        when (p_patch ->> 'status') in ('active', 'paused', 'drafted', 'completed', 'stopped', 'archived') then p_patch ->> 'status'
        else k.status
      end,
      backfilled_at = case when coalesce((p_patch ->> 'backfilled')::boolean, false) then coalesce(k.backfilled_at, now()) else k.backfilled_at end,
      synced_at = now()
  where k.id = p_campaign;
  if (p_patch ->> 'status') = 'archived' then
    update crm.campaign_prospects p set thread_error = null where p.campaign_id = p_campaign and p.thread_error is not null;
  end if;
end;
$$;

create or replace function private.campaign_status_event(p_prospect uuid, p_status text, p_handled boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row crm.campaign_prospects%rowtype;
  v_event uuid;
begin
  if p_status not in ('unsubscribed', 'bounced') then
    return null;
  end if;
  select * into v_row from crm.campaign_prospects p where p.id = p_prospect;
  if v_row.id is null or exists (select 1 from crm.campaign_events e where e.prospect_id = v_row.id and e.kind = p_status) then
    return null;
  end if;
  insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key, payload, handled_at)
  values (v_row.workspace_id, v_row.campaign_id, v_row.id, p_status, now(), 'orbit:status:' || p_status || ':' || v_row.id::text,
    jsonb_build_object('fromLeadStatus', true), case when p_handled then now() end)
  on conflict on constraint campaign_events_dedupe do nothing
  returning e.id into v_event;
  if v_event is not null then
    update crm.campaign_prospects p set last_event_at = greatest(p.last_event_at, now()) where p.id = v_row.id;
  end if;
  return v_event;
end;
$$;

create or replace function private.campaign_sync_prospects(p_campaign uuid, p_leads jsonb, p_handled boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign crm.campaigns%rowtype;
  v_lead record;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_revived uuid[] := '{}';
  v_row crm.campaign_prospects%rowtype;
  v_block text;
  v_old text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_campaign from crm.campaigns k where k.id = p_campaign;
  if not found then
    return 0;
  end if;
  for v_lead in
    select left(nullif(x.external_id, ''), 200) as external_id,
      case when char_length(coalesce(x.email, '')) between 3 and 320 then x.email end as email,
      left(nullif(x.linkedin, ''), 500) as linkedin,
      coalesce(x.lead, '{}'::jsonb) as lead,
      left(nullif(x.lead_status, ''), 100) as lead_status,
      left(nullif(x.category, ''), 200) as category,
      x.added_at,
      left(nullif(x.sender_id, ''), 200) as sender_id
    from jsonb_to_recordset(coalesce(p_leads, '[]'::jsonb))
      as x(external_id text, email text, linkedin text, lead jsonb, lead_status text, category text, added_at timestamptz, sender_id text)
  loop
    v_id := null;
    if v_lead.external_id is not null then
      select p.id into v_id from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.external_lead_id = v_lead.external_id;
    end if;
    if v_id is null and v_lead.email is not null then
      select p.id into v_id from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.email = v_lead.email
        and (p.external_lead_id is null or v_lead.external_id is null)
      order by (p.state in ('skipped', 'failed')), p.created_at
      limit 1;
    end if;
    if v_id is null and v_lead.linkedin is not null then
      select p.id into v_id from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.linkedin = v_lead.linkedin
        and (p.external_lead_id is null or v_lead.external_id is null)
      order by (p.state in ('skipped', 'failed')), p.created_at
      limit 1;
    end if;
    if v_id is null then
      insert into crm.campaign_prospects (
        workspace_id, campaign_id, email, linkedin, lead, state, external_lead_id, lead_status, category, pushed_at, sender_id
      ) values (
        v_campaign.workspace_id, p_campaign, v_lead.email, v_lead.linkedin, v_lead.lead, 'pushed',
        v_lead.external_id, v_lead.lead_status, v_lead.category, coalesce(v_lead.added_at, now()), v_lead.sender_id
      )
      returning id into v_id;
    else
      select p.state into v_old from crm.campaign_prospects p where p.id = v_id;
      update crm.campaign_prospects p
      set import_error = case
            when (v_lead.email is not null and v_lead.email is distinct from p.email)
              or (v_lead.linkedin is not null and v_lead.linkedin is distinct from p.linkedin)
              or (p.lead || v_lead.lead) is distinct from p.lead
            then null
            else p.import_error
          end,
          state = case when p.state in ('skipped', 'failed') and v_lead.external_id is not null then 'pushed' else p.state end,
          claimed_at = case when p.state in ('skipped', 'failed') and v_lead.external_id is not null then null else p.claimed_at end,
          claimed_by = case when p.state in ('skipped', 'failed') and v_lead.external_id is not null then null else p.claimed_by end,
          external_lead_id = coalesce(p.external_lead_id, v_lead.external_id),
          email = coalesce(p.email, v_lead.email),
          linkedin = coalesce(p.linkedin, v_lead.linkedin),
          lead = p.lead || v_lead.lead,
          lead_status = coalesce(v_lead.lead_status, p.lead_status),
          pushed_at = coalesce(p.pushed_at, v_lead.added_at, case when p.state in ('skipped', 'failed') and v_lead.external_id is not null then now() end),
          sender_id = coalesce(p.sender_id, v_lead.sender_id)
      where p.id = v_id;
      if v_old in ('skipped', 'failed') and v_lead.external_id is not null then
        v_revived := v_revived || v_id;
      end if;
    end if;
    v_ids := v_ids || v_id;
    if v_lead.lead_status in ('unsubscribed', 'bounced') then
      perform private.campaign_status_event(v_id, v_lead.lead_status, p_handled);
    end if;
  end loop;
  perform private.campaign_link_contacts(p_campaign, v_ids);
  for v_row in
    select p.* from crm.campaign_prospects p
    where p.id = any(v_revived) and p.state = 'pushed' and p.stop_requested_at is null and p.stopped_at is null
  loop
    if v_row.skip_reason = 'Removed' then
      update crm.campaign_prospects p set stop_requested_at = now(), stop_reason = 'removed' where p.id = v_row.id;
      continue;
    end if;
    v_block := private.campaign_person_block(
      v_row.workspace_id, v_campaign.channel, p_campaign, v_row.id, v_row.contact_id, v_row.email, v_row.linkedin, false
    );
    if v_block in ('Do not contact', 'Already replied') then
      update crm.campaign_prospects p
      set stop_requested_at = now(), stop_reason = case when v_block = 'Do not contact' then 'suppressed' else 'replied' end
      where p.id = v_row.id;
    end if;
  end loop;
  return coalesce(cardinality(v_ids), 0);
end;
$$;

create or replace function private.campaign_sync_events(p_campaign uuid, p_events jsonb, p_handled boolean)
returns table (event_id uuid, prospect_id uuid, contact_id uuid, kind text, occurred_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign crm.campaigns%rowtype;
  v_event record;
  v_prospect uuid;
  v_contact uuid;
  v_category text;
  v_inserted uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_campaign from crm.campaigns k where k.id = p_campaign;
  if not found then
    return;
  end if;
  for v_event in
    select left(nullif(x.external_lead_id, ''), 200) as external_lead_id,
      case when char_length(coalesce(x.email, '')) between 3 and 320 then x.email end as email,
      left(nullif(x.linkedin, ''), 500) as linkedin,
      coalesce(x.lead, '{}'::jsonb) as lead,
      x.kind,
      x.step,
      left(nullif(x.variant, ''), 100) as variant,
      x.occurred_at,
      left(x.dedupe_key, 500) as dedupe_key,
      left(nullif(x.category, ''), 200) as category,
      coalesce(x.payload, '{}'::jsonb) as payload
    from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb))
      as x(external_lead_id text, email text, linkedin text, lead jsonb, kind text, step integer, variant text,
           occurred_at timestamptz, dedupe_key text, category text, payload jsonb)
    where x.occurred_at is not null and coalesce(x.dedupe_key, '') <> ''
    order by x.occurred_at
  loop
    if exists (select 1 from crm.campaign_event_tombstones t where t.campaign_id = p_campaign and t.dedupe_key = v_event.dedupe_key) then
      continue;
    end if;
    v_prospect := null;
    v_category := null;
    if v_event.external_lead_id is not null then
      select p.id, p.contact_id, p.category into v_prospect, v_contact, v_category from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.external_lead_id = v_event.external_lead_id;
    end if;
    if v_prospect is null and v_event.email is not null then
      select p.id, p.contact_id, p.category into v_prospect, v_contact, v_category from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.email = v_event.email
      order by p.external_lead_id is null, p.created_at
      limit 1;
    end if;
    if v_prospect is null and v_event.linkedin is not null then
      select p.id, p.contact_id, p.category into v_prospect, v_contact, v_category from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.linkedin = v_event.linkedin
      order by p.external_lead_id is null, p.created_at
      limit 1;
    end if;
    if v_prospect is null then
      if v_event.email is null and v_event.linkedin is null and v_event.external_lead_id is null then
        continue;
      end if;
      insert into crm.campaign_prospects (
        workspace_id, campaign_id, email, linkedin, lead, state, external_lead_id, pushed_at
      ) values (
        v_campaign.workspace_id, p_campaign, v_event.email, v_event.linkedin, v_event.lead, 'pushed',
        v_event.external_lead_id, v_event.occurred_at
      )
      returning id into v_prospect;
      perform private.campaign_link_contacts(p_campaign, array[v_prospect]);
      select p.contact_id into v_contact from crm.campaign_prospects p where p.id = v_prospect;
    end if;

    if v_campaign.provider = 'heyreach' and v_event.kind = 'category' and v_category is not null then
      continue;
    end if;

    if v_event.kind in ('unsubscribed', 'bounced') and exists (
      select 1 from crm.campaign_events x where x.prospect_id = v_prospect and x.kind = v_event.kind
    ) then
      continue;
    end if;

    v_inserted := null;
    insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, step, variant, occurred_at, dedupe_key, payload, handled_at)
    values (v_campaign.workspace_id, p_campaign, v_prospect, v_event.kind, v_event.step, v_event.variant,
      v_event.occurred_at, v_event.dedupe_key, v_event.payload, case when p_handled then now() end)
    on conflict on constraint campaign_events_dedupe do nothing
    returning e.id into v_inserted;

    update crm.campaign_prospects p
    set last_event_at = greatest(p.last_event_at, v_event.occurred_at),
        replied_at = case when v_event.kind = 'replied' then least(coalesce(p.replied_at, v_event.occurred_at), v_event.occurred_at) else p.replied_at end,
        category = case
          when v_inserted is null or v_event.kind <> 'category' then p.category
          when v_campaign.provider = 'heyreach' then coalesce(p.category, v_event.category)
          else coalesce(v_event.category, p.category)
        end
    where p.id = v_prospect
      and (
        p.last_event_at is distinct from greatest(p.last_event_at, v_event.occurred_at)
        or (v_event.kind = 'replied' and (p.replied_at is null or p.replied_at > v_event.occurred_at))
        or (v_inserted is not null and v_event.kind = 'category' and v_event.category is not null and v_campaign.provider <> 'heyreach' and p.category is distinct from v_event.category)
        or (v_inserted is not null and v_event.kind = 'category' and v_event.category is not null and v_campaign.provider = 'heyreach' and p.category is null)
      );

    if v_inserted is not null then
      event_id := v_inserted;
      prospect_id := v_prospect;
      contact_id := v_contact;
      kind := v_event.kind;
      occurred_at := v_event.occurred_at;
      return next;
    end if;
  end loop;
end;
$$;

create or replace function private.campaign_set_category(
  p_workspace uuid,
  p_prospect uuid,
  p_category text,
  p_dedupe text,
  p_payload jsonb,
  p_clear_keys text[],
  p_audit jsonb
)
returns table (changed boolean, event_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_prospect crm.campaign_prospects%rowtype;
  v_category text := left(nullif(btrim(p_category), ''), 200);
  v_event uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_prospect from crm.campaign_prospects p
  where p.id = p_prospect and p.workspace_id = p_workspace
  for update;
  if not found or v_prospect.category is not distinct from v_category then
    changed := false;
    event_id := null;
    return next;
    return;
  end if;
  update crm.campaign_prospects p set category = v_category where p.id = p_prospect;
  if v_category is null then
    insert into crm.campaign_event_tombstones (campaign_id, dedupe_key)
    select v_prospect.campaign_id, left(k, 500)
    from unnest(coalesce(p_clear_keys, '{}'::text[])) k
    where nullif(btrim(k), '') is not null
    on conflict on constraint campaign_event_tombstones_pkey do nothing;
  else
    delete from crm.campaign_event_tombstones t
    where t.campaign_id = v_prospect.campaign_id and t.dedupe_key = left(p_dedupe, 500);
    insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key, payload, claimed_at)
    values (p_workspace, v_prospect.campaign_id, p_prospect, 'category', now(), left(p_dedupe, 500),
      coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('category', v_category), now())
    on conflict on constraint campaign_events_dedupe do nothing
    returning e.id into v_event;
  end if;
  if p_audit is not null then
    perform private.suppression_audit(p_workspace, p_audit, jsonb_build_object('before', v_prospect.category, 'after', v_category));
  end if;
  changed := true;
  event_id := v_event;
  return next;
end;
$$;

create or replace function private.campaign_status_set(p_workspace uuid, p_campaign uuid, p_status text, p_audit jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status not in ('active', 'paused') then
    raise exception 'Pick a campaign status.' using errcode = '22023';
  end if;
  select k.status into v_before from crm.campaigns k where k.id = p_campaign and k.workspace_id = p_workspace for update;
  if not found or v_before = p_status then
    return false;
  end if;
  update crm.campaigns k set status = p_status where k.id = p_campaign and k.workspace_id = p_workspace;
  if p_audit is not null then
    perform private.suppression_audit(p_workspace, p_audit, jsonb_build_object('before', v_before, 'after', p_status));
  end if;
  return true;
end;
$$;

create or replace function private.campaign_prospect_lead_status(p_workspace uuid, p_prospect uuid, p_lead_status text, p_audit jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text;
  v_after text := left(nullif(p_lead_status, ''), 100);
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select p.lead_status into v_before from crm.campaign_prospects p where p.id = p_prospect and p.workspace_id = p_workspace for update;
  if not found or v_before is not distinct from v_after then
    return false;
  end if;
  update crm.campaign_prospects p set lead_status = v_after where p.id = p_prospect and p.workspace_id = p_workspace;
  if p_audit is not null then
    perform private.suppression_audit(p_workspace, p_audit, jsonb_build_object('before', v_before, 'after', v_after));
  end if;
  return true;
end;
$$;

create or replace function private.campaign_prospect_remove(p_workspace uuid, p_prospect uuid, p_audit jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_stopped timestamptz;
  v_reason text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select p.state, p.stopped_at, p.stop_reason into v_state, v_stopped, v_reason from crm.campaign_prospects p
  where p.id = p_prospect and p.workspace_id = p_workspace
  for update;
  if not found then
    return null;
  end if;
  if v_state in ('skipped', 'failed') or v_stopped is not null or v_reason = 'removed' then
    return 'unchanged';
  end if;
  update crm.campaign_prospects p
  set state = case when p.state in ('queued', 'filling') then 'skipped' else p.state end,
      skip_reason = case when p.state in ('queued', 'filling') then 'Removed' else p.skip_reason end,
      claimed_at = case when p.state in ('queued', 'filling') then null else p.claimed_at end,
      stop_requested_at = case when p.state in ('pushing', 'pushed') and p.stopped_at is null then coalesce(p.stop_requested_at, now()) else p.stop_requested_at end,
      stop_reason = case when p.state in ('pushing', 'pushed') and p.stopped_at is null then 'removed' else p.stop_reason end,
      thread_error = null
  where p.id = p_prospect;
  if p_audit is not null then
    perform private.suppression_audit(p_workspace, p_audit, jsonb_build_object('state', v_state));
  end if;
  return v_state;
end;
$$;

create or replace function private.campaign_reply_finish(
  p_workspace uuid,
  p_message uuid,
  p_state text,
  p_provider_message_id text,
  p_error text,
  p_audit jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_state not in ('sent', 'unknown', 'failed') then
    raise exception 'Unknown send state.' using errcode = '22023';
  end if;
  update crm.campaign_messages m
  set send_state = case when m.confirmed_at is not null then 'sent' else p_state end,
      provider_message_id = coalesce(m.provider_message_id, left(nullif(p_provider_message_id, ''), 500)),
      send_error = case when p_state = 'sent' then null else left(p_error, 500) end,
      sent_at = case when p_state = 'sent' and m.confirmed_at is null then now() else m.sent_at end
  where m.id = p_message and m.workspace_id = p_workspace and m.send_state in ('sending', 'unknown')
  returning m.send_state into v_state;
  if v_state is null then
    select m.send_state into v_state from crm.campaign_messages m
    where m.id = p_message and m.workspace_id = p_workspace and m.send_state = 'sent' and m.confirmed_at is not null;
    if v_state is null then
      return false;
    end if;
  end if;
  if p_audit is not null and v_state <> 'failed' and not exists (
    select 1 from crm.audit_events a
    where a.entity_type = p_audit ->> 'entityType' and a.entity_id = (p_audit ->> 'entityId')::uuid
      and a.workspace_id = p_workspace and a.event_type = p_audit ->> 'eventType' and a.changes ->> 'messageId' = p_message::text
  ) then
    perform private.suppression_audit(p_workspace, p_audit, jsonb_build_object('messageId', p_message, 'sendState', v_state));
  end if;
  return true;
end;
$$;

create or replace function private.campaign_add_prospects(
  p_workspace uuid,
  p_campaign uuid,
  p_contacts uuid[],
  p_user uuid,
  p_agent uuid,
  p_run uuid,
  p_audit jsonb
)
returns table (contact_id uuid, prospect_id uuid, state text, skip_reason text, outcome text, mine boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_campaign crm.campaigns%rowtype;
  v_contact record;
  v_existing crm.campaign_prospects%rowtype;
  v_twin crm.campaign_prospects%rowtype;
  v_reason text;
  v_id uuid;
  v_requeue boolean;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_campaign from crm.campaigns k where k.id = p_campaign and k.workspace_id = p_workspace;
  if not found then
    raise exception 'That campaign isn''t in this workspace.' using errcode = 'P0002';
  end if;
  if cardinality(coalesce(p_contacts, '{}'::uuid[])) > 1000 then
    raise exception 'Add up to 1,000 people at a time.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('orbit.campaign_add:' || p_workspace::text || ':' || v_campaign.channel));
  for v_contact in
    select c.id, nullif(btrim(c.first_name), '') as first_name, nullif(btrim(c.last_name), '') as last_name,
      c.normalized_email, c.normalized_linkedin, c.company_id
    from (select distinct on (w.id) w.id, w.n from unnest(p_contacts) with ordinality as w(id, n) order by w.id, w.n) w
    join crm.contacts c on c.id = w.id and c.workspace_id = p_workspace and c.archived_at is null
    order by w.n
  loop
    v_existing := null;
    v_twin := null;
    select * into v_existing from crm.campaign_prospects p
    where p.campaign_id = p_campaign and p.contact_id = v_contact.id
    for update;
    if v_existing.id is null then
      select * into v_existing from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.contact_id is null
        and ((v_contact.normalized_email is not null and p.email = v_contact.normalized_email)
          or (v_contact.normalized_linkedin is not null and p.linkedin = v_contact.normalized_linkedin))
      order by p.created_at
      limit 1
      for update;
      if v_existing.id is not null then
        update crm.campaign_prospects p
        set contact_id = v_contact.id, company_id = coalesce(p.company_id, v_contact.company_id)
        where p.id = v_existing.id;
      end if;
    end if;
    if v_existing.id is null then
      select * into v_twin from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.contact_id is not null and p.contact_id <> v_contact.id
        and ((v_contact.normalized_email is not null and p.email = v_contact.normalized_email)
          or (v_contact.normalized_linkedin is not null and p.linkedin = v_contact.normalized_linkedin))
      order by (p.state in ('skipped', 'failed')), p.created_at
      limit 1;
      if v_twin.id is not null and v_twin.state in ('skipped', 'failed') then
        update crm.campaign_prospects p
        set contact_id = v_contact.id, company_id = v_contact.company_id
        where p.id = v_twin.id
        returning * into v_existing;
      elsif v_twin.id is not null then
        contact_id := v_contact.id;
        prospect_id := v_twin.id;
        state := v_twin.state;
        skip_reason := v_twin.skip_reason;
        outcome := 'already';
        mine := false;
        return next;
        continue;
      end if;
    end if;
    if v_existing.id is not null and v_existing.state not in ('skipped', 'failed') then
      contact_id := v_contact.id;
      prospect_id := v_existing.id;
      state := v_existing.state;
      skip_reason := v_existing.skip_reason;
      outcome := 'already';
      mine := p_run is not null and v_existing.added_by_run_id = p_run;
      return next;
      continue;
    end if;

    v_reason := null;
    if v_campaign.channel = 'email' and v_contact.normalized_email is null then
      v_reason := 'No email';
    elsif v_campaign.channel = 'linkedin' and (v_contact.first_name is null or v_contact.last_name is null) then
      v_reason := 'No first or last name';
    end if;
    if v_reason is null then
      v_reason := private.campaign_person_block(
        p_workspace, v_campaign.channel, p_campaign, v_existing.id, v_contact.id,
        v_contact.normalized_email, v_contact.normalized_linkedin, true
      );
    end if;

    v_requeue := v_existing.id is not null;
    if v_requeue then
      update crm.campaign_prospects p
      set state = case when v_reason is null then 'queued' else 'skipped' end,
          skip_reason = v_reason,
          email = coalesce(v_contact.normalized_email, p.email),
          linkedin = coalesce(v_contact.normalized_linkedin, p.linkedin),
          company_id = coalesce(v_contact.company_id, p.company_id),
          claimed_at = null,
          claimed_by = null,
          filled_at = null,
          fill_attempts = 0,
          stop_requested_at = null,
          stop_reason = null,
          "values" = '{}'::jsonb,
          sources = '{}'::jsonb,
          added_by_user_id = p_user,
          added_by_agent_id = p_agent,
          added_by_run_id = p_run
      where p.id = v_existing.id
      returning p.id into v_id;
    else
      insert into crm.campaign_prospects as p (
        workspace_id, campaign_id, contact_id, company_id, email, linkedin, lead, state, skip_reason,
        added_by_user_id, added_by_agent_id, added_by_run_id
      ) values (
        p_workspace, p_campaign, v_contact.id, v_contact.company_id, v_contact.normalized_email, v_contact.normalized_linkedin,
        jsonb_strip_nulls(jsonb_build_object('firstName', v_contact.first_name, 'lastName', v_contact.last_name)),
        case when v_reason is null then 'queued' else 'skipped' end, v_reason,
        p_user, p_agent, p_run
      )
      on conflict (campaign_id, contact_id) where contact_id is not null do nothing
      returning p.id into v_id;
      if v_id is null then
        select p.id, p.state, p.skip_reason into v_id, state, skip_reason
        from crm.campaign_prospects p where p.campaign_id = p_campaign and p.contact_id = v_contact.id;
        contact_id := v_contact.id;
        prospect_id := v_id;
        outcome := 'already';
        mine := false;
        return next;
        continue;
      end if;
    end if;

    if v_reason is null and p_audit is not null then
      perform private.suppression_audit(
        p_workspace,
        p_audit || jsonb_build_object('entityType', 'campaign_prospect', 'entityId', v_id),
        jsonb_build_object('contactId', v_contact.id, 'requeued', v_requeue)
      );
    end if;
    contact_id := v_contact.id;
    prospect_id := v_id;
    state := case when v_reason is null then 'queued' else 'skipped' end;
    skip_reason := v_reason;
    outcome := case when v_reason is not null then 'skipped' when v_requeue then 'requeued' else 'added' end;
    mine := p_run is not null;
    return next;
  end loop;
end;
$$;

create or replace function private.suppress_person_rows(
  p_workspace uuid,
  p_contact uuid,
  p_emails text[],
  p_linkedins text[],
  p_reason text,
  p_source text,
  p_user uuid,
  p_agent uuid,
  p_campaign uuid,
  p_except uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_email text;
  v_contact_linkedin text;
  v_emails text[];
  v_linkedins text[];
  v_already boolean;
  v_stopping jsonb;
  v_skipped integer;
  v_still_blocked text[];
begin
  if p_reason not in ('unsubscribed', 'manual') then
    raise exception 'The reason must be unsubscribed or manual.' using errcode = '22023';
  end if;
  if p_contact is not null then
    select c.normalized_email, c.normalized_linkedin into v_contact_email, v_contact_linkedin
    from crm.contacts c where c.id = p_contact and c.workspace_id = p_workspace;
    if not found then
      raise exception 'That person isn''t in this workspace.' using errcode = 'P0002';
    end if;
  end if;
  v_emails := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_emails, '{}'::text[]) || v_contact_email) x where nullif(btrim(x), '') is not null);
  v_linkedins := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_linkedins, '{}'::text[]) || v_contact_linkedin) x where nullif(btrim(x), '') is not null);
  if cardinality(v_emails) = 0 and cardinality(v_linkedins) = 0 then
    raise exception 'Add an email address or LinkedIn profile first.' using errcode = '22023';
  end if;

  with gone as (
    delete from crm.campaign_block_lifts b where b.workspace_id = p_workspace and b.value = any(v_emails)
    returning b.value
  )
  select coalesce(array_agg(gone.value), '{}'::text[]) into v_still_blocked from gone;

  select exists (
    select 1 from crm.suppressions s
    where s.workspace_id = p_workspace and s.reason <> 'bounced'
      and (
        (p_contact is not null and s.contact_id = p_contact)
        or (s.kind = 'email' and s.value = any(v_emails))
        or (s.kind = 'linkedin' and s.value = any(v_linkedins))
      )
  ) into v_already;

  insert into crm.suppressions as s (workspace_id, contact_id, kind, value, reason, source, campaign_id, created_by_user_id, created_by_agent_id, blocked_at)
  select p_workspace, p_contact, w.kind, w.value, p_reason, left(p_source, 40), p_campaign, p_user, p_agent,
    case when p_source = 'smartlead' or (w.kind = 'email' and w.value = any(v_still_blocked)) then now() end
  from (
    select 'email'::text as kind, e as value from unnest(v_emails) e
    union all
    select 'linkedin'::text, l from unnest(v_linkedins) l
  ) w
  order by w.kind, w.value
  on conflict (workspace_id, kind, value) do update
  set reason = case when s.reason = 'bounced' then excluded.reason else s.reason end,
      source = case when s.reason = 'bounced' then excluded.source else s.source end,
      campaign_id = case when s.reason = 'bounced' then excluded.campaign_id else s.campaign_id end,
      created_by_user_id = case when s.reason = 'bounced' then excluded.created_by_user_id else s.created_by_user_id end,
      created_by_agent_id = case when s.reason = 'bounced' then excluded.created_by_agent_id else s.created_by_agent_id end,
      blocked_at = case when s.reason = 'bounced' then excluded.blocked_at else s.blocked_at end,
      created_at = case when s.reason = 'bounced' then now() else s.created_at end,
      contact_id = coalesce(s.contact_id, excluded.contact_id)
  where s.reason = 'bounced' or (s.contact_id is null and excluded.contact_id is not null);

  with person as (
    select p.id
    from crm.campaign_prospects p
    join crm.campaigns k on k.id = p.campaign_id
    where p.workspace_id = p_workspace
      and (p_except is null or p.id <> p_except)
      and (
        (p_contact is not null and p.contact_id = p_contact)
        or p.email = any(v_emails)
        or p.linkedin = any(v_linkedins)
      )
      and private.campaign_prospect_active(p.state, p.stopped_at, p.lead_status, k.status)
      and p.stop_requested_at is null
    order by p.id
    for no key update of p
  ),
  changed as (
    update crm.campaign_prospects p
    set state = case when p.state in ('queued', 'filling') then 'skipped' else p.state end,
        skip_reason = case when p.state in ('queued', 'filling') then 'Do not contact' else p.skip_reason end,
        claimed_at = case when p.state in ('queued', 'filling') then null else p.claimed_at end,
        stop_requested_at = case when p.state in ('pushing', 'pushed') then now() else p.stop_requested_at end,
        stop_reason = case when p.state in ('pushing', 'pushed') then 'suppressed' else p.stop_reason end
    from person
    where p.id = person.id
    returning p.id, p.campaign_id, p.state, p.external_lead_id, p.email, p.linkedin, p.sender_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'prospect_id', c.id,
      'campaign_id', c.campaign_id,
      'campaign_external_id', k.external_id,
      'provider', k.provider,
      'external_lead_id', c.external_lead_id,
      'email', c.email,
      'linkedin', c.linkedin,
      'sender_id', c.sender_id,
      'stop_reason', 'suppressed'
    )) filter (where c.state = 'pushed'), '[]'::jsonb),
    count(*) filter (where c.state = 'skipped')::integer
  into v_stopping, v_skipped
  from changed c
  join crm.campaigns k on k.id = c.campaign_id;

  return jsonb_build_object('changed', not v_already, 'stopping', v_stopping, 'skipped', coalesce(v_skipped, 0));
end;
$$;

create or replace function private.suppression_lift(p_workspace uuid, p_contact uuid, p_emails text[], p_linkedins text[], p_audit jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_email text;
  v_contact_linkedin text;
  v_emails text[];
  v_linkedins text[];
  v_targets uuid[];
  v_lifted jsonb;
  v_replied boolean;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_contact is not null then
    select c.normalized_email, c.normalized_linkedin into v_contact_email, v_contact_linkedin
    from crm.contacts c where c.id = p_contact and c.workspace_id = p_workspace;
  end if;
  v_emails := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_emails, '{}'::text[]) || v_contact_email) x where nullif(btrim(x), '') is not null);
  v_linkedins := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_linkedins, '{}'::text[]) || v_contact_linkedin) x where nullif(btrim(x), '') is not null);
  select coalesce(array_agg(t.id order by t.id), '{}'::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'value', t.value, 'reason', t.reason) order by t.kind, t.value), '[]'::jsonb)
  into v_targets, v_lifted
  from (
    select s.id, s.kind, s.value, s.reason
    from crm.suppressions s
    where s.workspace_id = p_workspace and s.reason in ('manual', 'unsubscribed')
      and (
        (p_contact is not null and s.contact_id = p_contact)
        or (s.kind = 'email' and s.value = any(v_emails))
        or (s.kind = 'linkedin' and s.value = any(v_linkedins))
      )
    order by s.id
    for update
  ) t;
  if cardinality(v_targets) = 0 then
    return v_lifted;
  end if;
  insert into crm.campaign_block_lifts as b (workspace_id, value)
  select p_workspace, s.value
  from crm.suppressions s
  where s.id = any(v_targets) and s.bounced_at is null and s.kind = 'email' and s.blocked_at is not null and s.source <> 'smartlead'
  on conflict on constraint campaign_block_lifts_unique do update set attempts = 0, last_tried_at = null;
  delete from crm.suppressions s where s.id = any(v_targets) and s.bounced_at is null;
  update crm.suppressions s
  set reason = 'bounced', created_at = s.bounced_at, created_by_user_id = null, created_by_agent_id = null
  where s.id = any(v_targets) and s.bounced_at is not null;
  select exists (
    select 1 from crm.campaign_prospects p
    where p.workspace_id = p_workspace and p.replied_at is not null
      and (
        (p_contact is not null and p.contact_id = p_contact)
        or p.email = any(v_emails)
        or p.linkedin = any(v_linkedins)
      )
  ) into v_replied;
  update crm.campaign_prospects p
  set stop_requested_at = case when v_replied then p.stop_requested_at end,
      stop_reason = case when v_replied then 'replied' end
  where p.workspace_id = p_workspace and p.stop_reason = 'suppressed' and p.stopped_at is null
    and (
      (p_contact is not null and p.contact_id = p_contact)
      or p.email = any(v_emails)
      or p.linkedin = any(v_linkedins)
    );
  if p_audit is not null then
    perform private.suppression_audit(p_workspace, p_audit, jsonb_build_object('lifted', v_lifted));
  end if;
  return v_lifted;
end;
$$;

create or replace function private.campaign_stop_merged_person(p_workspace uuid, p_keep uuid, p_emails text[], p_linkedins text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_suppressed boolean;
  v_replied boolean;
  v_count integer;
begin
  select exists (
    select 1 from crm.suppressions s
    where s.workspace_id = p_workspace and s.reason <> 'bounced'
      and (s.contact_id = p_keep or (s.kind = 'email' and s.value = any(p_emails)) or (s.kind = 'linkedin' and s.value = any(p_linkedins)))
  ) into v_suppressed;
  select exists (
    select 1 from crm.campaign_prospects p
    where p.workspace_id = p_workspace and p.replied_at is not null
      and (p.contact_id = p_keep or p.email = any(p_emails) or p.linkedin = any(p_linkedins))
  ) into v_replied;
  if not v_suppressed and not v_replied then
    return 0;
  end if;
  with person as (
    select p.id
    from crm.campaign_prospects p
    join crm.campaigns k on k.id = p.campaign_id
    where p.workspace_id = p_workspace
      and (p.contact_id = p_keep or p.email = any(p_emails) or p.linkedin = any(p_linkedins))
      and (v_suppressed or p.replied_at is null)
      and private.campaign_prospect_active(p.state, p.stopped_at, p.lead_status, k.status)
      and p.stop_requested_at is null
    order by p.id
    for no key update of p
  ),
  changed as (
    update crm.campaign_prospects p
    set state = case when p.state in ('queued', 'filling') then 'skipped' else p.state end,
        skip_reason = case when p.state in ('queued', 'filling') then case when v_suppressed then 'Do not contact' else 'Already replied' end else p.skip_reason end,
        claimed_at = case when p.state in ('queued', 'filling') then null else p.claimed_at end,
        claimed_by = case when p.state in ('queued', 'filling') then null else p.claimed_by end,
        stop_requested_at = case when p.state in ('pushing', 'pushed') then now() else p.stop_requested_at end,
        stop_reason = case when p.state in ('pushing', 'pushed') then case when v_suppressed then 'suppressed' else 'replied' end else p.stop_reason end
    from person
    where p.id = person.id
    returning p.id
  )
  select count(*)::integer into v_count from changed;
  return v_count;
end;
$$;

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

create or replace function private.campaign_block_lifts_pending(p_workspace uuid, p_limit integer)
returns table (id uuid, value text)
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
  select b.id, b.value from crm.campaign_block_lifts b
  where b.workspace_id = p_workspace and (b.attempts < 5 or b.last_tried_at is null or b.last_tried_at < now() - interval '1 day')
  order by b.attempts, b.created_at, b.id
  limit least(greatest(p_limit, 1), 100);
end;
$$;

create or replace function private.campaign_block_lift_done(p_workspace uuid, p_id uuid, p_removed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_removed then
    delete from crm.campaign_block_lifts b where b.workspace_id = p_workspace and b.id = p_id;
  else
    update crm.campaign_block_lifts b set attempts = b.attempts + 1, last_tried_at = now() where b.workspace_id = p_workspace and b.id = p_id;
  end if;
end;
$$;

create or replace function private.suppressions_find_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.contact_id is null and new.reason <> 'bounced' then
    select c.id into new.contact_id
    from crm.contacts c
    where c.workspace_id = new.workspace_id and c.archived_at is null
      and ((new.kind = 'email' and c.normalized_email = new.value) or (new.kind = 'linkedin' and c.normalized_linkedin = new.value))
    order by c.created_at, c.id
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists suppressions_find_contact on crm.suppressions;
create trigger suppressions_find_contact
  before insert on crm.suppressions
  for each row
  execute function private.suppressions_find_contact();

create or replace function private.campaign_prospect_link_suppressions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update crm.suppressions s
  set contact_id = new.contact_id
  from crm.contacts c
  where c.id = new.contact_id and c.workspace_id = new.workspace_id
    and s.workspace_id = new.workspace_id and s.contact_id is null and s.reason <> 'bounced'
    and (
      (s.kind = 'email' and s.value in (new.email, c.normalized_email))
      or (s.kind = 'linkedin' and s.value in (new.linkedin, c.normalized_linkedin))
    );
  return null;
end;
$$;

drop trigger if exists campaign_prospects_link_suppressions_insert on crm.campaign_prospects;
create trigger campaign_prospects_link_suppressions_insert
  after insert on crm.campaign_prospects
  for each row
  when (new.contact_id is not null)
  execute function private.campaign_prospect_link_suppressions();

drop trigger if exists campaign_prospects_link_suppressions_update on crm.campaign_prospects;
create trigger campaign_prospects_link_suppressions_update
  after update of contact_id on crm.campaign_prospects
  for each row
  when (new.contact_id is not null and new.contact_id is distinct from old.contact_id)
  execute function private.campaign_prospect_link_suppressions();

update crm.suppressions s
set contact_id = (
  select c.id from crm.contacts c
  where c.workspace_id = s.workspace_id and c.archived_at is null
    and ((s.kind = 'email' and c.normalized_email = s.value) or (s.kind = 'linkedin' and c.normalized_linkedin = s.value))
  order by c.created_at, c.id
  limit 1
)
where s.contact_id is null and s.reason <> 'bounced';

revoke all on function private.campaign_run_ended(uuid) from public;
revoke all on function private.campaign_stop_reason_line(text) from public;
revoke all on function private.campaign_claim_fill(uuid, uuid, text) from public;
revoke all on function private.claim_campaign_fills(integer, text) from public;
revoke all on function private.campaign_push_begin(uuid, uuid, text) from public;
revoke all on function private.campaign_run_gave_up(uuid, uuid, uuid, text) from public;
revoke all on function private.campaign_prospect_lead_id(uuid, uuid, text) from public;
revoke all on function private.campaign_stops_due(uuid, text, integer) from public;
revoke all on function private.campaign_stop_confirmed(uuid, uuid, text) from public;
revoke all on function private.campaign_stop_refused(uuid, uuid, text) from public;
revoke all on function private.campaign_events_attempted(uuid, uuid[]) from public;
revoke all on function private.campaign_sync_update(uuid, jsonb) from public;
revoke all on function private.campaign_status_event(uuid, text, boolean) from public;
revoke all on function private.campaign_sync_prospects(uuid, jsonb, boolean) from public;
revoke all on function private.campaign_sync_events(uuid, jsonb, boolean) from public;
revoke all on function private.campaign_set_category(uuid, uuid, text, text, jsonb, text[], jsonb) from public;
revoke all on function private.campaign_status_set(uuid, uuid, text, jsonb) from public;
revoke all on function private.campaign_prospect_lead_status(uuid, uuid, text, jsonb) from public;
revoke all on function private.campaign_prospect_remove(uuid, uuid, jsonb) from public;
revoke all on function private.campaign_reply_finish(uuid, uuid, text, text, text, jsonb) from public;
revoke all on function private.campaign_add_prospects(uuid, uuid, uuid[], uuid, uuid, uuid, jsonb) from public;
revoke all on function private.suppress_person_rows(uuid, uuid, text[], text[], text, text, uuid, uuid, uuid, uuid) from public;
revoke all on function private.suppression_lift(uuid, uuid, text[], text[], jsonb) from public;
revoke all on function private.campaign_stop_merged_person(uuid, uuid, text[], text[]) from public;
revoke all on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function private.campaign_block_lifts_pending(uuid, integer) from public;
revoke all on function private.campaign_block_lift_done(uuid, uuid, boolean) from public;
revoke all on function private.suppressions_find_contact() from public;
revoke all on function private.campaign_prospect_link_suppressions() from public;

grant execute on function private.campaign_claim_fill(uuid, uuid, text) to crm_app;
grant execute on function private.claim_campaign_fills(integer, text) to crm_app;
grant execute on function private.campaign_push_begin(uuid, uuid, text) to crm_app;
grant execute on function private.campaign_run_gave_up(uuid, uuid, uuid, text) to crm_app;
grant execute on function private.campaign_prospect_lead_id(uuid, uuid, text) to crm_app;
grant execute on function private.campaign_stops_due(uuid, text, integer) to crm_app;
grant execute on function private.campaign_stop_confirmed(uuid, uuid, text) to crm_app;
grant execute on function private.campaign_stop_refused(uuid, uuid, text) to crm_app;
grant execute on function private.campaign_events_attempted(uuid, uuid[]) to crm_app;
grant execute on function private.campaign_sync_update(uuid, jsonb) to crm_app;
grant execute on function private.campaign_sync_prospects(uuid, jsonb, boolean) to crm_app;
grant execute on function private.campaign_sync_events(uuid, jsonb, boolean) to crm_app;
grant execute on function private.campaign_set_category(uuid, uuid, text, text, jsonb, text[], jsonb) to crm_app;
grant execute on function private.campaign_status_set(uuid, uuid, text, jsonb) to crm_app;
grant execute on function private.campaign_prospect_lead_status(uuid, uuid, text, jsonb) to crm_app;
grant execute on function private.campaign_prospect_remove(uuid, uuid, jsonb) to crm_app;
grant execute on function private.campaign_reply_finish(uuid, uuid, text, text, text, jsonb) to crm_app;
grant execute on function private.campaign_add_prospects(uuid, uuid, uuid[], uuid, uuid, uuid, jsonb) to crm_app;
grant execute on function private.suppression_lift(uuid, uuid, text[], text[], jsonb) to crm_app;
grant execute on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) to crm_app;
grant execute on function private.campaign_block_lifts_pending(uuid, integer) to crm_app;
grant execute on function private.campaign_block_lift_done(uuid, uuid, boolean) to crm_app;
revoke all on function private.campaign_thread_unread(uuid, text) from public;
revoke all on function private.campaign_thread_request_done(uuid, timestamptz) from public;
revoke all on function private.campaign_unread_note(uuid) from public;
revoke all on function private.campaign_thread_fetched(uuid, timestamptz) from public;
grant execute on function private.campaign_thread_unread(uuid, text) to crm_app;
grant execute on function private.campaign_thread_request_done(uuid, timestamptz) to crm_app;
grant execute on function private.campaign_unread_note(uuid) to crm_app;
grant execute on function private.campaign_thread_fetched(uuid, timestamptz) to crm_app;

reset lock_timeout;
