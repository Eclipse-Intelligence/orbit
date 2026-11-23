alter table crm.mail_reminders add column if not exists without_folder boolean not null default false;
