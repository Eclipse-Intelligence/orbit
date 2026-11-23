set lock_timeout = '5s';

alter table crm.mail_reminders add column if not exists without_folder boolean not null default false;

reset lock_timeout;
