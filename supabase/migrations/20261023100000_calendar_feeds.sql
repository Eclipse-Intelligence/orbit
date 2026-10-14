alter table crm.calendar_accounts add column if not exists feed_url_cipher text;
alter table crm.calendar_accounts add column if not exists feed_url_hash text;
alter table crm.calendar_accounts add column if not exists feed_host text;
alter table crm.calendar_accounts add column if not exists feed_etag text;
alter table crm.calendar_accounts add column if not exists feed_last_modified text;
alter table crm.calendar_accounts add column if not exists feed_fetched_at timestamptz;

alter table crm.calendar_accounts alter column email drop not null;
alter table crm.calendar_accounts alter column tenant_id drop not null;

alter table crm.calendar_accounts drop constraint if exists calendar_accounts_provider;
alter table crm.calendar_accounts
  add constraint calendar_accounts_provider check (provider in ('microsoft', 'ics'));

alter table crm.calendar_accounts drop constraint if exists calendar_accounts_connected_token;
alter table crm.calendar_accounts
  add constraint calendar_accounts_connected_token check (
    status <> 'connected'
    or (provider = 'ics' and feed_url_cipher is not null)
    or (provider <> 'ics' and refresh_token is not null)
  );

alter table crm.calendar_accounts drop constraint if exists calendar_accounts_email_required;
alter table crm.calendar_accounts
  add constraint calendar_accounts_email_required check (provider = 'ics' or email is not null);

alter table crm.calendar_accounts drop constraint if exists calendar_accounts_feed_shape;
alter table crm.calendar_accounts
  add constraint calendar_accounts_feed_shape check (
    provider <> 'ics' or (feed_url_cipher is not null and feed_url_hash is not null and feed_host is not null)
  );

alter table crm.calendar_accounts drop constraint if exists calendar_accounts_feed_lengths;
alter table crm.calendar_accounts
  add constraint calendar_accounts_feed_lengths check (
    (feed_url_cipher is null or char_length(feed_url_cipher) <= 4000)
    and (feed_url_hash is null or char_length(feed_url_hash) <= 100)
    and (feed_host is null or char_length(feed_host) <= 253)
    and (feed_etag is null or char_length(feed_etag) <= 500)
    and (feed_last_modified is null or char_length(feed_last_modified) <= 100)
  );

create unique index if not exists calendar_accounts_feed_key
  on crm.calendar_accounts (user_id, feed_url_hash)
  where feed_url_hash is not null;

grant update (
  email, display_name, tenant_id, refresh_token, access_token, access_token_expires_at,
  status, scope_missing, last_synced_at, last_attempt_at, last_error,
  feed_url_cipher, feed_url_hash, feed_host, feed_etag, feed_last_modified, feed_fetched_at
) on crm.calendar_accounts to authenticated;
