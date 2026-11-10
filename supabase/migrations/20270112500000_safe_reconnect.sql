alter table crm.mailbox_connections add column if not exists microsoft_user_id text;
alter table crm.mailbox_connections add column if not exists tenant_id text;
alter table crm.calendar_accounts add column if not exists microsoft_user_id text;
alter table crm.calendar_accounts add column if not exists granted_scopes text;

alter table crm.mailbox_connections drop constraint if exists mailbox_connections_microsoft_user_id_length;
alter table crm.mailbox_connections
  add constraint mailbox_connections_microsoft_user_id_length
  check (microsoft_user_id is null or char_length(microsoft_user_id) <= 100);

alter table crm.mailbox_connections drop constraint if exists mailbox_connections_tenant_length;
alter table crm.mailbox_connections
  add constraint mailbox_connections_tenant_length
  check (tenant_id is null or char_length(tenant_id) <= 100);

alter table crm.calendar_accounts drop constraint if exists calendar_accounts_microsoft_user_id_length;
alter table crm.calendar_accounts
  add constraint calendar_accounts_microsoft_user_id_length
  check (microsoft_user_id is null or char_length(microsoft_user_id) <= 100);

alter table crm.calendar_accounts drop constraint if exists calendar_accounts_granted_scopes_length;
alter table crm.calendar_accounts
  add constraint calendar_accounts_granted_scopes_length
  check (granted_scopes is null or char_length(granted_scopes) <= 2000);

grant update (microsoft_user_id, granted_scopes) on crm.calendar_accounts to authenticated;
