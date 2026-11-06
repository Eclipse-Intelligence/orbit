alter table crm.calendar_events add column if not exists invite_identity_id uuid references crm.send_identities (id) on delete set null;
alter table crm.calendar_events add column if not exists invite_uid text;
alter table crm.calendar_events add column if not exists invite_sequence integer not null default 0;
alter table crm.calendar_events add column if not exists invite_notes text;
alter table crm.calendar_events add column if not exists invite_hold_missing boolean not null default false;

alter table crm.calendar_events drop constraint if exists calendar_events_invite_uid_length;
alter table crm.calendar_events
  add constraint calendar_events_invite_uid_length check (invite_uid is null or char_length(invite_uid) between 1 and 400);

alter table crm.calendar_events drop constraint if exists calendar_events_invite_sequence;
alter table crm.calendar_events
  add constraint calendar_events_invite_sequence check (invite_sequence between 0 and 100000);

alter table crm.calendar_events drop constraint if exists calendar_events_invite_notes_length;
alter table crm.calendar_events
  add constraint calendar_events_invite_notes_length check (invite_notes is null or char_length(invite_notes) <= 6000);

create index if not exists calendar_events_invite_uid_idx
  on crm.calendar_events (user_id, invite_uid) where invite_uid is not null;
create index if not exists calendar_events_invite_identity_idx
  on crm.calendar_events (invite_identity_id) where invite_identity_id is not null;

grant update (invite_identity_id, invite_uid, invite_sequence, invite_notes, invite_hold_missing, provider_event_id) on crm.calendar_events to authenticated;

alter table crm.send_identities add column if not exists hold_calendar_id uuid references crm.calendars (id) on delete set null;
alter table crm.send_identities add column if not exists reply_uid_validity bigint;
alter table crm.send_identities add column if not exists reply_last_uid bigint;

alter table crm.send_identities drop constraint if exists send_identities_reply_cursor;
alter table crm.send_identities
  add constraint send_identities_reply_cursor check (
    (reply_uid_validity is null or reply_uid_validity >= 0) and (reply_last_uid is null or reply_last_uid >= 0)
  );

alter table crm.booking_pages add column if not exists invite_sender text;

alter table crm.booking_pages drop constraint if exists booking_pages_invite_sender;
alter table crm.booking_pages
  add constraint booking_pages_invite_sender check (
    invite_sender is null or (char_length(invite_sender) between 3 and 320 and invite_sender = lower(invite_sender))
  );

grant update (invite_sender) on crm.booking_pages to authenticated;

create table if not exists crm.invite_sender_choices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  address text not null,
  updated_at timestamptz not null default now(),
  constraint invite_sender_choices_address check (char_length(address) between 3 and 320 and address = lower(address)),
  constraint invite_sender_choices_unique unique (user_id, workspace_id)
);

alter table crm.invite_sender_choices enable row level security;
alter table crm.invite_sender_choices force row level security;

drop policy if exists invite_sender_choices_owner on crm.invite_sender_choices;
create policy invite_sender_choices_owner on crm.invite_sender_choices
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.invite_sender_choices from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.invite_sender_choices to authenticated;

alter table crm.calendar_accounts add column if not exists calendar_write boolean;

grant update (calendar_write) on crm.calendar_accounts to authenticated;
