alter table crm.mail_drafts add column if not exists send_at timestamptz;
alter table crm.mail_drafts add column if not exists signature boolean not null default true;
alter table crm.mail_drafts add column if not exists attachments uuid[] not null default '{}';
alter table crm.mail_drafts add column if not exists remind_hours integer;
alter table crm.mail_drafts add column if not exists send_error text;
alter table crm.mail_drafts add column if not exists content_hash text;
alter table crm.mail_drafts drop constraint if exists mail_drafts_remind_hours;
alter table crm.mail_drafts add constraint mail_drafts_remind_hours check (remind_hours is null or remind_hours between 1 and 2160);
alter table crm.mail_drafts drop constraint if exists mail_drafts_send_error;
alter table crm.mail_drafts add constraint mail_drafts_send_error check (send_error is null or char_length(send_error) <= 500);
create index if not exists mail_drafts_due_idx on crm.mail_drafts (send_at) where send_at is not null;

alter table crm.mail_sources add column if not exists snooze_folder_id text;

alter table crm.mail_folders drop constraint if exists mail_folders_role;
alter table crm.mail_folders add constraint mail_folders_role
  check (role in ('inbox', 'sent', 'drafts', 'archive', 'trash', 'junk', 'outbox', 'snoozed', 'other'));

create table if not exists crm.mail_reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  thread_key text not null,
  kind text not null,
  due_at timestamptz not null,
  state text not null default 'waiting',
  surfaced_at timestamptz,
  subject text,
  created_at timestamptz not null default now(),
  constraint mail_reminders_kind check (kind in ('snooze', 'follow_up')),
  constraint mail_reminders_state check (state in ('waiting', 'due', 'done')),
  constraint mail_reminders_subject check (subject is null or char_length(subject) <= 2000)
);

create index if not exists mail_reminders_due_idx on crm.mail_reminders (due_at) where state = 'waiting';
create index if not exists mail_reminders_thread_idx on crm.mail_reminders (source_id, thread_key, state);

alter table crm.mail_reminders enable row level security;
alter table crm.mail_reminders force row level security;

drop policy if exists mail_reminders_owner on crm.mail_reminders;
create policy mail_reminders_owner on crm.mail_reminders
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_reminders from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_reminders to authenticated;

create or replace function private.mail_due_members()
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
  where exists (
      select 1 from crm.mail_drafts d
      where d.user_id = m.user_id and d.workspace_id = m.workspace_id and d.send_at <= now()
    )
    or exists (
      select 1 from crm.mail_reminders r
      where r.user_id = m.user_id and r.workspace_id = m.workspace_id and r.state = 'waiting' and r.due_at <= now()
    );
end;
$$;

revoke all on function private.mail_due_members() from public;
grant execute on function private.mail_due_members() to crm_app;
