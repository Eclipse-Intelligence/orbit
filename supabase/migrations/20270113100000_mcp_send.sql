set lock_timeout = '5s';

alter table crm.personal_tokens add column if not exists can_send boolean not null default false;

alter table crm.mail_send_keys add column if not exists content_hash text;
alter table crm.mail_send_keys add column if not exists token_id uuid;

alter table crm.mail_send_keys drop constraint if exists mail_send_keys_content_hash;
alter table crm.mail_send_keys add constraint mail_send_keys_content_hash check (content_hash is null or char_length(content_hash) <= 64);

reset lock_timeout;
