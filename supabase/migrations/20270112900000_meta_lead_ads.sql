create table if not exists crm.meta_lead_pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  page_id text not null,
  page_name text,
  linked_by uuid references crm.profiles (id) on delete set null,
  full_history boolean not null default false,
  last_run_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  pending boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_lead_pages_page_id check (page_id ~ '^[0-9]{1,40}$'),
  constraint meta_lead_pages_page_name check (page_name is null or char_length(page_name) <= 200),
  constraint meta_lead_pages_error check (last_error is null or char_length(last_error) <= 500),
  constraint meta_lead_pages_unique unique (page_id)
);

create index if not exists meta_lead_pages_workspace_idx on crm.meta_lead_pages (workspace_id);

create table if not exists crm.meta_lead_forms (
  page_id text not null,
  form_id text not null,
  form_name text,
  last_run_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  list_since timestamptz,
  list_after text,
  list_started_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (page_id, form_id),
  constraint meta_lead_forms_ids check (page_id ~ '^[0-9]{1,40}$' and form_id ~ '^[0-9]{1,40}$'),
  constraint meta_lead_forms_text check (
    char_length(coalesce(form_name, '')) <= 300
    and char_length(coalesce(last_error, '')) <= 500
    and char_length(coalesce(list_after, '')) <= 2000
  )
);

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
  held_at timestamptz,
  released_to uuid references crm.workspaces (id) on delete set null,
  contact_id uuid references crm.contacts (id) on delete set null,
  company_id uuid references crm.companies (id) on delete set null,
  activity_id uuid references crm.activities (id) on delete set null,
  fetched_at timestamptz,
  filed_at timestamptz,
  notified_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
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
create index if not exists meta_leads_unnotified_idx on crm.meta_leads (filed_at) where notified_at is null and filed_at is not null;
create index if not exists meta_leads_contact_idx on crm.meta_leads (contact_id) where contact_id is not null;
create index if not exists meta_leads_company_idx on crm.meta_leads (company_id) where company_id is not null;
create index if not exists meta_leads_activity_idx on crm.meta_leads (activity_id) where activity_id is not null;
create index if not exists meta_leads_released_idx on crm.meta_leads (released_to) where released_to is not null;
create index if not exists meta_leads_due_idx on crm.meta_leads (next_attempt_at) where filed_at is null and (workspace_id is not null or fetched_at is null);

alter table crm.meta_lead_pages enable row level security;
alter table crm.meta_lead_pages force row level security;
alter table crm.meta_lead_forms enable row level security;
alter table crm.meta_lead_forms force row level security;
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
    and not full_history
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
revoke all on crm.meta_lead_forms from public, anon, authenticated, crm_agent;
revoke all on crm.meta_leads from public, anon, authenticated, crm_agent;
grant select, delete on crm.meta_lead_pages to authenticated;
grant insert (workspace_id, page_id, linked_by) on crm.meta_lead_pages to authenticated;
grant select on crm.meta_leads to authenticated;
grant update (contact_id, company_id, activity_id, filed_at, error) on crm.meta_leads to authenticated;

drop trigger if exists meta_lead_pages_set_updated_at on crm.meta_lead_pages;
create trigger meta_lead_pages_set_updated_at
  before update on crm.meta_lead_pages
  for each row execute function private.set_updated_at();

drop trigger if exists meta_lead_forms_set_updated_at on crm.meta_lead_forms;
create trigger meta_lead_forms_set_updated_at
  before update on crm.meta_lead_forms
  for each row execute function private.set_updated_at();

drop trigger if exists meta_leads_set_updated_at on crm.meta_leads;
create trigger meta_leads_set_updated_at
  before update on crm.meta_leads
  for each row execute function private.set_updated_at();

create or replace function private.meta_lead_same_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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

drop trigger if exists meta_leads_same_workspace on crm.meta_leads;
create trigger meta_leads_same_workspace
  before update of contact_id, company_id, activity_id on crm.meta_leads
  for each row execute function private.meta_lead_same_workspace();

create or replace function private.meta_lead_filed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.filed_at is null and new.filed_at is not null then
    new.attempts := 0;
    new.next_attempt_at := null;
  end if;
  return new;
end;
$$;

revoke all on function private.meta_lead_filed() from public;

drop trigger if exists meta_leads_filed on crm.meta_leads;
create trigger meta_leads_filed
  before update of filed_at on crm.meta_leads
  for each row execute function private.meta_lead_filed();

create or replace function private.meta_lead_page_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update crm.meta_leads l
  set workspace_id = null, held_at = coalesce(l.held_at, now())
  where l.page_id = old.page_id and l.filed_at is null;
  delete from crm.meta_lead_forms f where f.page_id = old.page_id;
  return old;
end;
$$;

revoke all on function private.meta_lead_page_removed() from public;

drop trigger if exists meta_lead_pages_removed on crm.meta_lead_pages;
create trigger meta_lead_pages_removed
  after delete on crm.meta_lead_pages
  for each row execute function private.meta_lead_page_removed();

create or replace function private.meta_owns_every_workspace(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null
    and exists (select 1 from crm.workspaces)
    and not exists (
      select 1 from crm.workspaces w
      where not exists (
        select 1 from crm.workspace_members m
        where m.workspace_id = w.id and m.user_id = p_user and m.role = 'owner'
      )
    );
$$;

revoke all on function private.meta_owns_every_workspace(uuid) from public;
grant execute on function private.meta_owns_every_workspace(uuid) to crm_app;

create or replace function private.meta_held_audience()
returns table (user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with everywhere as (
    select distinct m.user_id
    from crm.workspace_members m
    where m.role = 'owner' and private.meta_owns_every_workspace(m.user_id)
  ),
  oldest as (
    select m.user_id
    from crm.workspace_members m
    where m.role = 'owner'
      and m.workspace_id = (select w.id from crm.workspaces w order by w.created_at, w.id limit 1)
  )
  select e.user_id from everywhere e
  union all
  select o.user_id from oldest o where not exists (select 1 from everywhere);
$$;

revoke all on function private.meta_held_audience() from public;

create or replace function private.meta_sees_held(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and exists (select 1 from private.meta_held_audience() a where a.user_id = p_user);
$$;

revoke all on function private.meta_sees_held(uuid) from public;
grant execute on function private.meta_sees_held(uuid) to crm_app;

create or replace function private.meta_lead_resolve(p_ids uuid[], p_page_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  with target as (
    select l.id,
      p.workspace_id is not null and (
        l.released_to = p.workspace_id
        or (l.held_at is null and (p.full_history or l.fetched_at is null or l.lead_created_at >= p.created_at))
      ) as eligible,
      p.workspace_id as page_workspace,
      l.held_at
    from crm.meta_leads l
    left join crm.meta_lead_pages p on p.page_id = l.page_id
    where l.filed_at is null
      and (p_ids is null or l.id = any (p_ids))
      and (p_page_id is null or l.page_id = p_page_id)
  ),
  decided as (
    select t.id,
      case when t.eligible then t.page_workspace end as workspace_id,
      case when t.eligible then t.held_at else coalesce(t.held_at, now()) end as held_at
    from target t
  )
  update crm.meta_leads l
  set workspace_id = d.workspace_id, held_at = d.held_at
  from decided d
  where l.id = d.id
    and l.filed_at is null
    and (l.workspace_id is distinct from d.workspace_id or l.held_at is distinct from d.held_at);
end;
$$;

revoke all on function private.meta_lead_resolve(uuid[], text) from public;

create or replace function private.meta_lead_page_linked(p_user uuid, p_page_id text, p_workspace uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_full boolean := private.meta_sees_held(p_user);
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.meta_lead_pages p
  set full_history = v_full
  where p.page_id = p_page_id and p.workspace_id = p_workspace and p.linked_by = p_user;
  return v_full;
end;
$$;

revoke all on function private.meta_lead_page_linked(uuid, text, uuid) from public;
grant execute on function private.meta_lead_page_linked(uuid, text, uuid) to crm_app;

create or replace function private.meta_leads_receive(p_items jsonb, p_via text)
returns table (id uuid, leadgen_id text, workspace_id uuid, fetched boolean, filed boolean, linked_by uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with items as (
    select distinct on (i->>'leadgen_id')
      i->>'leadgen_id' as leadgen_id,
      nullif(i->>'page_id', '') as page_id,
      nullif(i->>'form_id', '') as form_id,
      nullif(i->>'ad_id', '') as ad_id,
      coalesce(i->'payload', '{}'::jsonb) as payload
    from jsonb_array_elements(p_items) as i
    where i->>'leadgen_id' is not null
  ),
  saved as (
    insert into crm.meta_leads as l (leadgen_id, page_id, form_id, ad_id, received_via, payload, next_attempt_at)
    select it.leadgen_id, it.page_id, it.form_id, it.ad_id,
      case when p_via = 'backup' then 'backup' else 'webhook' end,
      it.payload, now() + interval '2 minutes'
    from items it
    on conflict on constraint meta_leads_unique do update set
      page_id = coalesce(l.page_id, excluded.page_id),
      form_id = coalesce(l.form_id, excluded.form_id),
      ad_id = coalesce(l.ad_id, excluded.ad_id)
    returning l.id
  )
  select array_agg(s.id) into v_ids from saved s;

  perform private.meta_lead_resolve(coalesce(v_ids, '{}'::uuid[]), null);

  return query
  select l.id, l.leadgen_id, l.workspace_id, l.fetched_at is not null, l.filed_at is not null, p.linked_by
  from crm.meta_leads l
  left join crm.meta_lead_pages p on p.page_id = l.page_id and p.workspace_id = l.workspace_id
  where l.id = any (coalesce(v_ids, '{}'::uuid[]));
end;
$$;

revoke all on function private.meta_leads_receive(jsonb, text) from public;
grant execute on function private.meta_leads_receive(jsonb, text) to crm_app;

create or replace function private.meta_lead_save(
  p_leadgen_id text,
  p_page_id text,
  p_form_id text,
  p_ad_id text,
  p_via text,
  p_lead jsonb,
  p_payload jsonb
)
returns table (id uuid, workspace_id uuid, fetched boolean, filed boolean, linked_by uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into crm.meta_leads as l (leadgen_id, page_id, form_id, ad_id, received_via, payload)
  values (
    p_leadgen_id, p_page_id, p_form_id, p_ad_id,
    case when p_via = 'backup' then 'backup' else 'webhook' end,
    '{}'::jsonb
  )
  on conflict on constraint meta_leads_unique do update set
    page_id = coalesce(l.page_id, excluded.page_id),
    form_id = coalesce(l.form_id, excluded.form_id),
    ad_id = coalesce(l.ad_id, excluded.ad_id)
  returning l.id into v_id;

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
  where l.id = v_id and l.fetched_at is null and p_lead is not null;

  perform private.meta_lead_resolve(array[v_id], null);

  return query
  select l.id, l.workspace_id, l.fetched_at is not null, l.filed_at is not null, p.linked_by
  from crm.meta_leads l
  left join crm.meta_lead_pages p on p.page_id = l.page_id and p.workspace_id = l.workspace_id
  where l.id = v_id;
end;
$$;

revoke all on function private.meta_lead_save(text, text, text, text, text, jsonb, jsonb) from public;
grant execute on function private.meta_lead_save(text, text, text, text, text, jsonb, jsonb) to crm_app;

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
  set error = case when filed_at is null then left(p_error, 500) else error end,
      attempts = case when workspace_id is null and filed_at is null then attempts else attempts + 1 end,
      next_attempt_at = now() + case
        when workspace_id is null and filed_at is null then interval '1 hour'
        else least(interval '1 day', interval '5 minutes' * power(2, least(attempts, 10)))
      end
  where id = p_id and (filed_at is null or notified_at is null);
end;
$$;

revoke all on function private.meta_lead_failed(uuid, text) from public;
grant execute on function private.meta_lead_failed(uuid, text) to crm_app;

create or replace function private.meta_lead_notified(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.meta_leads set notified_at = now(), next_attempt_at = null
  where id = p_id and notified_at is null and filed_at is not null;
end;
$$;

revoke all on function private.meta_lead_notified(uuid) from public;
grant execute on function private.meta_lead_notified(uuid) to crm_app;

create or replace function private.meta_leads_waiting(p_limit integer, p_page_id text)
returns table (
  id uuid, workspace_id uuid, leadgen_id text, page_id text, form_id text, ad_id text,
  fetched boolean, filed boolean, linked_by uuid, received_via text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(p_limit, 200));
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform private.meta_lead_resolve(null, p_page_id);

  return query
  with linked as (
    select l.id, l.created_at, l.next_attempt_at, 1 as queue
    from crm.meta_leads l
    where l.filed_at is null and l.workspace_id is not null
      and (p_page_id is null or l.page_id = p_page_id)
      and (p_page_id is not null or l.next_attempt_at is null or l.next_attempt_at <= now())
    order by l.next_attempt_at nulls first, l.created_at
    limit v_limit
  ),
  unnotified as (
    select l.id, l.created_at, l.next_attempt_at, 2 as queue
    from crm.meta_leads l
    where l.filed_at is not null and l.notified_at is null and l.workspace_id is not null
      and l.filed_at < now() - interval '2 minutes'
      and (p_page_id is null or l.page_id = p_page_id)
      and (l.next_attempt_at is null or l.next_attempt_at <= now())
    order by l.next_attempt_at nulls first, l.filed_at
    limit greatest(1, v_limit / 4)
  ),
  held as (
    select l.id, l.created_at, l.next_attempt_at, 3 as queue
    from crm.meta_leads l
    where l.filed_at is null and l.workspace_id is null and l.fetched_at is null
      and (p_page_id is null or l.page_id = p_page_id)
      and (l.next_attempt_at is null or l.next_attempt_at <= now())
    order by l.next_attempt_at nulls first, l.created_at
    limit greatest(1, v_limit / 10)
  ),
  picked as (
    select * from linked
    union all
    select * from unnotified
    union all
    select * from held
  ),
  bumped as (
    update crm.meta_leads b
    set next_attempt_at = now() + interval '1 hour'
    where b.filed_at is null and b.workspace_id is null and b.fetched_at is null
      and (b.next_attempt_at is null or b.next_attempt_at <= now())
      and b.page_id in (select h.page_id from crm.meta_leads h join held k on k.id = h.id)
      and b.id not in (select k.id from held k)
    returning b.id
  )
  select l.id, l.workspace_id, l.leadgen_id, l.page_id, l.form_id, l.ad_id,
    l.fetched_at is not null, l.filed_at is not null, p.linked_by, l.received_via
  from picked k
  join crm.meta_leads l on l.id = k.id
  left join crm.meta_lead_pages p on p.page_id = l.page_id and p.workspace_id = l.workspace_id
  order by k.queue, k.next_attempt_at nulls first, k.created_at;
end;
$$;

revoke all on function private.meta_leads_waiting(integer, text) from public;
grant execute on function private.meta_leads_waiting(integer, text) to crm_app;

create or replace function private.meta_lead_work_due(p_every interval)
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
    select 1 from crm.meta_lead_pages p
    where p.pending or p.last_attempt_at is null or p.last_attempt_at < now() - p_every
  ) or exists (
    select 1 from crm.meta_leads l
    where l.filed_at is null and (l.workspace_id is not null or l.fetched_at is null)
      and l.next_attempt_at is null
  ) or exists (
    select 1 from crm.meta_leads l
    where l.filed_at is null and (l.workspace_id is not null or l.fetched_at is null)
      and l.next_attempt_at <= now()
  ) or exists (
    select 1 from crm.meta_leads l
    where l.filed_at is not null and l.notified_at is null and l.workspace_id is not null
      and l.filed_at < now() - interval '2 minutes'
      and (l.next_attempt_at is null or l.next_attempt_at <= now())
  );
end;
$$;

revoke all on function private.meta_lead_work_due(interval) from public;
grant execute on function private.meta_lead_work_due(interval) to crm_app;

create or replace function private.meta_lead_pages_due(p_every interval)
returns table (id uuid, workspace_id uuid, page_id text, page_name text, linked_by uuid, full_history boolean, last_run_at timestamptz, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select p.id, p.workspace_id, p.page_id, p.page_name, p.linked_by, p.full_history, p.last_run_at, p.created_at
  from crm.meta_lead_pages p
  where p.pending or p.last_attempt_at is null or p.last_attempt_at < now() - p_every
  order by p.last_attempt_at nulls first, p.created_at;
end;
$$;

revoke all on function private.meta_lead_pages_due(interval) from public;
grant execute on function private.meta_lead_pages_due(interval) to crm_app;

create or replace function private.meta_lead_page_ran(p_id uuid, p_started timestamptz, p_ok boolean, p_complete boolean, p_error text, p_name text)
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
  set last_attempt_at = now(),
      pending = not p_complete,
      last_run_at = case when p_ok and p_complete then p_started else last_run_at end,
      last_error = case when p_ok then null else left(p_error, 500) end,
      page_name = coalesce(nullif(left(p_name, 200), ''), page_name)
  where id = p_id;
end;
$$;

revoke all on function private.meta_lead_page_ran(uuid, timestamptz, boolean, boolean, text, text) from public;
grant execute on function private.meta_lead_page_ran(uuid, timestamptz, boolean, boolean, text, text) to crm_app;

create or replace function private.meta_lead_form_cursors(p_page_id text)
returns table (form_id text, last_run_at timestamptz, last_attempt_at timestamptz, list_since timestamptz, list_after text, list_started_at timestamptz)
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
  select f.form_id, f.last_run_at, f.last_attempt_at, f.list_since, f.list_after, f.list_started_at
  from crm.meta_lead_forms f
  where f.page_id = p_page_id;
end;
$$;

revoke all on function private.meta_lead_form_cursors(text) from public;
grant execute on function private.meta_lead_form_cursors(text) to crm_app;

create or replace function private.meta_lead_form_progress(p_page_id text, p_form_id text, p_name text, p_since timestamptz, p_after text, p_started timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from crm.meta_lead_pages p where p.page_id = p_page_id) then
    return;
  end if;
  insert into crm.meta_lead_forms as f (page_id, form_id, form_name, last_attempt_at, list_since, list_after, list_started_at)
  values (p_page_id, p_form_id, nullif(left(p_name, 300), ''), now(), p_since, left(p_after, 2000), p_started)
  on conflict (page_id, form_id) do update set
    form_name = coalesce(excluded.form_name, f.form_name),
    last_attempt_at = now(),
    list_since = excluded.list_since,
    list_after = excluded.list_after,
    list_started_at = excluded.list_started_at;
end;
$$;

revoke all on function private.meta_lead_form_progress(text, text, text, timestamptz, text, timestamptz) from public;
grant execute on function private.meta_lead_form_progress(text, text, text, timestamptz, text, timestamptz) to crm_app;

create or replace function private.meta_lead_form_ran(p_page_id text, p_form_id text, p_name text, p_started timestamptz, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from crm.meta_lead_pages p where p.page_id = p_page_id) then
    return;
  end if;
  insert into crm.meta_lead_forms as f (page_id, form_id, form_name, last_run_at, last_attempt_at, last_error)
  values (p_page_id, p_form_id, nullif(left(p_name, 300), ''), case when p_ok then p_started end, now(), case when p_ok then null else left(p_error, 500) end)
  on conflict (page_id, form_id) do update set
    form_name = coalesce(excluded.form_name, f.form_name),
    last_run_at = case when p_ok then p_started else f.last_run_at end,
    last_attempt_at = now(),
    last_error = case when p_ok then null else left(p_error, 500) end,
    list_since = null,
    list_after = null,
    list_started_at = null;
end;
$$;

revoke all on function private.meta_lead_form_ran(text, text, text, timestamptz, boolean, text) from public;
grant execute on function private.meta_lead_form_ran(text, text, text, timestamptz, boolean, text) to crm_app;

create or replace function private.meta_lead_alert_owners()
returns table (workspace_id uuid, workspace_name text, user_id uuid, role text, email text, full_name text)
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
  select w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.workspace_members m
  join crm.workspaces w on w.id = m.workspace_id
  join crm.profiles p on p.id = m.user_id
  where w.id = private.home_workspace_id(m.user_id)
    and m.user_id in (select a.user_id from private.meta_held_audience() a);
end;
$$;

revoke all on function private.meta_lead_alert_owners() from public;
grant execute on function private.meta_lead_alert_owners() to crm_app;

create or replace function private.meta_held_pages(p_user uuid)
returns table (page_id text, leads integer, last_at timestamptz, linked_workspace_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not private.meta_sees_held(p_user) then
    return;
  end if;
  return query
  select l.page_id, count(*)::integer, max(l.created_at), max(p.workspace_id::text)::uuid
  from crm.meta_leads l
  left join crm.meta_lead_pages p on p.page_id = l.page_id
  where l.filed_at is null and l.page_id is not null
    and l.held_at is not null
    and l.workspace_id is null
  group by l.page_id
  order by max(l.created_at) desc
  limit 50;
end;
$$;

revoke all on function private.meta_held_pages(uuid) from public;
grant execute on function private.meta_held_pages(uuid) to crm_app;

create or replace function private.meta_release_held(p_user uuid, p_page_id text, p_workspace uuid)
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
  if not private.meta_sees_held(p_user) then
    return 0;
  end if;
  if not exists (select 1 from crm.meta_lead_pages p where p.page_id = p_page_id and p.workspace_id = p_workspace) then
    return 0;
  end if;
  update crm.meta_leads l
  set released_to = p_workspace, attempts = 0, next_attempt_at = null, error = null
  where l.page_id = p_page_id and l.filed_at is null and l.held_at is not null
    and l.workspace_id is null;
  get diagnostics v_count = row_count;
  perform private.meta_lead_resolve(null, p_page_id);
  return v_count;
end;
$$;

revoke all on function private.meta_release_held(uuid, text, uuid) from public;
grant execute on function private.meta_release_held(uuid, text, uuid) to crm_app;
