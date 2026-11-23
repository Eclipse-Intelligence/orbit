set lock_timeout = '5s';

alter table crm.mail_folders add column if not exists walk_started_at timestamptz;
alter table crm.mail_folders add column if not exists walk_was_live boolean not null default false;
alter table crm.mail_folders add column if not exists classify_link text;
alter table crm.mail_messages add column if not exists walk_seen_at timestamptz;

reset lock_timeout;
