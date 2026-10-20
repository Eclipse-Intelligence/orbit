create table if not exists crm.push_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  key text not null,
  sent_at timestamptz not null default now(),
  constraint push_log_key check (char_length(key) between 1 and 500),
  constraint push_log_unique unique (user_id, key)
);

create index if not exists push_log_sent_idx on crm.push_log (sent_at);

alter table crm.push_log enable row level security;
alter table crm.push_log force row level security;

drop policy if exists push_log_owner on crm.push_log;
create policy push_log_owner on crm.push_log
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.push_log from anon, authenticated, crm_agent;
grant select, insert, delete on crm.push_log to authenticated;

create or replace function private.calendar_alert_members()
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
  from crm.workspace_members m
  join crm.workspaces w on w.id = m.workspace_id
  join crm.profiles p on p.id = m.user_id
  left join crm.mail_preferences pref on pref.user_id = m.user_id and pref.workspace_id = m.workspace_id
  where (pref.user_id is null or pref.notify_calendar_minutes is not null)
    and exists (select 1 from crm.push_subscriptions s where s.user_id = m.user_id and s.workspace_id = m.workspace_id)
    and exists (
      select 1 from crm.calendar_events e
      where e.user_id = m.user_id and e.workspace_id = m.workspace_id
        and not e.is_cancelled and not e.is_all_day
        and e.starts_at > now() - interval '2 minutes'
        and e.starts_at <= now() + make_interval(mins => coalesce(pref.notify_calendar_minutes, 10))
    );
end;
$$;

revoke all on function private.calendar_alert_members() from public;
grant execute on function private.calendar_alert_members() to crm_app;

create or replace function private.mail_open_owner(p_tracking uuid)
returns table (
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text,
  subject text,
  recipients jsonb,
  opens integer,
  notify_reads boolean,
  source_id uuid,
  thread_key text
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
  select w.id, w.name, t.user_id, m.role, p.email, p.full_name, t.subject, t.recipients,
    (select count(*)::integer from crm.mail_opens o where o.tracking_id = t.id),
    coalesce(pref.notify_reads, false),
    msg.source_id, msg.tk
  from crm.mail_tracking t
  join crm.workspace_members m on m.user_id = t.user_id and m.workspace_id = t.workspace_id
  join crm.workspaces w on w.id = t.workspace_id
  join crm.profiles p on p.id = t.user_id
  left join crm.mail_preferences pref on pref.user_id = t.user_id and pref.workspace_id = t.workspace_id
  left join lateral (
    select mm.source_id, coalesce(mm.thread_key, 'm:' || mm.id::text) as tk
    from crm.mail_messages mm where mm.tracking_id = t.id limit 1
  ) msg on true
  where t.id = p_tracking;
end;
$$;

revoke all on function private.mail_open_owner(uuid) from public;
grant execute on function private.mail_open_owner(uuid) to crm_app;
