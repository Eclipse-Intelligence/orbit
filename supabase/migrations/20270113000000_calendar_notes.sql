set lock_timeout = '5s';

alter table crm.calendar_events add column if not exists notes text;

alter table crm.calendar_events drop constraint if exists calendar_events_notes_length;
alter table crm.calendar_events
  add constraint calendar_events_notes_length check (notes is null or char_length(notes) <= 8000);

alter table crm.calendar_events enable row level security;
alter table crm.calendar_events force row level security;

grant update (notes) on crm.calendar_events to authenticated;

reset lock_timeout;
