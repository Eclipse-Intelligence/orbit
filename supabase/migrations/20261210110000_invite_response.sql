alter table crm.calendar_events add column if not exists response_status text;

alter table crm.calendar_events drop constraint if exists calendar_events_response_status_length;
alter table crm.calendar_events
  add constraint calendar_events_response_status_length
  check (response_status is null or char_length(response_status) <= 40);

grant update (response_status) on crm.calendar_events to authenticated;
