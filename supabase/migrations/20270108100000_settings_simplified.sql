delete from crm.granola_keys k
using crm.granola_keys newer
where newer.user_id = k.user_id
  and (newer.updated_at, newer.id) > (k.updated_at, k.id);

delete from crm.readwise_keys k
using crm.readwise_keys newer
where newer.user_id = k.user_id
  and (newer.connected_at, newer.id) > (k.connected_at, k.id);

delete from crm.recall_keys k
using crm.recall_keys newer
where newer.user_id = k.user_id
  and (newer.connected_at, newer.id) > (k.connected_at, k.id);

alter table crm.granola_keys drop constraint if exists granola_keys_user;
alter table crm.granola_keys add constraint granola_keys_user unique (user_id);

alter table crm.readwise_keys drop constraint if exists readwise_keys_user;
alter table crm.readwise_keys add constraint readwise_keys_user unique (user_id);

alter table crm.recall_keys drop constraint if exists recall_keys_user;
alter table crm.recall_keys add constraint recall_keys_user unique (user_id);

create index if not exists readwise_documents_user_document_idx on crm.readwise_documents (user_id, document_id);

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
  update crm.granola_keys set workspace_id = p_to where workspace_id = p_from and user_id = p_user;
  update crm.recall_keys set workspace_id = p_to where workspace_id = p_from and user_id = p_user;
  delete from crm.readwise_documents where workspace_id = p_from and user_id = p_user;
  update crm.readwise_keys
    set workspace_id = p_to, updated_after = null, full_sync_at = null, scan_cursor = null, scan_since = null,
      scan_started_at = null, scan_full = false, list_cursor = null, list_full = false, list_done = false, sync_started_at = null
    where workspace_id = p_from and user_id = p_user;
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
