set lock_timeout = '5s';

create table if not exists crm.mail_pending_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  thread_key text not null,
  action text not null,
  view text,
  until timestamptz,
  subject text,
  origin text,
  created_at timestamptz not null default now(),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  refused_at timestamptz,
  problem text,
  shown_at timestamptz,
  constraint mail_pending_actions_action check (action in ('archive', 'trash', 'inbox', 'snooze')),
  constraint mail_pending_actions_subject check (subject is null or char_length(subject) <= 2000),
  constraint mail_pending_actions_problem check (problem is null or char_length(problem) <= 2000)
);

alter table crm.mail_pending_actions enable row level security;
alter table crm.mail_pending_actions force row level security;

drop policy if exists mail_pending_actions_owner on crm.mail_pending_actions;
create policy mail_pending_actions_owner on crm.mail_pending_actions
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_pending_actions from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_pending_actions to authenticated;

alter table crm.mail_pending_actions add column if not exists origin text;

reset lock_timeout;

create index concurrently if not exists mail_pending_actions_thread_idx on crm.mail_pending_actions (user_id, source_id, thread_key, created_at desc) where refused_at is null;
create index concurrently if not exists mail_pending_actions_due_idx on crm.mail_pending_actions (next_attempt_at) where refused_at is null;
create index concurrently if not exists mail_pending_actions_refused_idx on crm.mail_pending_actions (user_id, refused_at) where refused_at is not null;

set lock_timeout = '5s';

create or replace function private.mail_pending_members()
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
  where m.workspace_id = private.home_workspace_id(m.user_id)
    and exists (
      select 1 from crm.mail_pending_actions a
      where a.user_id = m.user_id
        and ((a.refused_at is null and a.next_attempt_at <= now()) or a.refused_at < now() - interval '3 days')
    );
end;
$$;

revoke all on function private.mail_pending_members() from public;
grant execute on function private.mail_pending_members() to crm_app;

reset lock_timeout;
