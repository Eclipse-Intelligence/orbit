create table if not exists private.push_keys (
  id integer primary key default 1,
  public_key text not null,
  private_key_cipher text not null,
  created_at timestamptz not null default now(),
  constraint push_keys_single check (id = 1)
);

revoke all on private.push_keys from public;

create or replace function private.push_key(p_public text default null, p_private text default null)
returns table (public_key text, private_key_cipher text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_public is not null and p_private is not null then
    insert into private.push_keys (id, public_key, private_key_cipher)
    values (1, p_public, p_private)
    on conflict (id) do nothing;
  end if;
  return query select k.public_key, k.private_key_cipher from private.push_keys k where k.id = 1;
end;
$$;

revoke all on function private.push_key(text, text) from public;
grant execute on function private.push_key(text, text) to crm_app;

create table if not exists crm.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint push_subscriptions_endpoint check (char_length(endpoint) between 10 and 2000),
  constraint push_subscriptions_keys check (char_length(p256dh) <= 200 and char_length(auth) <= 100),
  constraint push_subscriptions_agent check (user_agent is null or char_length(user_agent) <= 400),
  constraint push_subscriptions_unique unique (user_id, endpoint)
);

create index if not exists push_subscriptions_user_idx on crm.push_subscriptions (user_id);

alter table crm.push_subscriptions enable row level security;
alter table crm.push_subscriptions force row level security;

drop policy if exists push_subscriptions_owner on crm.push_subscriptions;
create policy push_subscriptions_owner on crm.push_subscriptions
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.push_subscriptions from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.push_subscriptions to authenticated;

alter table crm.mail_preferences add column if not exists notify_mail text not null default 'important';
alter table crm.mail_preferences add column if not exists notify_calendar_minutes integer default 10;
alter table crm.mail_preferences add column if not exists notify_reads boolean not null default false;
alter table crm.mail_preferences drop constraint if exists mail_preferences_notify_mail;
alter table crm.mail_preferences add constraint mail_preferences_notify_mail check (notify_mail in ('important', 'all', 'none'));
alter table crm.mail_preferences drop constraint if exists mail_preferences_notify_calendar;
alter table crm.mail_preferences add constraint mail_preferences_notify_calendar check (notify_calendar_minutes is null or notify_calendar_minutes between 0 and 1440);

alter table crm.mail_sources add column if not exists graph_subscription_id text;
alter table crm.mail_sources add column if not exists graph_subscription_expires_at timestamptz;
alter table crm.mail_sources add column if not exists graph_client_state text;

create or replace function private.mail_subscription_owner(p_subscription text, p_state text)
returns table (
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
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
  select w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.mail_sources s
  join crm.workspace_members m on m.user_id = s.user_id and m.workspace_id = s.workspace_id
  join crm.workspaces w on w.id = s.workspace_id
  join crm.profiles p on p.id = s.user_id
  where s.graph_subscription_id = p_subscription and s.graph_client_state = p_state;
end;
$$;

revoke all on function private.mail_subscription_owner(text, text) from public;
grant execute on function private.mail_subscription_owner(text, text) to crm_app;
