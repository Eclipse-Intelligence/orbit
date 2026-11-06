create table if not exists crm.personal_context_workspaces (
  user_id uuid not null references crm.profiles (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  about text,
  job_title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_id),
  constraint personal_context_workspaces_about_length check (about is null or char_length(about) <= 3000),
  constraint personal_context_workspaces_job_title_length check (job_title is null or char_length(job_title) <= 120)
);

drop trigger if exists personal_context_workspaces_set_updated_at on crm.personal_context_workspaces;
create trigger personal_context_workspaces_set_updated_at
  before update on crm.personal_context_workspaces
  for each row execute function private.set_updated_at();

alter table crm.personal_context_workspaces enable row level security;
alter table crm.personal_context_workspaces force row level security;

drop policy if exists personal_context_workspaces_owner on crm.personal_context_workspaces;
create policy personal_context_workspaces_owner on crm.personal_context_workspaces
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.personal_context_workspaces from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.personal_context_workspaces to authenticated;

drop trigger if exists mail_prepared_mail_workspace on crm.mail_prepared;

update crm.memories m set all_workspaces = null
where m.scope = 'personal'
  and m.all_workspaces
  and m.archived_at is null
  and (
    m.kind in ('icp', 'objection', 'competitor', 'messaging')
    or exists (
      select 1
      from crm.workspace_members wm
      join crm.workspaces w on w.id = wm.workspace_id
      join crm.profiles p on p.id = wm.user_id
      where wm.user_id = m.user_id
        and char_length(btrim(w.name)) >= 3
        and lower(btrim(w.name)) <> lower(btrim(coalesce(p.full_name, '')))
        and lower(btrim(w.name)) <> lower(split_part(btrim(coalesce(p.full_name, '')), ' ', 1))
        and (m.title || ' ' || m.body) ~* ('\m' || regexp_replace(btrim(w.name), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '\M')
    )
  );

alter table crm.daily_briefs drop constraint if exists daily_briefs_unique;
drop index if exists crm.daily_briefs_unique;
create unique index if not exists daily_briefs_workspace_user_day on crm.daily_briefs (workspace_id, user_id, day);

alter table crm.booking_pages drop constraint if exists booking_pages_user_key;
drop index if exists crm.booking_pages_user_key;
create unique index if not exists booking_pages_user_workspace on crm.booking_pages (user_id, workspace_id);

create or replace function private.booking_slug_taken(p_slug text, p_user_id uuid, p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.booking_pages b
    where b.slug = lower(trim(p_slug))
      and not (b.user_id = p_user_id and b.workspace_id = p_workspace_id)
  )
$$;

drop function if exists private.booking_slug_taken(text, uuid);

revoke all on function private.booking_slug_taken(text, uuid, uuid) from public;
grant execute on function private.booking_slug_taken(text, uuid, uuid) to crm_app;

create or replace function private.move_personal_rows(p_user uuid, p_from uuid, p_to uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
begin
  update crm.mailbox_connections c set workspace_id = p_to
  where c.workspace_id = p_from and c.user_id = p_user
    and not exists (
      select 1 from crm.mailbox_connections t
      where t.workspace_id = p_to and t.user_id = p_user and t.provider = c.provider
    );
  update crm.mailbox_connections
    set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
    where workspace_id = p_from and user_id = p_user;

  update crm.email_signatures s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user
    and not exists (
      select 1 from crm.email_signatures t
      where t.workspace_id = p_to and t.user_id = p_user and t.sender_email = s.sender_email
    );
  update crm.mail_preferences s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user
    and not exists (select 1 from crm.mail_preferences t where t.workspace_id = p_to and t.user_id = p_user);
  update crm.hidden_attendees s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user
    and not exists (
      select 1 from crm.hidden_attendees t where t.workspace_id = p_to and t.user_id = p_user and t.email = s.email
    );
  update crm.pages s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user and s.kind = 'daily'
    and not exists (
      select 1 from crm.pages t
      where t.workspace_id = p_to and t.user_id = p_user and t.kind = 'daily' and t.daily_date = s.daily_date
    );
  update crm.integration_state set workspace_id = p_to
  where workspace_id = p_from and user_id = p_user and connection_id is not null;

  delete from crm.booking_pages s
  where s.workspace_id = p_from and s.user_id = p_user
    and exists (select 1 from crm.booking_pages t where t.workspace_id = p_to and t.user_id = p_user);
  delete from crm.personal_context_workspaces where workspace_id = p_from and user_id = p_user;

  foreach v_table in array array[
    'calendar_accounts', 'mail_sources', 'mail_folders', 'mail_messages', 'mail_drafts', 'mail_prepared',
    'mail_reminders', 'mail_summaries', 'mail_unsubscribes', 'send_identities', 'mail_attachment_texts',
    'mail_deferral_checks', 'mail_pitch_failures', 'calendars', 'calendar_events', 'mail_sender_rules',
    'mail_subscriptions', 'mail_viewer_addresses', 'mail_tracking', 'mail_opens', 'email_attachments',
    'ai_accounts', 'ai_companions', 'ai_companion_pairings', 'push_subscriptions', 'push_log', 'booking_pages',
    'mail_domain_rules', 'mail_thread_routes', 'capture_dismissals'
  ]
  loop
    execute format('update crm.%I set workspace_id = $1 where workspace_id = $2 and user_id = $3', v_table)
      using p_to, p_from, p_user;
  end loop;

  delete from crm.mail_address_homes where workspace_id = p_from and user_id = p_user;
  delete from crm.mail_domain_rules where user_id = p_user and workspace_ids <@ array[p_from];
  update crm.mail_domain_rules set workspace_ids = array_remove(workspace_ids, p_from)
    where user_id = p_user and p_from = any(workspace_ids);
  update crm.mail_thread_routes set filed_in = nullif(array_remove(filed_in, p_from), '{}')
    where user_id = p_user and p_from = any(filed_in);
  update crm.mail_thread_routes set capture_workspace_id = null
    where user_id = p_user and capture_workspace_id = p_from;
end;
$$;

revoke all on function private.move_personal_rows(uuid, uuid, uuid) from public;
