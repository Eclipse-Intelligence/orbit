set lock_timeout = '5s';

alter table crm.mail_drafts add column if not exists outlook_files jsonb not null default '{}'::jsonb;

reset lock_timeout;
