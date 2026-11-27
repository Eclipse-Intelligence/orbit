set lock_timeout = '5s';

alter table crm.pages add column if not exists allow_comments boolean not null default false;

grant update (allow_comments) on crm.pages to authenticated, crm_agent;

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
  if (new.public_enabled, new.allow_download, new.allow_comments, new.public_token_hash, new.public_token_enc, new.public_expires_at, new.public_slug)
    is distinct from (old.public_enabled, old.allow_download, old.allow_comments, old.public_token_hash, old.public_token_enc, old.public_expires_at, old.public_slug) then
    if pg_trigger_depth() > 1
      and old.public_enabled and not new.public_enabled
      and new.allow_download is not distinct from old.allow_download
      and new.allow_comments is not distinct from old.allow_comments
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
  before update of assistant_can_edit, user_id, public_enabled, allow_download, allow_comments, public_token_hash, public_token_enc, public_expires_at, public_slug, public_slug_retired on crm.pages
  for each row execute function private.pages_guard();

create table if not exists crm.page_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  page_id uuid not null references crm.pages (id) on delete cascade,
  parent_id uuid references crm.page_comments (id) on delete cascade,
  author_name text not null,
  visitor_key_hash text,
  author_user_id uuid references crm.profiles (id) on delete set null,
  body text not null,
  anchor jsonb,
  resolved_at timestamptz,
  resolved_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint page_comments_author_name check (author_name = btrim(author_name) and char_length(author_name) between 1 and 60),
  constraint page_comments_body check (char_length(body) between 1 and 2000),
  constraint page_comments_key_hash check (visitor_key_hash is null or visitor_key_hash ~ '^[0-9a-f]{64}$'),
  constraint page_comments_anchor_roots check (parent_id is null or anchor is null),
  constraint page_comments_anchor_shape check (anchor is null or (jsonb_typeof(anchor) = 'object' and char_length(anchor::text) <= 4000)),
  constraint page_comments_not_own_parent check (parent_id is distinct from id)
);

alter table crm.page_comments enable row level security;
alter table crm.page_comments force row level security;

revoke all on crm.page_comments from public, anon, authenticated, crm_agent;

drop function if exists private.public_page_link(text);

create function private.public_page_link(p_value text)
returns table (title text, content text, edited_at timestamptz, allow_download boolean, expires_at timestamptz, public_slug text, forward_token_enc text, allow_comments boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with hit as (
    select p.title, p.content, p.edited_at, p.allow_download, p.allow_comments, p.public_expires_at, p.public_slug, p.public_token_enc,
      p.public_enabled, p.archived_at, p.kind, true as by_token
    from crm.pages p
    where p.public_token_hash = encode(sha256(convert_to(p_value, 'UTF8')), 'hex')
    union all
    select p.title, p.content, p.edited_at, p.allow_download, p.allow_comments, p.public_expires_at, p.public_slug, p.public_token_enc,
      p.public_enabled, p.archived_at, p.kind, false
    from crm.page_public_slugs s
    join crm.pages p on p.id = s.page_id
    where s.slug = lower(p_value)
    order by by_token desc
    limit 1
  )
  select h.title, h.content, h.edited_at, h.allow_download, h.public_expires_at, h.public_slug,
    case when not h.by_token and h.public_slug is null then h.public_token_enc end,
    h.allow_comments
  from hit h
  where h.public_enabled
    and (h.public_expires_at is null or h.public_expires_at > now())
    and h.archived_at is null
    and h.kind = 'note';
$$;

revoke all on function private.public_page_link(text) from public;
grant execute on function private.public_page_link(text) to crm_app;

create or replace function private.public_comment_page(p_value text)
returns table (page_id uuid, workspace_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with hit as (
    select p.id, p.workspace_id, p.allow_comments, p.public_enabled, p.public_expires_at, p.archived_at, p.kind, true as by_token
    from crm.pages p
    where p.public_token_hash = encode(sha256(convert_to(p_value, 'UTF8')), 'hex')
    union all
    select p.id, p.workspace_id, p.allow_comments, p.public_enabled, p.public_expires_at, p.archived_at, p.kind, false
    from crm.page_public_slugs s
    join crm.pages p on p.id = s.page_id
    where s.slug = lower(p_value)
    order by by_token desc
    limit 1
  )
  select h.id, h.workspace_id
  from hit h
  where h.public_enabled
    and h.allow_comments
    and (h.public_expires_at is null or h.public_expires_at > now())
    and h.archived_at is null
    and h.kind = 'note';
$$;

revoke all on function private.public_comment_page(text) from public;
grant execute on function private.public_comment_page(text) to crm_app;

create or replace function private.public_comments_list(p_value text, p_key_hash text)
returns table (id uuid, parent_id uuid, author_name text, body text, anchor jsonb, created_at timestamptz, edited_at timestamptz, resolved boolean, mine boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.parent_id, c.author_name, c.body, c.anchor, c.created_at, c.edited_at,
    coalesce(r.resolved_at, c.resolved_at) is not null,
    p_key_hash is not null and c.visitor_key_hash is not null and c.visitor_key_hash = p_key_hash
  from private.public_comment_page(p_value) pg
  join crm.page_comments c on c.page_id = pg.page_id and c.deleted_at is null
  left join crm.page_comments r on r.id = c.parent_id
  where c.parent_id is null or r.deleted_at is null
  order by c.created_at, c.id;
$$;

revoke all on function private.public_comments_list(text, text) from public;
grant execute on function private.public_comments_list(text, text) to crm_app;

create or replace function private.public_comment_add(p_value text, p_key_hash text, p_name text, p_body text, p_parent uuid, p_anchor jsonb)
returns table (id uuid, parent_id uuid, author_name text, body text, anchor jsonb, created_at timestamptz, edited_at timestamptz, resolved boolean, mine boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_page uuid;
  v_workspace uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  select pg.page_id, pg.workspace_id into v_page, v_workspace from private.public_comment_page(p_value) pg;
  if v_page is null then
    return;
  end if;
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Couldn''t comment. Try again.' using errcode = '22023';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'Use a name of 1 to 60 characters.' using errcode = '22023';
  end if;
  if char_length(v_body) not between 1 and 2000 then
    raise exception 'A comment is 1 to 2000 characters.' using errcode = '22023';
  end if;
  if p_parent is null then
    if p_anchor is null or jsonb_typeof(p_anchor) <> 'object' or char_length(p_anchor::text) > 4000 then
      raise exception 'Couldn''t comment. Try again.' using errcode = '22023';
    end if;
  elsif p_anchor is not null or not exists (
    select 1 from crm.page_comments r
    where r.id = p_parent and r.page_id = v_page and r.parent_id is null and r.deleted_at is null
  ) then
    raise exception 'That comment is no longer there.' using errcode = '22023';
  end if;
  if (select count(*) from crm.page_comments c where c.page_id = v_page and c.deleted_at is null) >= 1000 then
    raise exception 'This doc has the most comments it can take.' using errcode = '22023';
  end if;
  insert into crm.page_comments (workspace_id, page_id, parent_id, author_name, visitor_key_hash, body, anchor)
  values (v_workspace, v_page, p_parent, v_name, p_key_hash, v_body, p_anchor)
  returning crm.page_comments.id into v_id;
  return query
    select c.id, c.parent_id, c.author_name, c.body, c.anchor, c.created_at, c.edited_at, false, true
    from crm.page_comments c
    where c.id = v_id;
end;
$$;

revoke all on function private.public_comment_add(text, text, text, text, uuid, jsonb) from public;
grant execute on function private.public_comment_add(text, text, text, text, uuid, jsonb) to crm_app;

create or replace function private.public_comment_edit(p_value text, p_key_hash text, p_id uuid, p_body text)
returns table (id uuid, parent_id uuid, author_name text, body text, anchor jsonb, created_at timestamptz, edited_at timestamptz, resolved boolean, mine boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_page uuid;
  v_body text := btrim(coalesce(p_body, ''));
begin
  select pg.page_id into v_page from private.public_comment_page(p_value) pg;
  if v_page is null or p_key_hash is null then
    return;
  end if;
  if char_length(v_body) not between 1 and 2000 then
    raise exception 'A comment is 1 to 2000 characters.' using errcode = '22023';
  end if;
  return query
    with changed as (
      update crm.page_comments c
      set body = v_body, edited_at = now()
      where c.id = p_id and c.page_id = v_page and c.deleted_at is null
        and c.visitor_key_hash is not null and c.visitor_key_hash = p_key_hash
      returning c.*
    )
    select c.id, c.parent_id, c.author_name, c.body, c.anchor, c.created_at, c.edited_at,
      (c.resolved_at is not null or exists (select 1 from crm.page_comments r where r.id = c.parent_id and r.resolved_at is not null)),
      true
    from changed c;
end;
$$;

revoke all on function private.public_comment_edit(text, text, uuid, text) from public;
grant execute on function private.public_comment_edit(text, text, uuid, text) to crm_app;

create or replace function private.public_comment_delete(p_value text, p_key_hash text, p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_page uuid;
  v_count integer;
begin
  select pg.page_id into v_page from private.public_comment_page(p_value) pg;
  if v_page is null or p_key_hash is null then
    return false;
  end if;
  update crm.page_comments c
  set deleted_at = now()
  where c.id = p_id and c.page_id = v_page and c.deleted_at is null
    and c.visitor_key_hash is not null and c.visitor_key_hash = p_key_hash;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function private.public_comment_delete(text, text, uuid) from public;
grant execute on function private.public_comment_delete(text, text, uuid) to crm_app;

reset lock_timeout;

create index concurrently if not exists page_comments_page_idx on crm.page_comments (page_id, created_at);

create index concurrently if not exists page_comments_parent_idx on crm.page_comments (parent_id) where parent_id is not null;
