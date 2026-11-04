alter table crm.mail_reminders add column if not exists action text not null default 'remind';
alter table crm.mail_reminders add column if not exists follow_up_body text;
alter table crm.mail_reminders add column if not exists recipients jsonb;
alter table crm.mail_reminders add column if not exists identity_id uuid references crm.send_identities (id) on delete set null;
alter table crm.mail_reminders add column if not exists sent_at timestamptz;

alter table crm.mail_reminders drop constraint if exists mail_reminders_action;
alter table crm.mail_reminders add constraint mail_reminders_action
  check (action in ('remind', 'send') and (action = 'remind' or (kind = 'follow_up' and not automatic)));

alter table crm.mail_reminders drop constraint if exists mail_reminders_state;
alter table crm.mail_reminders add constraint mail_reminders_state
  check (state in ('waiting', 'due', 'done', 'sending', 'sent', 'cancelled', 'replied'));

alter table crm.mail_reminders drop constraint if exists mail_reminders_follow_up_body;
alter table crm.mail_reminders add constraint mail_reminders_follow_up_body
  check (follow_up_body is null or char_length(follow_up_body) <= 20000);

create index if not exists mail_reminders_follow_up_idx on crm.mail_reminders (user_id, source_id, thread_key)
  where kind = 'follow_up' and action = 'send';

alter table crm.mail_drafts add column if not exists follow_up_days integer;
alter table crm.mail_drafts add column if not exists follow_up_body text;

alter table crm.mail_drafts drop constraint if exists mail_drafts_follow_up_days;
alter table crm.mail_drafts add constraint mail_drafts_follow_up_days
  check (follow_up_days is null or follow_up_days between 1 and 10);

alter table crm.mail_drafts drop constraint if exists mail_drafts_follow_up_body;
alter table crm.mail_drafts add constraint mail_drafts_follow_up_body
  check (follow_up_body is null or char_length(follow_up_body) <= 20000);

alter table crm.mail_reminders enable row level security;
alter table crm.mail_reminders force row level security;
alter table crm.mail_drafts enable row level security;
alter table crm.mail_drafts force row level security;

revoke all on crm.mail_reminders from anon, crm_agent;
grant select, insert, update, delete on crm.mail_reminders to authenticated;
