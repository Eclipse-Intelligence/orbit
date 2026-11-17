set lock_timeout = '5s';

alter table crm.agents drop constraint if exists agents_scopes_valid;
alter table crm.agents
  add constraint agents_scopes_valid check (
    scopes <@ array['crm:read', 'companies:write', 'contacts:write', 'leads:write', 'activities:write', 'opportunities:write', 'tasks:write', 'market:write', 'docs:read', 'docs:write', 'campaigns:write', 'admin']::text[]
    and cardinality(scopes) > 0
  );

create table if not exists crm.campaign_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  provider text not null,
  key_encrypted text not null,
  key_fingerprint text not null,
  details jsonb not null default '{}'::jsonb,
  webhook_secret text,
  connected_by uuid references crm.profiles (id) on delete set null,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_connections_provider check (provider in ('smartlead', 'heyreach')),
  constraint campaign_connections_workspace_provider unique (workspace_id, provider),
  constraint campaign_connections_fingerprint_length check (char_length(key_fingerprint) between 16 and 200),
  constraint campaign_connections_error_length check (last_error is null or char_length(last_error) <= 500)
);

create unique index if not exists campaign_connections_fingerprint_uidx
  on crm.campaign_connections (provider, key_fingerprint);

create table if not exists crm.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  provider text not null,
  channel text not null,
  external_id text not null,
  name text not null default '',
  status text not null default 'drafted',
  sequence jsonb not null default '[]'::jsonb,
  variables text[] not null default '{}',
  stats jsonb not null default '{}'::jsonb,
  step_stats jsonb not null default '[]'::jsonb,
  sender_ids text[] not null default '{}',
  sync_state jsonb not null default '{}'::jsonb,
  sync_error text,
  backfilled_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_provider check (provider in ('smartlead', 'heyreach')),
  constraint campaigns_channel check (
    (provider = 'smartlead' and channel = 'email') or (provider = 'heyreach' and channel = 'linkedin')
  ),
  constraint campaigns_status check (status in ('active', 'paused', 'drafted', 'completed', 'stopped', 'archived')),
  constraint campaigns_external_id_length check (char_length(external_id) between 1 and 200),
  constraint campaigns_name_length check (char_length(name) <= 500),
  constraint campaigns_sync_error_length check (sync_error is null or char_length(sync_error) <= 500),
  constraint campaigns_external unique (workspace_id, provider, external_id),
  constraint campaigns_id_workspace unique (id, workspace_id)
);

create index if not exists campaigns_workspace_status_idx on crm.campaigns (workspace_id, status);

create table if not exists crm.campaign_prospects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  campaign_id uuid not null,
  contact_id uuid references crm.contacts (id) on delete set null,
  company_id uuid references crm.companies (id) on delete set null,
  email text,
  linkedin text,
  sender_id text,
  lead jsonb not null default '{}'::jsonb,
  state text not null default 'queued',
  skip_reason text,
  "values" jsonb not null default '{}'::jsonb,
  sources jsonb not null default '{}'::jsonb,
  external_lead_id text,
  lead_status text,
  category text,
  claimed_at timestamptz,
  pushed_at timestamptz,
  replied_at timestamptz,
  stop_requested_at timestamptz,
  stopped_at timestamptz,
  last_event_at timestamptz,
  import_error text,
  sync_requested_at timestamptz,
  added_by_user_id uuid references crm.profiles (id) on delete set null,
  added_by_run_id uuid references crm.workflow_runs (id) on delete set null,
  added_by_agent_id uuid references crm.agents (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_prospects_campaign_fk foreign key (campaign_id, workspace_id)
    references crm.campaigns (id, workspace_id) on delete cascade,
  constraint campaign_prospects_state check (state in ('queued', 'filling', 'pushing', 'pushed', 'skipped', 'failed')),
  constraint campaign_prospects_email_length check (email is null or char_length(email) between 3 and 320),
  constraint campaign_prospects_linkedin_length check (linkedin is null or char_length(linkedin) between 1 and 500),
  constraint campaign_prospects_text_lengths check (
    (skip_reason is null or char_length(skip_reason) <= 500)
    and (external_lead_id is null or char_length(external_lead_id) between 1 and 200)
    and (lead_status is null or char_length(lead_status) <= 100)
    and (category is null or char_length(category) <= 200)
    and (sender_id is null or char_length(sender_id) <= 200)
    and (import_error is null or char_length(import_error) <= 300)
  )
);

create unique index if not exists campaign_prospects_contact_uidx
  on crm.campaign_prospects (campaign_id, contact_id) where contact_id is not null;
create unique index if not exists campaign_prospects_lead_uidx
  on crm.campaign_prospects (campaign_id, external_lead_id) where external_lead_id is not null;
create index if not exists campaign_prospects_campaign_idx on crm.campaign_prospects (campaign_id, created_at);
create index if not exists campaign_prospects_email_idx on crm.campaign_prospects (campaign_id, email) where email is not null;
create index if not exists campaign_prospects_contact_idx on crm.campaign_prospects (workspace_id, contact_id) where contact_id is not null;
create index if not exists campaign_prospects_company_idx on crm.campaign_prospects (workspace_id, company_id) where company_id is not null;
create index if not exists campaign_prospects_unlinked_idx on crm.campaign_prospects (campaign_id) where contact_id is null;

create table if not exists crm.campaign_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  campaign_id uuid not null,
  prospect_id uuid not null references crm.campaign_prospects (id) on delete cascade,
  kind text not null,
  step integer,
  variant text,
  occurred_at timestamptz not null,
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint campaign_events_campaign_fk foreign key (campaign_id, workspace_id)
    references crm.campaigns (id, workspace_id) on delete cascade,
  constraint campaign_events_kind check (kind in (
    'added', 'sent', 'opened', 'clicked', 'engaged', 'replied', 'bounced', 'unsubscribed', 'category',
    'invite_sent', 'invite_accepted', 'message_sent', 'inmail_sent'
  )),
  constraint campaign_events_dedupe_length check (char_length(dedupe_key) between 1 and 500),
  constraint campaign_events_variant_length check (variant is null or char_length(variant) <= 100),
  constraint campaign_events_dedupe unique (campaign_id, dedupe_key)
);

create index if not exists campaign_events_campaign_idx on crm.campaign_events (campaign_id, occurred_at);
create index if not exists campaign_events_prospect_idx on crm.campaign_events (prospect_id, occurred_at);
create index if not exists campaign_events_unhandled_idx on crm.campaign_events (campaign_id, created_at) where handled_at is null;

drop trigger if exists campaign_connections_set_updated_at on crm.campaign_connections;
create trigger campaign_connections_set_updated_at
  before update on crm.campaign_connections
  for each row execute function private.set_updated_at();
drop trigger if exists campaigns_set_updated_at on crm.campaigns;
create trigger campaigns_set_updated_at
  before update on crm.campaigns
  for each row execute function private.set_updated_at();
drop trigger if exists campaign_prospects_set_updated_at on crm.campaign_prospects;
create trigger campaign_prospects_set_updated_at
  before update on crm.campaign_prospects
  for each row execute function private.set_updated_at();

create or replace function private.agent_has_scope(p_scope text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.agents a
    where a.id = nullif(current_setting('app.agent_id', true), '')::uuid
      and a.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
      and (p_scope = any(a.scopes) or 'admin' = any(a.scopes))
  );
$$;

revoke all on function private.agent_has_scope(text) from public;
grant execute on function private.agent_has_scope(text) to crm_agent;

alter table crm.campaign_connections enable row level security;
alter table crm.campaign_connections force row level security;
alter table crm.campaigns enable row level security;
alter table crm.campaigns force row level security;
alter table crm.campaign_prospects enable row level security;
alter table crm.campaign_prospects force row level security;
alter table crm.campaign_events enable row level security;
alter table crm.campaign_events force row level security;

drop policy if exists campaign_connections_select_member on crm.campaign_connections;
create policy campaign_connections_select_member on crm.campaign_connections
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists campaign_connections_insert_admin on crm.campaign_connections;
create policy campaign_connections_insert_admin on crm.campaign_connections
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists campaign_connections_update_admin on crm.campaign_connections;
create policy campaign_connections_update_admin on crm.campaign_connections
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id))
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists campaign_connections_delete_admin on crm.campaign_connections;
create policy campaign_connections_delete_admin on crm.campaign_connections
  for delete to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists campaign_connections_select_agent on crm.campaign_connections;
create policy campaign_connections_select_agent on crm.campaign_connections
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));

drop policy if exists campaigns_select_member on crm.campaigns;
create policy campaigns_select_member on crm.campaigns
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists campaigns_select_agent on crm.campaigns;
create policy campaigns_select_agent on crm.campaigns
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));

drop policy if exists campaign_prospects_select_member on crm.campaign_prospects;
create policy campaign_prospects_select_member on crm.campaign_prospects
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists campaign_prospects_update_member on crm.campaign_prospects;
create policy campaign_prospects_update_member on crm.campaign_prospects
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and contact_id is null)
  with check (
    workspace_id in (select private.user_workspace_ids())
    and contact_id is not null
    and exists (select 1 from crm.contacts c where c.id = contact_id and c.workspace_id = campaign_prospects.workspace_id and c.archived_at is null)
    and (company_id is null or exists (select 1 from crm.companies c where c.id = company_id and c.workspace_id = campaign_prospects.workspace_id))
  );
drop policy if exists campaign_prospects_select_agent on crm.campaign_prospects;
create policy campaign_prospects_select_agent on crm.campaign_prospects
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));
drop policy if exists campaign_prospects_update_agent on crm.campaign_prospects;
create policy campaign_prospects_update_agent on crm.campaign_prospects
  for update to crm_agent
  using (workspace_id = (select private.request_workspace_id()) and contact_id is null and (select private.agent_has_scope('campaigns:write')))
  with check (
    workspace_id = (select private.request_workspace_id())
    and contact_id is not null
    and exists (select 1 from crm.contacts c where c.id = contact_id and c.workspace_id = campaign_prospects.workspace_id and c.archived_at is null)
    and (company_id is null or exists (select 1 from crm.companies c where c.id = company_id and c.workspace_id = campaign_prospects.workspace_id))
  );

drop policy if exists campaign_events_select_member on crm.campaign_events;
create policy campaign_events_select_member on crm.campaign_events
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists campaign_events_select_agent on crm.campaign_events;
create policy campaign_events_select_agent on crm.campaign_events
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));

revoke all on crm.campaign_connections from anon, authenticated, crm_agent;
revoke all on crm.campaigns from anon, authenticated, crm_agent;
revoke all on crm.campaign_prospects from anon, authenticated, crm_agent;
revoke all on crm.campaign_events from anon, authenticated, crm_agent;

grant select (id, workspace_id, provider, details, connected_by, last_synced_at, last_error, created_at, updated_at)
  on crm.campaign_connections to authenticated, crm_agent;
grant insert (workspace_id, provider, key_encrypted, key_fingerprint, details, connected_by)
  on crm.campaign_connections to authenticated;
grant update (key_encrypted, key_fingerprint, details, connected_by, last_synced_at, last_error)
  on crm.campaign_connections to authenticated;
grant delete on crm.campaign_connections to authenticated;

grant select on crm.campaigns to authenticated, crm_agent;
grant select on crm.campaign_prospects to authenticated, crm_agent;
grant update (contact_id, company_id) on crm.campaign_prospects to authenticated, crm_agent;
grant select on crm.campaign_events to authenticated, crm_agent;

create or replace function private.campaign_prospect_active(p_state text, p_stopped_at timestamptz, p_lead_status text, p_campaign_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_campaign_status, '') not in ('completed', 'stopped', 'archived')
    and (
      p_state in ('queued', 'filling', 'pushing')
      or (p_state = 'pushed' and p_stopped_at is null and coalesce(p_lead_status, '') not in ('completed', 'stopped', 'blocked', 'unsubscribed', 'bounced'))
    );
$$;

revoke all on function private.campaign_prospect_active(text, timestamptz, text, text) from public;

create or replace function private.campaign_key_taken(p_provider text, p_fingerprint text, p_workspace uuid)
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
    select 1 from crm.campaign_connections c
    where c.provider = p_provider and c.key_fingerprint = p_fingerprint and c.workspace_id <> p_workspace
  );
end;
$$;

create or replace function private.campaign_connection_key(p_workspace uuid, p_provider text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select c.key_encrypted into v_key
  from crm.campaign_connections c
  where c.workspace_id = p_workspace and c.provider = p_provider;
  return v_key;
end;
$$;

create or replace function private.campaign_connection_targets(p_workspace uuid default null)
returns table (
  connection_id uuid,
  workspace_id uuid,
  provider text,
  key_encrypted text,
  key_fingerprint text,
  connected_by uuid,
  details jsonb,
  last_synced_at timestamptz
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
  select c.id, c.workspace_id, c.provider, c.key_encrypted, c.key_fingerprint, c.connected_by, c.details, c.last_synced_at
  from crm.campaign_connections c
  where p_workspace is null or c.workspace_id = p_workspace
  order by c.last_synced_at nulls first, c.created_at;
end;
$$;

create or replace function private.campaign_connection_finish(p_connection uuid, p_key_fingerprint text, p_error text, p_details jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_connections c
  set last_synced_at = case when p_error is null then now() else c.last_synced_at end,
      last_error = left(p_error, 500),
      details = c.details || coalesce(p_details, '{}'::jsonb)
  where c.id = p_connection and c.key_fingerprint = p_key_fingerprint;
end;
$$;

create or replace function private.campaign_sync_campaigns(p_workspace uuid, p_provider text, p_channel text, p_items jsonb)
returns table (
  id uuid,
  external_id text,
  name text,
  status text,
  backfilled_at timestamptz,
  synced_at timestamptz,
  sync_state jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from crm.campaign_connections c where c.workspace_id = p_workspace and c.provider = p_provider) then
    return;
  end if;
  insert into crm.campaigns as k (workspace_id, provider, channel, external_id, name, status)
  select distinct on (left(x.external_id, 200)) p_workspace, p_provider, p_channel, left(x.external_id, 200), left(coalesce(x.name, ''), 500), x.status
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(external_id text, name text, status text)
  where coalesce(x.external_id, '') <> ''
  order by left(x.external_id, 200)
  on conflict on constraint campaigns_external do update
  set name = excluded.name,
      status = excluded.status
  where (k.name, k.status) is distinct from (excluded.name, excluded.status);

  return query
  select k.id, k.external_id, k.name, k.status, k.backfilled_at, k.synced_at, k.sync_state
  from crm.campaigns k
  where k.workspace_id = p_workspace and k.provider = p_provider
  order by (k.backfilled_at is not null), k.synced_at nulls first, k.created_at;
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
      sender_ids = case
        when p_patch ? 'senderIds' then array(select jsonb_array_elements_text(p_patch -> 'senderIds'))
        else k.sender_ids
      end,
      sync_state = case
        when p_patch ? 'syncState' then jsonb_strip_nulls(k.sync_state || (p_patch -> 'syncState'))
        else k.sync_state
      end,
      backfilled_at = case when coalesce((p_patch ->> 'backfilled')::boolean, false) then coalesce(k.backfilled_at, now()) else k.backfilled_at end,
      synced_at = now()
  where k.id = p_campaign;
end;
$$;

create or replace function private.campaign_link_contacts(p_campaign uuid, p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_linked integer;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with unlinked as (
    select p.id, p.workspace_id, p.email, p.linkedin, p.created_at
    from crm.campaign_prospects p
    where p.campaign_id = p_campaign and p.contact_id is null and (p_ids is null or p.id = any(p_ids))
  ),
  found as (
    select u.id as prospect_id, u.created_at, c.id as contact_id, c.company_id, c.created_at as contact_created, 0 as rank
    from unlinked u
    join crm.contacts c on c.workspace_id = u.workspace_id and c.normalized_email = u.email and c.archived_at is null
    where u.email is not null
    union all
    select u.id, u.created_at, c.id, c.company_id, c.created_at, 1
    from unlinked u
    join crm.contacts c on c.workspace_id = u.workspace_id and c.normalized_linkedin = u.linkedin and c.archived_at is null
    where u.linkedin is not null
  ),
  free as (
    select f.* from found f
    where not exists (select 1 from crm.campaign_prospects o where o.campaign_id = p_campaign and o.contact_id = f.contact_id)
  ),
  best as (
    select distinct on (f.prospect_id) f.prospect_id, f.created_at, f.contact_id, f.company_id
    from free f
    order by f.prospect_id, f.rank, f.contact_created, f.contact_id
  ),
  chosen as (
    select distinct on (b.contact_id) b.prospect_id, b.contact_id, b.company_id
    from best b
    order by b.contact_id, b.created_at, b.prospect_id
  )
  update crm.campaign_prospects p
  set contact_id = chosen.contact_id,
      company_id = coalesce(p.company_id, chosen.company_id)
  from chosen
  where p.id = chosen.prospect_id and p.contact_id is null;
  get diagnostics v_linked = row_count;
  return v_linked;
end;
$$;

create or replace function private.campaign_sync_prospects(p_campaign uuid, p_leads jsonb)
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
      x.added_at
    from jsonb_to_recordset(coalesce(p_leads, '[]'::jsonb))
      as x(external_id text, email text, linkedin text, lead jsonb, lead_status text, category text, added_at timestamptz)
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
      order by p.created_at
      limit 1;
    end if;
    if v_id is null and v_lead.linkedin is not null then
      select p.id into v_id from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.linkedin = v_lead.linkedin
        and (p.external_lead_id is null or v_lead.external_id is null)
      order by p.created_at
      limit 1;
    end if;
    if v_id is null then
      insert into crm.campaign_prospects (
        workspace_id, campaign_id, email, linkedin, lead, state, external_lead_id, lead_status, category, pushed_at
      ) values (
        v_campaign.workspace_id, p_campaign, v_lead.email, v_lead.linkedin, v_lead.lead, 'pushed',
        v_lead.external_id, v_lead.lead_status, v_lead.category, coalesce(v_lead.added_at, now())
      )
      returning id into v_id;
    else
      update crm.campaign_prospects p
      set external_lead_id = coalesce(p.external_lead_id, v_lead.external_id),
          email = coalesce(p.email, v_lead.email),
          linkedin = coalesce(p.linkedin, v_lead.linkedin),
          lead = p.lead || v_lead.lead,
          lead_status = coalesce(v_lead.lead_status, p.lead_status),
          category = coalesce(v_lead.category, p.category),
          pushed_at = coalesce(p.pushed_at, v_lead.added_at)
      where p.id = v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  perform private.campaign_link_contacts(p_campaign, v_ids);
  return coalesce(cardinality(v_ids), 0);
end;
$$;

drop function if exists private.campaign_sync_events(uuid, jsonb);

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
    v_prospect := null;
    if v_event.external_lead_id is not null then
      select p.id, p.contact_id into v_prospect, v_contact from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.external_lead_id = v_event.external_lead_id;
    end if;
    if v_prospect is null and v_event.email is not null then
      select p.id, p.contact_id into v_prospect, v_contact from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.email = v_event.email
      order by p.external_lead_id is null, p.created_at
      limit 1;
    end if;
    if v_prospect is null and v_event.linkedin is not null then
      select p.id, p.contact_id into v_prospect, v_contact from crm.campaign_prospects p
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

    v_inserted := null;
    insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, step, variant, occurred_at, dedupe_key, payload, handled_at)
    values (v_campaign.workspace_id, p_campaign, v_prospect, v_event.kind, v_event.step, v_event.variant,
      v_event.occurred_at, v_event.dedupe_key, v_event.payload, case when p_handled then now() end)
    on conflict on constraint campaign_events_dedupe do nothing
    returning e.id into v_inserted;

    update crm.campaign_prospects p
    set last_event_at = greatest(p.last_event_at, v_event.occurred_at),
        replied_at = case when v_event.kind = 'replied' then least(coalesce(p.replied_at, v_event.occurred_at), v_event.occurred_at) else p.replied_at end,
        category = coalesce(v_event.category, p.category)
    where p.id = v_prospect
      and (
        p.last_event_at is distinct from greatest(p.last_event_at, v_event.occurred_at)
        or (v_event.kind = 'replied' and (p.replied_at is null or p.replied_at > v_event.occurred_at))
        or (v_event.category is not null and p.category is distinct from v_event.category)
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

create or replace function private.campaign_unhandled_events(p_campaign uuid, p_limit integer)
returns table (event_id uuid, prospect_id uuid, contact_id uuid, kind text, occurred_at timestamptz)
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
  select e.id, e.prospect_id, p.contact_id, e.kind, e.occurred_at
  from crm.campaign_events e
  join crm.campaign_prospects p on p.id = e.prospect_id
  where e.campaign_id = p_campaign and e.handled_at is null
  order by e.created_at, e.id
  limit least(greatest(p_limit, 1), 1000);
end;
$$;

create or replace function private.campaign_events_handled(p_campaign uuid, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_events e set handled_at = now()
  where e.campaign_id = p_campaign and e.id = any(p_ids) and e.handled_at is null;
end;
$$;

create or replace function private.campaign_prospect_import_failed(p_workspace uuid, p_prospect uuid, p_reason text)
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
  set import_error = left(coalesce(nullif(btrim(p_reason), ''), 'Couldn''t add this person.'), 300)
  where p.id = p_prospect and p.workspace_id = p_workspace and p.contact_id is null;
end;
$$;

revoke all on function private.campaign_prospect_import_failed(uuid, uuid, text) from public;
grant execute on function private.campaign_prospect_import_failed(uuid, uuid, text) to crm_app;

revoke all on function private.campaign_unhandled_events(uuid, integer) from public;
revoke all on function private.campaign_events_handled(uuid, uuid[]) from public;
grant execute on function private.campaign_unhandled_events(uuid, integer) to crm_app;
grant execute on function private.campaign_events_handled(uuid, uuid[]) to crm_app;

revoke all on function private.campaign_key_taken(text, text, uuid) from public;
revoke all on function private.campaign_connection_key(uuid, text) from public;
revoke all on function private.campaign_connection_targets(uuid) from public;
revoke all on function private.campaign_connection_finish(uuid, text, text, jsonb) from public;
revoke all on function private.campaign_sync_campaigns(uuid, text, text, jsonb) from public;
revoke all on function private.campaign_sync_update(uuid, jsonb) from public;
revoke all on function private.campaign_link_contacts(uuid, uuid[]) from public;
revoke all on function private.campaign_sync_prospects(uuid, jsonb) from public;
revoke all on function private.campaign_sync_events(uuid, jsonb, boolean) from public;
grant execute on function private.campaign_key_taken(text, text, uuid) to crm_app;
grant execute on function private.campaign_connection_key(uuid, text) to crm_app;
grant execute on function private.campaign_connection_targets(uuid) to crm_app;
grant execute on function private.campaign_connection_finish(uuid, text, text, jsonb) to crm_app;
grant execute on function private.campaign_sync_campaigns(uuid, text, text, jsonb) to crm_app;
grant execute on function private.campaign_sync_update(uuid, jsonb) to crm_app;
grant execute on function private.campaign_link_contacts(uuid, uuid[]) to crm_app;
grant execute on function private.campaign_sync_prospects(uuid, jsonb) to crm_app;
grant execute on function private.campaign_sync_events(uuid, jsonb, boolean) to crm_app;

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

  perform set_config('orbit.merging', 'off', true);

  return v_result || jsonb_build_object(
    'activityIds', coalesce((select jsonb_agg(m.new_id) from pg_temp.orbit_move_map m where m.kind = 'activity'), '[]'::jsonb),
    'taskMoves', v_task_moves,
    'tasksLeft', v_tasks_left
  );
end;
$$;

revoke all on function private.move_records_to_workspace(uuid, uuid, uuid, jsonb, boolean) from public;
grant execute on function private.move_records_to_workspace(uuid, uuid, uuid, jsonb, boolean) to crm_app;

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

  for prospect in
    select dup.id as merge_id, kept.id as keep_id, dup.replied_at, dup.last_event_at, dup.external_lead_id, dup.email, dup.linkedin
    from crm.campaign_prospects dup
    join crm.campaign_prospects kept
      on kept.campaign_id = dup.campaign_id and kept.contact_id = p_keep and kept.workspace_id = p_workspace
    where dup.workspace_id = p_workspace and dup.contact_id = p_merge
    order by dup.id
    for update of dup, kept
  loop
    update crm.campaign_events e set prospect_id = prospect.keep_id where e.prospect_id = prospect.merge_id;
    update crm.campaign_prospects k
    set replied_at = case
          when k.replied_at is null then prospect.replied_at
          when prospect.replied_at is null then k.replied_at
          else least(k.replied_at, prospect.replied_at)
        end,
        last_event_at = greatest(k.last_event_at, prospect.last_event_at)
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

  perform set_config('orbit.merging', 'off', true);

  return moved || jsonb_build_object(
    'calendar_events', calendar_replaced,
    'calendar_events_shared', calendar_shared,
    'workflow_record_marks', marks,
    'follow_up_suggestions', follow_ups,
    'mail_thread_routes', routes,
    'page_links', links_dropped + links_moved,
    'campaign_prospects_combined', prospects_combined
  );
end;
$$;

revoke all on function private.merge_company_references(uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) from public;
grant execute on function private.merge_company_references(uuid, uuid, uuid, uuid, uuid) to crm_app;
grant execute on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) to crm_app;

reset lock_timeout;
