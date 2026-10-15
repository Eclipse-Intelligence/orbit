create or replace function private.session_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid()
$$;

revoke all on function private.session_user_id() from public;
grant execute on function private.session_user_id() to authenticated;

create or replace function private.booking_hours_valid(p_hours jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_range jsonb;
begin
  if p_hours is null or jsonb_typeof(p_hours) <> 'object' then
    return false;
  end if;
  for v_key, v_value in select key, value from jsonb_each(p_hours) loop
    if v_key not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
      return false;
    end if;
    if jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) > 4 then
      return false;
    end if;
    for v_range in select value from jsonb_array_elements(v_value) loop
      if jsonb_typeof(v_range) <> 'object'
        or coalesce(v_range ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or coalesce(v_range ->> 'end', '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
        or (v_range ->> 'end') <= (v_range ->> 'start')
      then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;

revoke all on function private.booking_hours_valid(jsonb) from public;
grant execute on function private.booking_hours_valid(jsonb) to authenticated;

create table if not exists crm.booking_pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  slug text not null,
  enabled boolean not null default false,
  title text,
  intro text,
  duration_minutes integer not null default 30,
  buffer_minutes integer not null default 10,
  min_notice_minutes integer not null default 240,
  horizon_days integer not null default 21,
  weekly_hours jsonb not null default '{
    "mon": [{"start": "09:00", "end": "17:30"}],
    "tue": [{"start": "09:00", "end": "17:30"}],
    "wed": [{"start": "09:00", "end": "17:30"}],
    "thu": [{"start": "09:00", "end": "17:30"}],
    "fri": [{"start": "09:00", "end": "17:30"}],
    "sat": [],
    "sun": []
  }'::jsonb,
  time_zone text not null default 'Europe/London',
  background_video_url text,
  background_poster bytea,
  background_poster_mime text,
  avatar bytea,
  avatar_mime text,
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_pages_user_key unique (user_id),
  constraint booking_pages_slug_key unique (slug),
  constraint booking_pages_slug_format check (
    char_length(slug) between 3 and 40
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint booking_pages_slug_reserved check (
    slug <> all (array[
      'about', 'account', 'admin', 'api', 'app', 'assets', 'auth', 'billing', 'blog', 'book',
      'booking', 'bookings', 'calendar', 'callback', 'contact', 'contacts', 'companies', 'cron',
      'dashboard', 'docs', 'edit', 'help', 'home', 'inbox', 'index', 'login', 'logout', 'mail',
      'new', 'null', 'orbit', 'privacy', 'public', 'root', 'settings', 'signin', 'signout',
      'signup', 'static', 'status', 'support', 'system', 'terms', 'test', 'undefined', 'user',
      'users', 'webhook', 'webhooks', 'www'
    ])
  ),
  constraint booking_pages_title_length check (title is null or char_length(title) between 1 and 120),
  constraint booking_pages_intro_length check (intro is null or char_length(intro) <= 500),
  constraint booking_pages_duration check (duration_minutes in (15, 20, 30, 45, 60)),
  constraint booking_pages_buffer check (buffer_minutes between 0 and 60),
  constraint booking_pages_notice check (min_notice_minutes between 0 and 20160),
  constraint booking_pages_horizon check (horizon_days between 1 and 90),
  constraint booking_pages_hours check (
    pg_column_size(weekly_hours) <= 4000 and private.booking_hours_valid(weekly_hours)
  ),
  constraint booking_pages_time_zone check (char_length(time_zone) between 1 and 64),
  constraint booking_pages_video_url check (
    background_video_url is null
    or (char_length(background_video_url) between 9 and 1000 and background_video_url ~ '^https://[^\s]+$')
  ),
  constraint booking_pages_poster check (
    (background_poster is null and background_poster_mime is null)
    or (
      background_poster is not null
      and octet_length(background_poster) between 1 and 1048576
      and background_poster_mime in ('image/jpeg', 'image/png', 'image/webp')
    )
  ),
  constraint booking_pages_avatar check (
    (avatar is null and avatar_mime is null)
    or (
      avatar is not null
      and octet_length(avatar) between 1 and 1048576
      and avatar_mime in ('image/jpeg', 'image/png', 'image/webp')
    )
  ),
  constraint booking_pages_error_length check (last_error is null or char_length(last_error) <= 500)
);

create index if not exists booking_pages_workspace_idx on crm.booking_pages (workspace_id);

drop trigger if exists booking_pages_set_updated_at on crm.booking_pages;
create trigger booking_pages_set_updated_at
  before update on crm.booking_pages
  for each row execute function private.set_updated_at();

alter table crm.booking_pages enable row level security;
alter table crm.booking_pages force row level security;

drop policy if exists booking_pages_select_owner on crm.booking_pages;
create policy booking_pages_select_owner on crm.booking_pages
  for select to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists booking_pages_insert_owner on crm.booking_pages;
create policy booking_pages_insert_owner on crm.booking_pages
  for insert to authenticated
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists booking_pages_update_owner on crm.booking_pages;
create policy booking_pages_update_owner on crm.booking_pages
  for update to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists booking_pages_delete_owner on crm.booking_pages;
create policy booking_pages_delete_owner on crm.booking_pages
  for delete to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

revoke all on crm.booking_pages from anon, authenticated, crm_agent;
grant select, insert, delete on crm.booking_pages to authenticated;
grant update (
  slug, enabled, title, intro, duration_minutes, buffer_minutes, min_notice_minutes, horizon_days,
  weekly_hours, time_zone, background_video_url, background_poster, background_poster_mime,
  avatar, avatar_mime, last_error, last_error_at
) on crm.booking_pages to authenticated;

create or replace function private.booking_page_public(p_slug text)
returns table (
  page_id uuid,
  user_id uuid,
  slug text,
  owner_name text,
  title text,
  intro text,
  duration_minutes integer,
  buffer_minutes integer,
  min_notice_minutes integer,
  horizon_days integer,
  weekly_hours jsonb,
  time_zone text,
  background_video_url text,
  has_avatar boolean,
  has_poster boolean,
  meeting_kind text,
  version text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.id,
    b.user_id,
    b.slug,
    coalesce(nullif(trim(p.full_name), ''), split_part(p.email, '@', 1)),
    coalesce(
      b.title,
      'Book a call with ' || split_part(coalesce(nullif(trim(p.full_name), ''), split_part(p.email, '@', 1)), ' ', 1)
    ),
    b.intro,
    b.duration_minutes,
    b.buffer_minutes,
    b.min_notice_minutes,
    b.horizon_days,
    b.weekly_hours,
    b.time_zone,
    b.background_video_url,
    b.avatar is not null,
    b.background_poster is not null,
    case
      when p.meeting_link is null then null
      when p.meeting_link ~* '^https://([a-z0-9-]+\.)*whereby\.com(/|$)' then 'whereby'
      else 'link'
    end,
    substr(md5(b.updated_at::text), 1, 12)
  from crm.booking_pages b
  join crm.profiles p on p.id = b.user_id
  join crm.workspace_members m on m.workspace_id = b.workspace_id and m.user_id = b.user_id
  where b.slug = lower(trim(p_slug)) and b.enabled
  limit 1
$$;

create or replace function private.booking_page_image(p_slug text, p_kind text)
returns table (data bytea, mime text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    case when p_kind = 'avatar' then b.avatar else b.background_poster end,
    case when p_kind = 'avatar' then b.avatar_mime else b.background_poster_mime end
  from crm.booking_pages b
  where b.slug = lower(trim(p_slug))
    and b.enabled
    and p_kind in ('avatar', 'poster')
    and (case when p_kind = 'avatar' then b.avatar else b.background_poster end) is not null
  limit 1
$$;

create or replace function private.booking_busy(p_user_id uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '100 days' then
    raise exception 'invalid busy window' using errcode = '22023';
  end if;
  if not exists (select 1 from crm.booking_pages b where b.user_id = p_user_id and b.enabled) then
    return;
  end if;

  return query
  select e.starts_at, e.ends_at
  from crm.calendar_events e
  join crm.calendars c on c.id = e.calendar_id and c.user_id = e.user_id
  where e.user_id = p_user_id
    and not e.is_cancelled
    and coalesce(lower(e.show_as), 'busy') <> 'free'
    and e.starts_at < p_to
    and e.ends_at > p_from
  order by e.starts_at
  limit 5000;
end;
$$;

create or replace function private.booking_page_owner(p_slug text)
returns table (
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.booking_pages b
  join crm.workspace_members m on m.workspace_id = b.workspace_id and m.user_id = b.user_id
  join crm.workspaces w on w.id = b.workspace_id
  join crm.profiles p on p.id = b.user_id
  where b.slug = lower(trim(p_slug)) and b.enabled
  limit 1
$$;

create or replace function private.booking_slug_taken(p_slug text, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.booking_pages b
    where b.slug = lower(trim(p_slug))
      and b.user_id is distinct from p_user_id
  )
$$;

revoke all on function private.booking_page_public(text) from public;
revoke all on function private.booking_page_image(text, text) from public;
revoke all on function private.booking_busy(uuid, timestamptz, timestamptz) from public;
revoke all on function private.booking_page_owner(text) from public;
revoke all on function private.booking_slug_taken(text, uuid) from public;
grant execute on function private.booking_page_public(text) to crm_app;
grant execute on function private.booking_page_image(text, text) to crm_app;
grant execute on function private.booking_busy(uuid, timestamptz, timestamptz) to crm_app;
grant execute on function private.booking_page_owner(text) to crm_app;
grant execute on function private.booking_slug_taken(text, uuid) to crm_app;
