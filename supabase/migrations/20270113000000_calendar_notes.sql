set lock_timeout = '5s';

create table if not exists crm.calendar_event_notes (
  event_id uuid primary key references crm.calendar_events (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  notes text not null,
  updated_at timestamptz not null default now(),
  constraint calendar_event_notes_length check (char_length(notes) between 1 and 8000)
);

create index if not exists calendar_event_notes_user_idx on crm.calendar_event_notes (user_id);

alter table crm.calendar_event_notes enable row level security;
alter table crm.calendar_event_notes force row level security;

drop policy if exists calendar_event_notes_owner on crm.calendar_event_notes;
create policy calendar_event_notes_owner on crm.calendar_event_notes
  for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and event_id in (
      select id from crm.calendar_events where user_id = (select private.session_user_id())
    )
  );

revoke all on crm.calendar_event_notes from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.calendar_event_notes to authenticated;

create table if not exists crm.calendar_event_links (
  event_id uuid primary key references crm.calendar_events (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  join_url text not null,
  updated_at timestamptz not null default now(),
  constraint calendar_event_links_url check (char_length(join_url) <= 2000 and join_url ~ '^https?://')
);

create index if not exists calendar_event_links_user_idx on crm.calendar_event_links (user_id);

create or replace function private.calendar_event_guest(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from crm.calendar_events e
    join crm.profiles p on p.id = (select private.session_user_id())
    cross join lateral (
      select lower(p.email) as email
      union
      select lower(other) from unnest(p.other_emails) as other
    ) mine
    where e.id = p_event
      and e.workspace_id in (select private.user_workspace_ids())
      and mine.email is not null
      and (
        lower(e.organizer ->> 'email') = mine.email
        or e.attendees @> jsonb_build_array(jsonb_build_object('email', mine.email))
      )
  );
$$;

revoke all on function private.calendar_event_guest(uuid) from public;
grant execute on function private.calendar_event_guest(uuid) to authenticated;

alter table crm.calendar_event_links enable row level security;
alter table crm.calendar_event_links force row level security;

drop policy if exists calendar_event_links_owner on crm.calendar_event_links;
create policy calendar_event_links_owner on crm.calendar_event_links
  for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and event_id in (
      select id from crm.calendar_events where user_id = (select private.session_user_id())
    )
  );

drop policy if exists calendar_event_links_select_guest on crm.calendar_event_links;
create policy calendar_event_links_select_guest on crm.calendar_event_links
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and private.calendar_event_guest(event_id)
  );

revoke all on crm.calendar_event_links from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.calendar_event_links to authenticated;

reset lock_timeout;
