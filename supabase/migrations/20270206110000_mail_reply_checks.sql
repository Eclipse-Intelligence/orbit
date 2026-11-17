set lock_timeout = '5s';

alter table crm.mail_prepared drop constraint if exists mail_prepared_kind;
alter table crm.mail_prepared add constraint mail_prepared_kind check (kind in ('reply', 'nudge', 'follow_up', 'pitch', 'reply_check')) not valid;

alter table crm.mail_prepared add column if not exists misses integer not null default 0;
alter table crm.mail_prepared drop constraint if exists mail_prepared_misses;
alter table crm.mail_prepared add constraint mail_prepared_misses check (misses between 0 and 10) not valid;

reset lock_timeout;

alter table crm.mail_prepared validate constraint mail_prepared_kind;
alter table crm.mail_prepared validate constraint mail_prepared_misses;
