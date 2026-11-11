set lock_timeout = '5s';

alter table crm.mail_preferences add column if not exists notify_team boolean not null default true;

reset lock_timeout;
