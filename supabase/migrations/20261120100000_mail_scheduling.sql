alter table crm.mail_prepared add column if not exists template text;
alter table crm.mail_prepared add column if not exists slots timestamptz[];
alter table crm.mail_prepared drop constraint if exists mail_prepared_template;
alter table crm.mail_prepared add constraint mail_prepared_template check (template is null or char_length(template) <= 20000);
