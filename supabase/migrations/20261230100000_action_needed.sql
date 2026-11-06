create table if not exists crm.capture_dismissals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  kind text not null,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  thread_key text not null,
  message_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint capture_dismissals_kind check (kind in ('reply')),
  constraint capture_dismissals_key check (char_length(thread_key) between 1 and 450),
  constraint capture_dismissals_unique unique (user_id, kind, source_id, thread_key)
);

alter table crm.capture_dismissals enable row level security;
alter table crm.capture_dismissals force row level security;

drop policy if exists capture_dismissals_owner on crm.capture_dismissals;
create policy capture_dismissals_owner on crm.capture_dismissals
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.capture_dismissals from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.capture_dismissals to authenticated;

drop trigger if exists capture_dismissals_personal_workspace on crm.capture_dismissals;
create trigger capture_dismissals_personal_workspace before insert on crm.capture_dismissals
  for each row execute function private.personal_row_workspace();

create index if not exists workflow_runs_waiting_idx on crm.workflow_runs (workspace_id, updated_at)
  where status = 'waiting' and waiting_for = 'approval';
create index if not exists mail_prepared_ready_idx on crm.mail_prepared (user_id, kind)
  where state = 'ready';

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
