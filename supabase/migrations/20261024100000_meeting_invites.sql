alter table crm.profiles add column if not exists meeting_link text;

alter table crm.profiles drop constraint if exists profiles_meeting_link_https;
alter table crm.profiles
  add constraint profiles_meeting_link_https
  check (meeting_link is null or (char_length(meeting_link) between 9 and 500 and meeting_link ~ '^https://[^\s]+$'));

alter table crm.calendar_events add column if not exists created_by_orbit boolean not null default false;
grant update (created_by_orbit) on crm.calendar_events to authenticated;

alter table crm.integration_state add column if not exists granted_scopes text;

alter table crm.integration_state drop constraint if exists integration_state_granted_scopes_length;
alter table crm.integration_state
  add constraint integration_state_granted_scopes_length
  check (granted_scopes is null or char_length(granted_scopes) <= 2000);

grant update (granted_scopes) on crm.integration_state to authenticated;
