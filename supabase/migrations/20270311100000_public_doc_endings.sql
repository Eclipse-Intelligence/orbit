set lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'Run this as a role that bypasses row-level security: the trigger functions write to crm.page_public_slugs.';
  end if;
end;
$$;

alter table crm.pages add column if not exists public_slug text;
alter table crm.pages add column if not exists public_slug_retired boolean not null default false;

alter table crm.pages drop constraint if exists pages_public_slug_shape;
alter table crm.pages
  add constraint pages_public_slug_shape check (
    public_slug is null or (char_length(public_slug) between 3 and 40 and public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
  ) not valid;
alter table crm.pages validate constraint pages_public_slug_shape;

alter table crm.pages drop constraint if exists pages_public_slug_has_token;
alter table crm.pages
  add constraint pages_public_slug_has_token check (public_slug is null or (kind = 'note' and public_token_hash is not null)) not valid;
alter table crm.pages validate constraint pages_public_slug_has_token;

create table if not exists crm.page_public_slugs (
  slug text primary key,
  page_id uuid not null references crm.pages (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint page_public_slugs_shape check (char_length(slug) between 3 and 40 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

alter table crm.page_public_slugs enable row level security;
alter table crm.page_public_slugs force row level security;

revoke all on crm.page_public_slugs from public, anon, authenticated, crm_agent;

grant update (public_slug) on crm.pages to authenticated, crm_agent;

create or replace function private.pages_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  acting_agent uuid := nullif(current_setting('app.agent_id', true), '')::uuid;
  acting_user uuid := (select private.session_user_id());
begin
  if new.user_id is distinct from old.user_id then
    new.assistant_can_edit := false;
  elsif new.assistant_can_edit and not old.assistant_can_edit
    and (new.user_id is null or new.user_id is distinct from (select private.session_user_id())) then
    raise exception 'Only the doc''s owner can let the assistant edit it without asking.' using errcode = '42501';
  end if;
  if old.public_token_hash is not null and new.public_token_hash is distinct from old.public_token_hash then
    raise exception 'A doc''s public link never changes.' using errcode = '42501';
  end if;
  if (new.public_enabled, new.allow_download, new.public_token_hash, new.public_token_enc, new.public_expires_at, new.public_slug)
    is distinct from (old.public_enabled, old.allow_download, old.public_token_hash, old.public_token_enc, old.public_expires_at, old.public_slug) then
    if pg_trigger_depth() > 1
      and old.public_enabled and not new.public_enabled
      and new.allow_download is not distinct from old.allow_download
      and new.public_token_hash is not distinct from old.public_token_hash
      and new.public_token_enc is not distinct from old.public_token_enc
      and new.public_expires_at is not distinct from old.public_expires_at
      and new.public_slug is not distinct from old.public_slug then
      null;
    elsif acting_agent is not null then
      if old.created_by_agent_id is distinct from acting_agent then
        raise exception 'Only the doc''s owner can change its public link.' using errcode = '42501';
      end if;
    elsif acting_user is not null then
      if old.user_id is distinct from acting_user
        and not (
          old.user_id is null
          and exists (
            select 1 from crm.workspace_members m
            where m.workspace_id = old.workspace_id and m.user_id = acting_user and m.role = 'owner'
          )
        ) then
        raise exception 'Only the doc''s owner can change its public link.' using errcode = '42501';
      end if;
    end if;
  end if;
  if old.public_slug is not null and new.public_slug is distinct from old.public_slug then
    new.public_slug_retired := true;
  end if;
  return new;
end;
$$;

drop trigger if exists pages_guard on crm.pages;
create trigger pages_guard
  before update of assistant_can_edit, user_id, public_enabled, allow_download, public_token_hash, public_token_enc, public_expires_at, public_slug, public_slug_retired on crm.pages
  for each row execute function private.pages_guard();

create or replace function private.pages_public_slug_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.public_slug is null then
    return null;
  end if;
  insert into crm.page_public_slugs (slug, page_id) values (new.public_slug, new.id) on conflict (slug) do nothing;
  if not exists (select 1 from crm.page_public_slugs s where s.slug = new.public_slug and s.page_id = new.id)
    or exists (select 1 from crm.pages p where p.public_token_hash = encode(sha256(convert_to(new.public_slug, 'UTF8')), 'hex')) then
    raise exception 'Taken. Pick another.' using errcode = '23505';
  end if;
  return null;
end;
$$;

revoke all on function private.pages_public_slug_record() from public;

drop trigger if exists pages_public_slug_record on crm.pages;
create trigger pages_public_slug_record
  after update of public_slug on crm.pages
  for each row when (new.public_slug is not null and new.public_slug is distinct from old.public_slug)
  execute function private.pages_public_slug_record();

create or replace function private.public_page_link(p_value text)
returns table (title text, content text, edited_at timestamptz, allow_download boolean, expires_at timestamptz, public_slug text, forward_token_enc text)
language sql
stable
security definer
set search_path = ''
as $$
  with hit as (
    select p.title, p.content, p.edited_at, p.allow_download, p.public_expires_at, p.public_slug, p.public_token_enc,
      p.public_enabled, p.archived_at, p.kind, true as by_token
    from crm.pages p
    where p.public_token_hash = encode(sha256(convert_to(p_value, 'UTF8')), 'hex')
    union all
    select p.title, p.content, p.edited_at, p.allow_download, p.public_expires_at, p.public_slug, p.public_token_enc,
      p.public_enabled, p.archived_at, p.kind, false
    from crm.page_public_slugs s
    join crm.pages p on p.id = s.page_id
    where s.slug = lower(p_value)
    order by by_token desc
    limit 1
  )
  select h.title, h.content, h.edited_at, h.allow_download, h.public_expires_at, h.public_slug,
    case when not h.by_token and h.public_slug is null then h.public_token_enc end
  from hit h
  where h.public_enabled
    and (h.public_expires_at is null or h.public_expires_at > now())
    and h.archived_at is null
    and h.kind = 'note';
$$;

revoke all on function private.public_page_link(text) from public;
grant execute on function private.public_page_link(text) to crm_app;

create or replace function private.public_slug_taken(p_slug text, p_page_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from crm.page_public_slugs s where s.slug = p_slug and s.page_id is distinct from p_page_id)
    or exists (select 1 from crm.pages p where p.public_token_hash = encode(sha256(convert_to(p_slug, 'UTF8')), 'hex'));
$$;

revoke all on function private.public_slug_taken(text, uuid) from public;
grant execute on function private.public_slug_taken(text, uuid) to crm_app;

reset lock_timeout;

create index concurrently if not exists page_public_slugs_page_idx on crm.page_public_slugs (page_id);
