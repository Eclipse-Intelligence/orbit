create table if not exists crm.meta_lead_pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  page_id text not null,
  page_name text,
  linked_by uuid references crm.profiles (id) on delete set null,
  last_run_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_lead_pages_page_id check (page_id ~ '^[0-9]{1,40}$'),
  constraint meta_lead_pages_page_name check (page_name is null or char_length(page_name) <= 200),
  constraint meta_lead_pages_error check (last_error is null or char_length(last_error) <= 500),
  constraint meta_lead_pages_unique unique (page_id)
);

create index if not exists meta_lead_pages_workspace_idx on crm.meta_lead_pages (workspace_id);

create table if not exists crm.meta_leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references crm.workspaces (id) on delete set null,
  leadgen_id text not null,
  page_id text,
  form_id text,
  form_name text,
  ad_id text,
  ad_name text,
  adset_id text,
  adset_name text,
  campaign_id text,
  campaign_name text,
  platform text,
  is_organic boolean,
  lead_created_at timestamptz,
  answers jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  source text not null default 'Meta Lead Ad',
  received_via text not null default 'webhook',
  contact_id uuid references crm.contacts (id) on delete set null,
  company_id uuid references crm.companies (id) on delete set null,
  activity_id uuid references crm.activities (id) on delete set null,
  fetched_at timestamptz,
  filed_at timestamptz,
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_leads_leadgen_id check (leadgen_id ~ '^[0-9]{1,40}$'),
  constraint meta_leads_ids check (
    (page_id is null or page_id ~ '^[0-9]{1,40}$')
    and (form_id is null or form_id ~ '^[0-9]{1,40}$')
    and (ad_id is null or ad_id ~ '^[0-9]{1,40}$')
    and (adset_id is null or adset_id ~ '^[0-9]{1,40}$')
    and (campaign_id is null or campaign_id ~ '^[0-9]{1,40}$')
  ),
  constraint meta_leads_names check (
    char_length(coalesce(form_name, '')) <= 300
    and char_length(coalesce(ad_name, '')) <= 300
    and char_length(coalesce(adset_name, '')) <= 300
    and char_length(coalesce(campaign_name, '')) <= 300
    and char_length(coalesce(platform, '')) <= 40
    and char_length(coalesce(error, '')) <= 500
  ),
  constraint meta_leads_answers check (jsonb_typeof(answers) = 'array' and octet_length(answers::text) <= 65536),
  constraint meta_leads_payload check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  constraint meta_leads_received_via check (received_via in ('webhook', 'backup')),
  constraint meta_leads_unique unique (leadgen_id)
);

create index if not exists meta_leads_workspace_idx on crm.meta_leads (workspace_id, created_at desc);
create index if not exists meta_leads_waiting_idx on crm.meta_leads (page_id, created_at) where filed_at is null;
create index if not exists meta_leads_contact_idx on crm.meta_leads (contact_id) where contact_id is not null;
create index if not exists meta_leads_company_idx on crm.meta_leads (company_id) where company_id is not null;
create index if not exists meta_leads_activity_idx on crm.meta_leads (activity_id) where activity_id is not null;

alter table crm.meta_lead_pages enable row level security;
alter table crm.meta_lead_pages force row level security;
alter table crm.meta_leads enable row level security;
alter table crm.meta_leads force row level security;

drop policy if exists meta_lead_pages_read on crm.meta_lead_pages;
create policy meta_lead_pages_read on crm.meta_lead_pages for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists meta_lead_pages_admin_insert on crm.meta_lead_pages;
create policy meta_lead_pages_admin_insert on crm.meta_lead_pages for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and private.is_workspace_admin(workspace_id)
    and linked_by = (select private.session_user_id())
  );
drop policy if exists meta_lead_pages_admin_delete on crm.meta_lead_pages;
create policy meta_lead_pages_admin_delete on crm.meta_lead_pages for delete to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));

drop policy if exists meta_leads_admin_read on crm.meta_leads;
create policy meta_leads_admin_read on crm.meta_leads for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists meta_leads_admin_update on crm.meta_leads;
create policy meta_leads_admin_update on crm.meta_leads for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id))
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));

revoke all on crm.meta_lead_pages from public, anon, authenticated, crm_agent;
revoke all on crm.meta_leads from public, anon, authenticated, crm_agent;
grant select, insert, delete on crm.meta_lead_pages to authenticated;
grant select on crm.meta_leads to authenticated;
grant update (contact_id, company_id, activity_id, filed_at, error) on crm.meta_leads to authenticated;

drop trigger if exists meta_lead_pages_set_updated_at on crm.meta_lead_pages;
create trigger meta_lead_pages_set_updated_at
  before update on crm.meta_lead_pages
  for each row execute function private.set_updated_at();

drop trigger if exists meta_leads_set_updated_at on crm.meta_leads;
create trigger meta_leads_set_updated_at
  before update on crm.meta_leads
  for each row execute function private.set_updated_at();

create or replace function private.meta_lead_store(
  p_leadgen_id text,
  p_page_id text,
  p_form_id text,
  p_ad_id text,
  p_via text,
  p_lead jsonb,
  p_payload jsonb,
  p_error text
)
returns table (id uuid, workspace_id uuid, fetched boolean, filed boolean, linked_by uuid)
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

  select p.workspace_id into v_workspace
  from crm.meta_lead_pages p
  where p.page_id = p_page_id;

  insert into crm.meta_leads as l (
    leadgen_id, workspace_id, page_id, form_id, ad_id, received_via, payload, error, attempts
  ) values (
    p_leadgen_id, v_workspace, p_page_id, p_form_id, p_ad_id,
    case when p_via = 'backup' then 'backup' else 'webhook' end,
    coalesce(p_payload, '{}'::jsonb), left(p_error, 500), 0
  )
  on conflict (leadgen_id) do update set
    page_id = coalesce(l.page_id, excluded.page_id),
    form_id = coalesce(l.form_id, excluded.form_id),
    ad_id = coalesce(l.ad_id, excluded.ad_id),
    workspace_id = coalesce(l.workspace_id, v_workspace),
    payload = case when l.fetched_at is null then l.payload || excluded.payload else l.payload end,
    error = case when l.filed_at is null and p_error is not null then left(p_error, 500) else l.error end;

  if p_lead is not null then
    update crm.meta_leads l set
      form_id = coalesce(nullif(p_lead->>'form_id', ''), l.form_id),
      form_name = coalesce(nullif(left(p_lead->>'form_name', 300), ''), l.form_name),
      ad_id = coalesce(nullif(p_lead->>'ad_id', ''), l.ad_id),
      ad_name = nullif(left(p_lead->>'ad_name', 300), ''),
      adset_id = nullif(p_lead->>'adset_id', ''),
      adset_name = nullif(left(p_lead->>'adset_name', 300), ''),
      campaign_id = nullif(p_lead->>'campaign_id', ''),
      campaign_name = nullif(left(p_lead->>'campaign_name', 300), ''),
      platform = nullif(left(p_lead->>'platform', 40), ''),
      is_organic = case when jsonb_typeof(p_lead->'is_organic') = 'boolean' then (p_lead->>'is_organic')::boolean else null end,
      lead_created_at = case when p_lead->>'created_at' is not null then (p_lead->>'created_at')::timestamptz else null end,
      answers = case when jsonb_typeof(p_lead->'answers') = 'array' then p_lead->'answers' else '[]'::jsonb end,
      payload = l.payload || coalesce(p_payload, '{}'::jsonb),
      fetched_at = now(),
      error = null
    where l.leadgen_id = p_leadgen_id and l.fetched_at is null;
  end if;

  return query
  select l.id, l.workspace_id, l.fetched_at is not null, l.filed_at is not null, p.linked_by
  from crm.meta_leads l
  left join crm.meta_lead_pages p on p.page_id = l.page_id and p.workspace_id = l.workspace_id
  where l.leadgen_id = p_leadgen_id;
end;
$$;

revoke all on function private.meta_lead_store(text, text, text, text, text, jsonb, jsonb, text) from public;
grant execute on function private.meta_lead_store(text, text, text, text, text, jsonb, jsonb, text) to crm_app;

create or replace function private.meta_lead_failed(p_id uuid, p_error text)
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
  set error = left(p_error, 500), attempts = attempts + 1
  where id = p_id and filed_at is null;
end;
$$;

revoke all on function private.meta_lead_failed(uuid, text) from public;
grant execute on function private.meta_lead_failed(uuid, text) to crm_app;

create or replace function private.meta_leads_waiting(p_limit integer, p_min_age_seconds integer default 120)
returns table (id uuid, workspace_id uuid, leadgen_id text, page_id text, form_id text, ad_id text, fetched boolean, linked_by uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update crm.meta_leads l
  set workspace_id = p.workspace_id
  from crm.meta_lead_pages p
  where l.workspace_id is null and l.filed_at is null and p.page_id = l.page_id;

  return query
  select l.id, l.workspace_id, l.leadgen_id, l.page_id, l.form_id, l.ad_id, l.fetched_at is not null, p.linked_by
  from crm.meta_leads l
  left join crm.meta_lead_pages p on p.page_id = l.page_id and p.workspace_id = l.workspace_id
  where l.filed_at is null
    and l.attempts < 10
    and l.updated_at <= now() - make_interval(secs => p_min_age_seconds)
    and (l.fetched_at is null or l.workspace_id is not null)
  order by l.created_at
  limit greatest(1, least(p_limit, 200));
end;
$$;

revoke all on function private.meta_leads_waiting(integer, integer) from public;
grant execute on function private.meta_leads_waiting(integer, integer) to crm_app;

create or replace function private.meta_lead_pages_due(p_every interval)
returns table (id uuid, workspace_id uuid, page_id text, page_name text, linked_by uuid, last_run_at timestamptz, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select p.id, p.workspace_id, p.page_id, p.page_name, p.linked_by, p.last_run_at, p.created_at
  from crm.meta_lead_pages p
  where p.last_attempt_at is null or p.last_attempt_at < now() - p_every
  order by p.last_attempt_at nulls first, p.created_at;
end;
$$;

revoke all on function private.meta_lead_pages_due(interval) from public;
grant execute on function private.meta_lead_pages_due(interval) to crm_app;

create or replace function private.meta_lead_page_ran(p_id uuid, p_started timestamptz, p_ok boolean, p_error text, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.meta_lead_pages
  set last_attempt_at = p_started,
      last_run_at = case when p_ok then p_started else last_run_at end,
      last_error = case when p_ok then null else left(p_error, 500) end,
      page_name = coalesce(nullif(left(p_name, 200), ''), page_name)
  where id = p_id;
end;
$$;

revoke all on function private.meta_lead_page_ran(uuid, timestamptz, boolean, text, text) from public;
grant execute on function private.meta_lead_page_ran(uuid, timestamptz, boolean, text, text) to crm_app;

create or replace function private.meta_unlinked_pages()
returns table (page_id text, leads integer, last_at timestamptz)
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
  select l.page_id, count(*)::integer, max(l.created_at)
  from crm.meta_leads l
  where l.workspace_id is null and l.filed_at is null and l.page_id is not null
    and not exists (select 1 from crm.meta_lead_pages p where p.page_id = l.page_id)
  group by l.page_id
  order by max(l.created_at) desc
  limit 50;
end;
$$;

revoke all on function private.meta_unlinked_pages() from public;
grant execute on function private.meta_unlinked_pages() to crm_app;
