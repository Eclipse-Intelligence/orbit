set lock_timeout = '5s';

alter table crm.mail_sources add column if not exists graph_subscription_scope text;
alter table crm.mail_sources add column if not exists resync_pending boolean not null default false;
alter table crm.mail_sources add column if not exists resync_full boolean not null default false;
alter table crm.mail_sources add column if not exists last_full_synced_at timestamptz;
alter table crm.mail_sources add column if not exists graph_subscription_error text;
alter table crm.mail_sources add column if not exists graph_subscription_retry_at timestamptz;
alter table crm.mail_sources add column if not exists resync_lookups text[] not null default '{}';
alter table crm.mail_folders add column if not exists resync_pending boolean not null default false;

create table if not exists crm.mail_echoes (
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  provider_message_id text not null check (char_length(provider_message_id) <= 400),
  changed_at timestamptz not null default now(),
  primary key (source_id, provider_message_id)
);

create index if not exists mail_echoes_user_idx on crm.mail_echoes (user_id, changed_at);

alter table crm.mail_echoes enable row level security;
alter table crm.mail_echoes force row level security;

drop policy if exists mail_echoes_owner on crm.mail_echoes;
create policy mail_echoes_owner on crm.mail_echoes
  for all to authenticated
  using (user_id = (select private.session_user_id()) and source_id in (select s.id from crm.mail_sources s))
  with check (user_id = (select private.session_user_id()) and source_id in (select s.id from crm.mail_sources s));

revoke all on crm.mail_echoes from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_echoes to authenticated;

alter table crm.calendars add column if not exists graph_subscription_id text;
alter table crm.calendars add column if not exists graph_subscription_expires_at timestamptz;
alter table crm.calendars add column if not exists graph_client_state text;
alter table crm.calendars add column if not exists graph_subscription_retry_at timestamptz;
alter table crm.calendars add column if not exists notify_locked_until timestamptz;
alter table crm.calendars add column if not exists resync_pending boolean not null default false;
alter table crm.calendars add column if not exists removed_at timestamptz;

grant update (
  graph_subscription_id, graph_subscription_expires_at, graph_client_state, graph_subscription_retry_at,
  notify_locked_until, resync_pending, removed_at
) on crm.calendars to authenticated;

create or replace function private.mail_subscription_sources(p_subscriptions text[])
returns table (
  subscription_id text,
  source_id uuid,
  client_state text,
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
  select s.graph_subscription_id, s.id, s.graph_client_state, w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.mail_sources s
  join crm.workspace_members m on m.user_id = s.user_id and m.workspace_id = s.workspace_id
  join crm.workspaces w on w.id = s.workspace_id
  join crm.profiles p on p.id = s.user_id
  where s.graph_subscription_id = any(p_subscriptions[1:50])
    and s.graph_client_state is not null;
end;
$$;

revoke all on function private.mail_subscription_sources(text[]) from public;
grant execute on function private.mail_subscription_sources(text[]) to crm_app;

create or replace function private.calendar_subscription_owners(p_subscriptions text[])
returns table (
  subscription_id text,
  calendar_id uuid,
  client_state text,
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
  select c.graph_subscription_id, c.id, c.graph_client_state, w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.calendars c
  join crm.workspace_members m on m.user_id = c.user_id and m.workspace_id = c.workspace_id
  join crm.workspaces w on w.id = c.workspace_id
  join crm.profiles p on p.id = c.user_id
  where c.graph_subscription_id = any(p_subscriptions[1:50])
    and c.graph_client_state is not null;
end;
$$;

revoke all on function private.calendar_subscription_owners(text[]) from public;
grant execute on function private.calendar_subscription_owners(text[]) to crm_app;

reset lock_timeout;

create unique index concurrently if not exists calendars_graph_subscription_key on crm.calendars (graph_subscription_id) where graph_subscription_id is not null;

create index concurrently if not exists mail_sources_graph_subscription_idx on crm.mail_sources (graph_subscription_id) where graph_subscription_id is not null;
