set lock_timeout = '5s';

alter table crm.mail_tracking add column if not exists activity_id uuid references crm.activities (id) on delete set null;

create index if not exists mail_tracking_activity_idx on crm.mail_tracking (activity_id) where activity_id is not null;

alter table crm.mail_tracking enable row level security;
alter table crm.mail_tracking force row level security;

reset lock_timeout;
