alter table crm.contacts add column if not exists location text;
alter table crm.contacts add column if not exists sales_navigator_url text;

alter table crm.contacts drop constraint if exists contacts_location_length;
alter table crm.contacts add constraint contacts_location_length check (location is null or char_length(location) <= 200);
alter table crm.contacts drop constraint if exists contacts_sales_navigator_url_format;
alter table crm.contacts add constraint contacts_sales_navigator_url_format
  check (sales_navigator_url is null or (char_length(sales_navigator_url) <= 300 and sales_navigator_url like 'https://www.linkedin.com/sales/lead/%'));

create index if not exists contacts_sales_navigator_idx
  on crm.contacts (workspace_id, sales_navigator_url)
  where sales_navigator_url is not null and archived_at is null;

create index if not exists companies_linkedin_url_idx
  on crm.companies (workspace_id, linkedin_url)
  where linkedin_url is not null and archived_at is null;

create table if not exists crm.extension_browsers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references crm.profiles (id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint extension_browsers_name_length check (char_length(name) between 1 and 120)
);

create index if not exists extension_browsers_user_idx on crm.extension_browsers (user_id) where revoked_at is null;

create table if not exists crm.extension_browser_workspaces (
  browser_id uuid not null references crm.extension_browsers (id) on delete cascade,
  workspace_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (browser_id, workspace_id),
  constraint extension_browser_workspaces_member foreign key (workspace_id, user_id)
    references crm.workspace_members (workspace_id, user_id) on delete cascade
);

create index if not exists extension_browser_workspaces_member_idx on crm.extension_browser_workspaces (workspace_id, user_id);

create table if not exists crm.extension_pairings (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  secret_hash text not null,
  user_id uuid references crm.profiles (id) on delete cascade,
  name text,
  workspace_ids uuid[] not null default '{}',
  status text not null default 'pending',
  expires_at timestamptz not null,
  decided_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint extension_pairings_status check (status in ('pending', 'approved', 'declined', 'used')),
  constraint extension_pairings_name_length check (name is null or char_length(name) between 1 and 120)
);

create index if not exists extension_pairings_expiry_idx on crm.extension_pairings (expires_at);
create index if not exists extension_pairings_user_idx on crm.extension_pairings (user_id);

alter table crm.extension_browsers enable row level security;
alter table crm.extension_browsers force row level security;
alter table crm.extension_browser_workspaces enable row level security;
alter table crm.extension_browser_workspaces force row level security;
alter table crm.extension_pairings enable row level security;
alter table crm.extension_pairings force row level security;

drop policy if exists extension_browsers_owner on crm.extension_browsers;
create policy extension_browsers_owner on crm.extension_browsers
  for all to authenticated
  using (user_id = (select private.session_user_id()))
  with check (user_id = (select private.session_user_id()));

drop policy if exists extension_browser_workspaces_owner on crm.extension_browser_workspaces;
create policy extension_browser_workspaces_owner on crm.extension_browser_workspaces
  for all to authenticated
  using (user_id = (select private.session_user_id()))
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and browser_id in (
      select b.id from crm.extension_browsers b
      where b.user_id = (select private.session_user_id()) and b.revoked_at is null
    )
  );

drop policy if exists extension_pairings_owner on crm.extension_pairings;
create policy extension_pairings_owner on crm.extension_pairings
  for select to authenticated
  using (user_id = (select private.session_user_id()));

revoke all on crm.extension_browsers from anon, authenticated, crm_agent;
revoke all on crm.extension_browser_workspaces from anon, authenticated, crm_agent;
revoke all on crm.extension_pairings from anon, authenticated, crm_agent;
grant select (id, user_id, name, created_at, last_used_at, revoked_at) on crm.extension_browsers to authenticated;
grant update (name, revoked_at) on crm.extension_browsers to authenticated;
grant select, insert, delete on crm.extension_browser_workspaces to authenticated;

create or replace function private.extension_pairing_start(p_code_hash text, p_secret_hash text, p_expires_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  delete from crm.extension_pairings p where p.expires_at < now() - interval '1 day';

  insert into crm.extension_pairings (code_hash, secret_hash, expires_at)
  values (p_code_hash, p_secret_hash, p_expires_at);
end;
$$;

create or replace function private.extension_pairing_status(p_code_hash text)
returns table (status text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select case when p.status = 'pending' and p.expires_at <= now() then 'expired' else p.status end, p.expires_at
  from crm.extension_pairings p
  where p.code_hash = p_code_hash;
end;
$$;

create or replace function private.extension_pairing_decide(
  p_code_hash text,
  p_user_id uuid,
  p_name text,
  p_workspace_ids uuid[],
  p_approve boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed uuid[];
  v_id uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct m.workspace_id), '{}')
  into v_allowed
  from crm.workspace_members m
  where m.user_id = p_user_id
    and m.workspace_id = any(coalesce(p_workspace_ids, '{}'));

  if p_approve and cardinality(v_allowed) = 0 then
    return 'no_workspaces';
  end if;

  update crm.extension_pairings p
  set status = case when p_approve then 'approved' else 'declined' end,
      user_id = p_user_id,
      name = case when p_approve then left(coalesce(nullif(trim(p_name), ''), 'Chrome'), 120) else null end,
      workspace_ids = case when p_approve then v_allowed else '{}' end,
      decided_at = now()
  where p.code_hash = p_code_hash
    and p.status = 'pending'
    and p.expires_at > now()
  returning p.id into v_id;

  if v_id is null then
    return 'expired';
  end if;

  return case when p_approve then 'approved' else 'declined' end;
end;
$$;

create or replace function private.extension_pairing_redeem(p_code_hash text, p_secret_hash text, p_token_hash text)
returns table (status text, browser_id uuid, name text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pairing crm.extension_pairings;
  v_browser uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_pairing
  from crm.extension_pairings p
  where p.code_hash = p_code_hash and p.secret_hash = p_secret_hash
  for update;

  if v_pairing.id is null then
    return query select 'expired'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if v_pairing.status = 'pending' then
    if v_pairing.expires_at <= now() then
      return query select 'expired'::text, null::uuid, null::text, v_pairing.expires_at;
    else
      return query select 'pending'::text, null::uuid, null::text, v_pairing.expires_at;
    end if;
    return;
  end if;

  if v_pairing.status <> 'approved' or v_pairing.decided_at < now() - interval '10 minutes' then
    return query select (case when v_pairing.status = 'approved' then 'expired' else v_pairing.status end)::text, null::uuid, null::text, v_pairing.expires_at;
    return;
  end if;

  insert into crm.extension_browsers (user_id, name, token_hash, last_used_at)
  values (v_pairing.user_id, v_pairing.name, p_token_hash, now())
  returning id into v_browser;

  insert into crm.extension_browser_workspaces (browser_id, workspace_id, user_id)
  select v_browser, m.workspace_id, m.user_id
  from crm.workspace_members m
  where m.user_id = v_pairing.user_id and m.workspace_id = any(v_pairing.workspace_ids);

  update crm.extension_pairings p set status = 'used', used_at = now() where p.id = v_pairing.id;

  return query select 'approved'::text, v_browser, v_pairing.name, v_pairing.expires_at;
end;
$$;

create or replace function private.authenticate_extension(p_token_hash text)
returns table (browser_id uuid, user_id uuid, name text, workspace_ids uuid[])
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update crm.extension_browsers b
  set last_used_at = now()
  where b.token_hash = p_token_hash
    and b.revoked_at is null
    and (b.last_used_at is null or b.last_used_at < now() - interval '1 minute');

  return query
  select b.id, b.user_id, b.name,
    coalesce((
      select array_agg(w.workspace_id order by w.created_at, w.workspace_id)
      from crm.extension_browser_workspaces w
      join crm.workspace_members m on m.workspace_id = w.workspace_id and m.user_id = w.user_id
      where w.browser_id = b.id
    ), '{}')
  from crm.extension_browsers b
  where b.token_hash = p_token_hash
    and b.revoked_at is null;
end;
$$;

revoke all on function private.extension_pairing_start(text, text, timestamptz) from public;
revoke all on function private.extension_pairing_status(text) from public;
revoke all on function private.extension_pairing_decide(text, uuid, text, uuid[], boolean) from public;
revoke all on function private.extension_pairing_redeem(text, text, text) from public;
revoke all on function private.authenticate_extension(text) from public;
grant execute on function private.extension_pairing_start(text, text, timestamptz) to crm_app;
grant execute on function private.extension_pairing_status(text) to crm_app;
grant execute on function private.extension_pairing_decide(text, uuid, text, uuid[], boolean) to crm_app;
grant execute on function private.extension_pairing_redeem(text, text, text) to crm_app;
grant execute on function private.authenticate_extension(text) to crm_app;
