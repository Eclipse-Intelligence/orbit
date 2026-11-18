set lock_timeout = '5s';

alter table crm.mail_sources add column if not exists graph_subscription_scope text;
alter table crm.mail_sources add column if not exists resync_pending boolean not null default false;

alter table crm.calendars add column if not exists graph_subscription_id text;
alter table crm.calendars add column if not exists graph_subscription_expires_at timestamptz;
alter table crm.calendars add column if not exists graph_client_state text;
alter table crm.calendars add column if not exists graph_subscription_retry_at timestamptz;
alter table crm.calendars add column if not exists notify_locked_until timestamptz;
alter table crm.calendars add column if not exists resync_pending boolean not null default false;

grant update (
  graph_subscription_id, graph_subscription_expires_at, graph_client_state, graph_subscription_retry_at,
  notify_locked_until, resync_pending
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
