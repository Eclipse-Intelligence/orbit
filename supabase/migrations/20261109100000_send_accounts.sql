alter table crm.calendar_accounts add column if not exists can_send boolean not null default false;

grant update (
  email, display_name, tenant_id, refresh_token, access_token, access_token_expires_at,
  status, scope_missing, last_synced_at, last_attempt_at, last_error,
  feed_url_cipher, feed_url_hash, feed_host, feed_etag, feed_last_modified, feed_fetched_at,
  can_send
) on crm.calendar_accounts to authenticated;
