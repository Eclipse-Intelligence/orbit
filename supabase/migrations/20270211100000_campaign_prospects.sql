set lock_timeout = '5s';

create table if not exists crm.campaign_variables (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  campaign_id uuid not null,
  name text not null,
  brief text not null default '',
  required boolean not null default true,
  max_length integer,
  updated_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_variables_campaign_fk foreign key (campaign_id, workspace_id)
    references crm.campaigns (id, workspace_id) on delete cascade,
  constraint campaign_variables_name check (name ~ '^[A-Za-z0-9_]{1,60}$'),
  constraint campaign_variables_brief_length check (char_length(brief) <= 2000),
  constraint campaign_variables_max_length check (max_length is null or max_length between 1 and 5000),
  constraint campaign_variables_unique unique (campaign_id, name)
);

drop trigger if exists campaign_variables_set_updated_at on crm.campaign_variables;
create trigger campaign_variables_set_updated_at
  before update on crm.campaign_variables
  for each row execute function private.set_updated_at();

alter table crm.campaign_variables enable row level security;
alter table crm.campaign_variables force row level security;

drop policy if exists campaign_variables_select_member on crm.campaign_variables;
create policy campaign_variables_select_member on crm.campaign_variables
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists campaign_variables_insert_member on crm.campaign_variables;
create policy campaign_variables_insert_member on crm.campaign_variables
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and exists (select 1 from crm.campaigns k where k.id = campaign_id and k.workspace_id = campaign_variables.workspace_id)
  );
drop policy if exists campaign_variables_update_member on crm.campaign_variables;
create policy campaign_variables_update_member on crm.campaign_variables
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));
drop policy if exists campaign_variables_delete_member on crm.campaign_variables;
create policy campaign_variables_delete_member on crm.campaign_variables
  for delete to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists campaign_variables_select_agent on crm.campaign_variables;
create policy campaign_variables_select_agent on crm.campaign_variables
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));

revoke all on crm.campaign_variables from anon, authenticated, crm_agent;
grant select on crm.campaign_variables to authenticated, crm_agent;
grant insert (workspace_id, campaign_id, name, brief, required, max_length, updated_by) on crm.campaign_variables to authenticated;
grant update (brief, required, max_length, updated_by) on crm.campaign_variables to authenticated;
grant delete on crm.campaign_variables to authenticated;

alter table crm.campaign_prospects add column if not exists claimed_by text;
alter table crm.campaign_prospects add column if not exists filled_at timestamptz;
alter table crm.campaign_prospects drop constraint if exists campaign_prospects_claimed_by_length;
alter table crm.campaign_prospects
  add constraint campaign_prospects_claimed_by_length check (claimed_by is null or char_length(claimed_by) <= 100) not valid;

create or replace function private.workspace_knows_address(p_workspace uuid, p_address text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(btrim(p_address), ''), '') <> '' and exists (
    select 1
    from crm.workspace_members m
    join crm.mail_known_addresses k on k.user_id = m.user_id and k.address = lower(btrim(p_address))
    where m.workspace_id = p_workspace
      and (k.sent_count > 0 or k.met_first <= now())
  );
$$;

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

create or replace function private.campaign_add_prospects(
  p_workspace uuid,
  p_campaign uuid,
  p_contacts uuid[],
  p_user uuid,
  p_agent uuid,
  p_run uuid
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
      if v_twin.id is not null then
        contact_id := v_contact.id;
        prospect_id := v_twin.id;
        state := v_twin.state;
        if v_twin.state in ('skipped', 'failed') then
          skip_reason := 'Already in this campaign';
          outcome := 'skipped';
        else
          skip_reason := v_twin.skip_reason;
          outcome := 'already';
        end if;
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
    and (p.claimed_by = p_holder or p.claimed_at is null or p.claimed_at < now() - interval '10 minutes')
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

create or replace function private.campaign_fill_claimable(p_prospect crm.campaign_prospects)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_prospect.state in ('queued', 'filling', 'pushing')
    and (p_prospect.claimed_at is null or p_prospect.claimed_at < now() - interval '10 minutes')
    and (
      p_prospect.added_by_run_id is null
      or not exists (
        select 1 from crm.workflow_runs r
        where r.id = p_prospect.added_by_run_id and r.status in ('queued', 'running', 'waiting')
      )
    );
$$;

drop function if exists private.claim_campaign_fills(integer, text);

create or replace function private.claim_campaign_fills(p_limit integer, p_holder text)
returns table (prospect_id uuid, campaign_id uuid, workspace_id uuid, added_by_user_id uuid, provider text)
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
  set state = 'failed', skip_reason = 'The workflow run was stopped.', claimed_at = null, claimed_by = null
  where p.id in (
    select x.id from crm.campaign_prospects x
    join crm.workflow_runs r on r.id = x.added_by_run_id and r.status = 'cancelled'
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
    (select k.provider from crm.campaigns k where k.id = p.campaign_id);
end;
$$;

create or replace function private.campaign_fill_backlog()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from (
    select 1 from crm.campaign_prospects p
    where p.state in ('queued', 'filling', 'pushing') and private.campaign_fill_claimable(p)
    limit 5000
  ) waiting;
$$;

create or replace function private.campaign_fill_saved(p_workspace uuid, p_prospect uuid, p_holder text, p_values jsonb, p_sources jsonb)
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
  set "values" = coalesce(p_values, '{}'::jsonb),
      sources = coalesce(p_sources, '{}'::jsonb),
      filled_at = now(),
      linkedin = coalesce((select c.normalized_linkedin from crm.contacts c where c.id = p.contact_id and c.workspace_id = p.workspace_id), p.linkedin),
      email = coalesce((select c.normalized_email from crm.contacts c where c.id = p.contact_id and c.workspace_id = p.workspace_id), p.email)
  where p.id = p_prospect and p.workspace_id = p_workspace and p.state = 'filling' and p.claimed_by = p_holder;
  return found;
end;
$$;

create or replace function private.campaign_fill_end(p_workspace uuid, p_prospect uuid, p_holder text, p_state text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_state is null then
    update crm.campaign_prospects p
    set claimed_at = now() - interval '9 minutes'
    where p.id = p_prospect and p.workspace_id = p_workspace and p.claimed_by = p_holder
      and p.state in ('queued', 'filling', 'pushing');
    return found;
  end if;
  if p_state not in ('skipped', 'failed') then
    raise exception 'A fill ends skipped or failed.' using errcode = '22023';
  end if;
  update crm.campaign_prospects p
  set state = p_state,
      skip_reason = left(coalesce(nullif(btrim(p_reason), ''), case when p_state = 'skipped' then 'Skipped' else 'Failed' end), 500),
      claimed_at = null,
      claimed_by = null
  where p.id = p_prospect and p.workspace_id = p_workspace
    and p.state in ('queued', 'filling', 'pushing')
    and p.claimed_by = p_holder;
  return found;
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
  if v_row.contact_id is null then
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
    set state = 'skipped', skip_reason = v_reason, claimed_at = null, claimed_by = null
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

create or replace function private.campaign_push_done(p_workspace uuid, p_items jsonb)
returns table (prospect_id uuid, event_id uuid, contact_id uuid, workflow_id uuid, depth integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_item record;
  v_row crm.campaign_prospects%rowtype;
  v_workflow uuid;
  v_depth integer;
  v_event uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  for v_item in
    select x.id, left(nullif(x.external_lead_id, ''), 200) as external_lead_id, left(nullif(x.sender_id, ''), 200) as sender_id
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(id uuid, external_lead_id text, sender_id text)
  loop
    update crm.campaign_prospects p
    set state = 'pushed',
        pushed_at = coalesce(p.pushed_at, now()),
        claimed_at = null,
        claimed_by = null,
        sender_id = coalesce(v_item.sender_id, p.sender_id),
        external_lead_id = case
          when p.external_lead_id is null and v_item.external_lead_id is not null and not exists (
            select 1 from crm.campaign_prospects o where o.campaign_id = p.campaign_id and o.external_lead_id = v_item.external_lead_id and o.id <> p.id
          ) then v_item.external_lead_id
          else p.external_lead_id
        end
    where p.id = v_item.id and p.workspace_id = p_workspace and p.state = 'pushing'
    returning * into v_row;
    if v_row.id is null then
      continue;
    end if;
    v_workflow := null;
    v_depth := 0;
    if v_row.added_by_run_id is not null then
      select r.workflow_id, r.depth + 1 into v_workflow, v_depth from crm.workflow_runs r where r.id = v_row.added_by_run_id;
    end if;
    v_event := null;
    insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key, payload)
    values (
      p_workspace, v_row.campaign_id, v_row.id, 'added', now(), 'orbit:added:' || v_row.id::text,
      jsonb_strip_nulls(jsonb_build_object('sourceWorkflowId', v_workflow, 'depth', coalesce(v_depth, 0), 'senderId', v_row.sender_id))
    )
    on conflict on constraint campaign_events_dedupe do nothing
    returning e.id into v_event;
    update crm.campaign_prospects p
    set last_event_at = greatest(p.last_event_at, now())
    where p.id = v_row.id;
    prospect_id := v_row.id;
    event_id := v_event;
    contact_id := v_row.contact_id;
    workflow_id := v_workflow;
    depth := coalesce(v_depth, 0);
    v_row := null;
    return next;
  end loop;
end;
$$;

create or replace function private.campaign_push_undo(p_workspace uuid, p_prospects uuid[], p_holder text)
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
  update crm.campaign_prospects p
  set state = 'filling', claimed_at = now() - interval '9 minutes'
  where p.id = any(p_prospects) and p.workspace_id = p_workspace and p.state = 'pushing' and p.claimed_by = p_holder;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.campaign_push_undo(uuid, uuid[], text) from public;
grant execute on function private.campaign_push_undo(uuid, uuid[], text) to crm_app;

revoke all on function private.workspace_knows_address(uuid, text) from public;
revoke all on function private.campaign_person_block(uuid, text, uuid, uuid, uuid, text, text, boolean) from public;
revoke all on function private.campaign_add_prospects(uuid, uuid, uuid[], uuid, uuid, uuid) from public;
revoke all on function private.campaign_claim_fill(uuid, uuid, text) from public;
revoke all on function private.campaign_fill_claimable(crm.campaign_prospects) from public;
revoke all on function private.claim_campaign_fills(integer, text) from public;
revoke all on function private.campaign_fill_backlog() from public;
revoke all on function private.campaign_fill_saved(uuid, uuid, text, jsonb, jsonb) from public;
revoke all on function private.campaign_fill_end(uuid, uuid, text, text, text) from public;
revoke all on function private.campaign_push_begin(uuid, uuid, text) from public;
revoke all on function private.campaign_push_done(uuid, jsonb) from public;

grant execute on function private.workspace_knows_address(uuid, text) to crm_app;
grant execute on function private.campaign_add_prospects(uuid, uuid, uuid[], uuid, uuid, uuid) to crm_app;
grant execute on function private.campaign_claim_fill(uuid, uuid, text) to crm_app;
grant execute on function private.claim_campaign_fills(integer, text) to crm_app;
grant execute on function private.campaign_fill_backlog() to crm_app;
grant execute on function private.campaign_fill_saved(uuid, uuid, text, jsonb, jsonb) to crm_app;
grant execute on function private.campaign_fill_end(uuid, uuid, text, text, text) to crm_app;
grant execute on function private.campaign_push_begin(uuid, uuid, text) to crm_app;
grant execute on function private.campaign_push_done(uuid, jsonb) to crm_app;

alter table crm.campaign_prospects validate constraint campaign_prospects_claimed_by_length;

reset lock_timeout;

create index concurrently if not exists campaign_prospects_fill_idx on crm.campaign_prospects (created_at) where state in ('queued', 'filling', 'pushing');
