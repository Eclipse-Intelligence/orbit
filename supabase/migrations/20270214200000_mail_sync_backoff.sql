set lock_timeout = '5s';

alter table crm.mail_folders add column if not exists failures integer not null default 0;
alter table crm.mail_folders add column if not exists retry_at timestamptz;
alter table crm.mail_sources add column if not exists retry_at timestamptz;

reset lock_timeout;
