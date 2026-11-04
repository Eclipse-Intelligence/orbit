alter table crm.mail_reminders add column if not exists action text not null default 'remind';
alter table crm.mail_reminders add column if not exists follow_up_body text;
alter table crm.mail_reminders add column if not exists recipients jsonb;
alter table crm.mail_reminders add column if not exists identity_id uuid references crm.send_identities (id) on delete set null;
alter table crm.mail_reminders add column if not exists sent_at timestamptz;
alter table crm.mail_reminders add column if not exists sending_at timestamptz;
alter table crm.mail_reminders add column if not exists used_identity boolean not null default false;
alter table crm.mail_reminders add column if not exists original_internet_id text;

alter table crm.mail_reminders drop constraint if exists mail_reminders_original_internet_id;
alter table crm.mail_reminders add constraint mail_reminders_original_internet_id
  check (original_internet_id is null or char_length(original_internet_id) <= 1000);

alter table crm.mail_reminders drop constraint if exists mail_reminders_action;
alter table crm.mail_reminders add constraint mail_reminders_action
  check (action in ('remind', 'send') and (action = 'remind' or (kind = 'follow_up' and not automatic)));

alter table crm.mail_reminders drop constraint if exists mail_reminders_state;
alter table crm.mail_reminders add constraint mail_reminders_state
  check (state in ('waiting', 'due', 'done', 'sending', 'sent', 'cancelled', 'replied'));

alter table crm.mail_reminders drop constraint if exists mail_reminders_follow_up_body;
alter table crm.mail_reminders add constraint mail_reminders_follow_up_body
  check (follow_up_body is null or char_length(follow_up_body) <= 20000);

create index if not exists mail_reminders_follow_up_idx on crm.mail_reminders (user_id, source_id, thread_key)
  where kind = 'follow_up' and action = 'send';
create index if not exists mail_reminders_sending_idx on crm.mail_reminders (user_id, sending_at)
  where state = 'sending';

alter table crm.mail_drafts add column if not exists follow_up_days integer;
alter table crm.mail_drafts add column if not exists follow_up_body text;

alter table crm.mail_drafts drop constraint if exists mail_drafts_follow_up_days;
alter table crm.mail_drafts add constraint mail_drafts_follow_up_days
  check (follow_up_days is null or follow_up_days between 1 and 10);

alter table crm.mail_drafts drop constraint if exists mail_drafts_follow_up_body;
alter table crm.mail_drafts add constraint mail_drafts_follow_up_body
  check (follow_up_body is null or char_length(follow_up_body) <= 20000);

alter table crm.mail_reminders enable row level security;
alter table crm.mail_reminders force row level security;
alter table crm.mail_drafts enable row level security;
alter table crm.mail_drafts force row level security;

revoke all on crm.mail_reminders from anon, crm_agent;
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
    )
    or exists (
      select 1 from crm.mail_reminders r
      where r.user_id = m.user_id and r.workspace_id = m.workspace_id and r.state = 'sending'
        and coalesce(r.sending_at, r.created_at) < now() - interval '10 minutes'
    );
end;
$$;

revoke all on function private.mail_due_members() from public;
grant execute on function private.mail_due_members() to crm_app;
