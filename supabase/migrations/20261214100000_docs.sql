create schema if not exists extensions;

grant usage on schema extensions to authenticated, crm_agent, crm_app;

alter table crm.agents drop constraint if exists agents_scopes_valid;
alter table crm.agents
  add constraint agents_scopes_valid check (
    scopes <@ array['crm:read', 'companies:write', 'contacts:write', 'leads:write', 'activities:write', 'opportunities:write', 'tasks:write', 'market:write', 'docs:read', 'docs:write', 'admin']::text[]
    and cardinality(scopes) > 0
  );

create table if not exists crm.page_folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid references crm.profiles (id) on delete set null,
  parent_id uuid references crm.page_folders (id) on delete cascade,
  name text not null,
  position double precision not null default 0,
  shared boolean not null default false,
  effective_shared boolean not null default false,
  created_by_agent_id uuid references crm.agents (id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_folders_name check (char_length(btrim(name)) between 1 and 200),
  constraint page_folders_not_own_parent check (parent_id is distinct from id)
);

create table if not exists crm.pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid references crm.profiles (id) on delete set null,
  folder_id uuid references crm.page_folders (id) on delete set null,
  kind text not null default 'note',
  daily_date date,
  title text not null default '',
  content text not null default '',
  word_count integer not null default 0,
  revision integer not null default 1,
  shared boolean not null default false,
  effective_shared boolean not null default false,
  assistant_can_edit boolean not null default false,
  ydoc bytea,
  search tsvector generated always as (
    setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', left(content, 200000)), 'B')
  ) stored,
  created_by_agent_id uuid references crm.agents (id) on delete set null,
  edited_by text not null default 'person',
  edited_by_user_id uuid references crm.profiles (id) on delete set null,
  edited_by_agent_id uuid references crm.agents (id) on delete set null,
  edited_at timestamptz not null default now(),
  versioned_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pages_kind check (kind in ('note', 'daily')),
  constraint pages_daily_date check ((kind = 'daily') = (daily_date is not null)),
  constraint pages_daily_private check (kind <> 'daily' or (not shared and folder_id is null)),
  constraint pages_title check (char_length(title) <= 300),
  constraint pages_content check (char_length(content) <= 1000000),
  constraint pages_edited_by check (edited_by in ('person', 'assistant', 'agent'))
);

create table if not exists crm.page_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  page_id uuid not null references crm.pages (id) on delete cascade,
  target_kind text not null,
  target_key text,
  target_page_id uuid references crm.pages (id) on delete set null,
  target_record_id uuid,
  label text not null,
  heading text,
  created_at timestamptz not null default now(),
  constraint page_links_kind check (target_kind in ('page', 'contact', 'company', 'task', 'opportunity', 'proposal')),
  constraint page_links_shape check (
    (target_kind = 'page' and target_key is not null and target_record_id is null)
    or (target_kind <> 'page' and target_record_id is not null and target_key is null and target_page_id is null)
  ),
  constraint page_links_label check (char_length(label) between 1 and 400),
  constraint page_links_heading check (heading is null or char_length(heading) <= 400)
);

create table if not exists crm.page_tags (
  page_id uuid not null references crm.pages (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  tag text not null,
  primary key (page_id, tag),
  constraint page_tags_tag check (char_length(tag) between 1 and 100 and tag = lower(tag))
);

create table if not exists crm.page_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  page_id uuid not null references crm.pages (id) on delete cascade,
  title text not null,
  content text not null,
  word_count integer not null default 0,
  reason text not null,
  editor text not null,
  user_id uuid references crm.profiles (id) on delete set null,
  agent_id uuid references crm.agents (id) on delete set null,
  summary text,
  created_at timestamptz not null default clock_timestamp(),
  constraint page_versions_reason check (reason in ('created', 'edited', 'renamed', 'before_agent', 'restored', 'link_renamed')),
  constraint page_versions_editor check (editor in ('person', 'assistant', 'agent')),
  constraint page_versions_summary check (summary is null or char_length(summary) <= 500)
);

create index if not exists page_folders_parent_idx on crm.page_folders (workspace_id, parent_id, position);
create index if not exists page_folders_user_idx on crm.page_folders (workspace_id, user_id);
create index if not exists page_folders_children_idx on crm.page_folders (parent_id);

create index if not exists pages_folder_idx on crm.pages (workspace_id, folder_id, edited_at desc) where archived_at is null;
create index if not exists pages_owner_idx on crm.pages (workspace_id, user_id, edited_at desc) where archived_at is null;
create index if not exists pages_shared_idx on crm.pages (workspace_id, edited_at desc) where archived_at is null and effective_shared;
create index if not exists pages_title_key_idx on crm.pages (workspace_id, lower(title) text_pattern_ops) where archived_at is null;
create index if not exists pages_title_trgm_idx on crm.pages using gin (title gin_trgm_ops);
create index if not exists pages_search_idx on crm.pages using gin (search);
create index if not exists pages_folder_fk_idx on crm.pages (folder_id);
create unique index if not exists pages_daily_key on crm.pages (workspace_id, user_id, daily_date) where kind = 'daily';

create index if not exists page_links_page_idx on crm.page_links (page_id);
create index if not exists page_links_target_idx on crm.page_links (target_page_id) where target_page_id is not null;
create index if not exists page_links_unresolved_idx on crm.page_links (workspace_id, target_key) where target_kind = 'page' and target_page_id is null;
create index if not exists page_links_record_idx on crm.page_links (workspace_id, target_kind, target_record_id) where target_record_id is not null;

create index if not exists page_tags_tag_idx on crm.page_tags (workspace_id, tag text_pattern_ops);

create index if not exists page_versions_page_idx on crm.page_versions (page_id, created_at desc);

drop trigger if exists page_folders_set_updated_at on crm.page_folders;
create trigger page_folders_set_updated_at
  before update on crm.page_folders
  for each row execute function private.set_updated_at();

drop trigger if exists pages_set_updated_at on crm.pages;
create trigger pages_set_updated_at
  before update on crm.pages
  for each row execute function private.set_updated_at();

create or replace function private.page_folders_place()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_workspace uuid;
  parent_shared boolean := false;
begin
  if new.parent_id is not null then
    select f.workspace_id, f.effective_shared into parent_workspace, parent_shared
    from crm.page_folders f where f.id = new.parent_id;
    if parent_workspace is null or parent_workspace <> new.workspace_id then
      raise exception 'That folder isn''t in this workspace.' using errcode = '23503';
    end if;
    if tg_op = 'UPDATE' and exists (
      with recursive up as (
        select f.id, f.parent_id from crm.page_folders f where f.id = new.parent_id
        union all
        select f.id, f.parent_id from crm.page_folders f join up on f.id = up.parent_id
      )
      select 1 from up where up.id = new.id
    ) then
      raise exception 'A folder can''t go inside itself.' using errcode = '23514';
    end if;
  end if;
  new.effective_shared := new.shared or coalesce(parent_shared, false);
  return new;
end;
$$;

drop trigger if exists page_folders_place on crm.page_folders;
create trigger page_folders_place
  before insert or update of shared, parent_id on crm.page_folders
  for each row execute function private.page_folders_place();

create or replace function private.page_folders_spread()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.effective_shared is distinct from old.effective_shared then
    with recursive tree as (
      select new.id as id, new.effective_shared as eff
      union all
      select c.id, c.shared or t.eff from crm.page_folders c join tree t on c.parent_id = t.id
    ),
    folders as (
      update crm.page_folders f set effective_shared = t.eff
      from tree t
      where f.id = t.id and f.id <> new.id and f.effective_shared <> t.eff
      returning f.id
    )
    update crm.pages p set effective_shared = p.shared or t.eff
    from tree t
    where p.folder_id = t.id and p.effective_shared <> (p.shared or t.eff);
  end if;
  return null;
end;
$$;

drop trigger if exists page_folders_spread on crm.page_folders;
create trigger page_folders_spread
  after update of shared, parent_id on crm.page_folders
  for each row execute function private.page_folders_spread();

create or replace function private.pages_place()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  folder_workspace uuid;
  folder_shared boolean := false;
begin
  if new.folder_id is not null then
    select f.workspace_id, f.effective_shared into folder_workspace, folder_shared
    from crm.page_folders f where f.id = new.folder_id;
    if folder_workspace is null or folder_workspace <> new.workspace_id then
      raise exception 'That folder isn''t in this workspace.' using errcode = '23503';
    end if;
  end if;
  new.effective_shared := new.shared or coalesce(folder_shared, false);
  return new;
end;
$$;

drop trigger if exists pages_place on crm.pages;
create trigger pages_place
  before insert or update of shared, folder_id on crm.pages
  for each row execute function private.pages_place();

create or replace function private.pages_resolve_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.archived_at is null and btrim(new.title) <> '' then
    update crm.page_links l set target_page_id = new.id
    from crm.pages s
    where l.workspace_id = new.workspace_id
      and l.target_kind = 'page'
      and l.target_page_id is null
      and l.target_key = lower(btrim(new.title))
      and s.id = l.page_id
      and s.id <> new.id
      and (new.effective_shared or s.user_id = new.user_id);
  end if;
  if tg_op = 'UPDATE' then
    update crm.page_links l set target_page_id = null
    from crm.pages s
    where l.target_page_id = new.id
      and s.id = l.page_id
      and not (new.effective_shared or s.user_id is not distinct from new.user_id);
  end if;
  return null;
end;
$$;

drop trigger if exists pages_resolve_links on crm.pages;
create trigger pages_resolve_links
  after insert or update of title, shared, folder_id, effective_shared, archived_at, user_id on crm.pages
  for each row execute function private.pages_resolve_links();

alter table crm.page_folders enable row level security;
alter table crm.page_folders force row level security;
alter table crm.pages enable row level security;
alter table crm.pages force row level security;
alter table crm.page_links enable row level security;
alter table crm.page_links force row level security;
alter table crm.page_tags enable row level security;
alter table crm.page_tags force row level security;
alter table crm.page_versions enable row level security;
alter table crm.page_versions force row level security;

drop policy if exists page_folders_member on crm.page_folders;
create policy page_folders_member on crm.page_folders
  for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and (effective_shared or user_id = (select private.session_user_id())))
  with check (workspace_id in (select private.user_workspace_ids()) and (effective_shared or user_id = (select private.session_user_id())));

drop policy if exists page_folders_agent on crm.page_folders;
create policy page_folders_agent on crm.page_folders
  for all to crm_agent
  using (workspace_id = (select private.request_workspace_id()) and effective_shared)
  with check (workspace_id = (select private.request_workspace_id()) and effective_shared);

drop policy if exists pages_member on crm.pages;
create policy pages_member on crm.pages
  for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and (effective_shared or user_id = (select private.session_user_id())))
  with check (workspace_id in (select private.user_workspace_ids()) and (effective_shared or user_id = (select private.session_user_id())));

drop policy if exists pages_agent on crm.pages;
create policy pages_agent on crm.pages
  for all to crm_agent
  using (workspace_id = (select private.request_workspace_id()) and effective_shared and kind = 'note')
  with check (workspace_id = (select private.request_workspace_id()) and effective_shared and kind = 'note');

do $$
declare
  table_name text;
begin
  foreach table_name in array array['page_links', 'page_tags', 'page_versions'] loop
    execute format('drop policy if exists %I on crm.%I', table_name || '_member', table_name);
    execute format(
      'create policy %I on crm.%I for all to authenticated using (workspace_id in (select private.user_workspace_ids()) and exists (select 1 from crm.pages p where p.id = %I.page_id)) with check (workspace_id in (select private.user_workspace_ids()) and exists (select 1 from crm.pages p where p.id = %I.page_id and p.workspace_id = %I.workspace_id))',
      table_name || '_member', table_name, table_name, table_name, table_name
    );
    execute format('drop policy if exists %I on crm.%I', table_name || '_agent', table_name);
    execute format(
      'create policy %I on crm.%I for all to crm_agent using (workspace_id = (select private.request_workspace_id()) and exists (select 1 from crm.pages p where p.id = %I.page_id)) with check (workspace_id = (select private.request_workspace_id()) and exists (select 1 from crm.pages p where p.id = %I.page_id and p.workspace_id = %I.workspace_id))',
      table_name || '_agent', table_name, table_name, table_name, table_name
    );
  end loop;
end;
$$;

revoke all on crm.page_folders, crm.pages, crm.page_links, crm.page_tags, crm.page_versions from anon, authenticated, crm_agent;

grant select on crm.page_folders, crm.pages to authenticated, crm_agent;
grant insert (workspace_id, user_id, parent_id, name, position, shared, created_by_agent_id) on crm.page_folders to authenticated, crm_agent;
grant update (parent_id, name, position, shared, archived_at) on crm.page_folders to authenticated, crm_agent;
grant insert (
  workspace_id, user_id, folder_id, kind, daily_date, title, content, word_count, shared, assistant_can_edit, ydoc,
  created_by_agent_id, edited_by, edited_by_user_id, edited_by_agent_id, edited_at, versioned_at
) on crm.pages to authenticated, crm_agent;
grant update (
  folder_id, title, content, word_count, revision, shared, assistant_can_edit, ydoc,
  edited_by, edited_by_user_id, edited_by_agent_id, edited_at, versioned_at, archived_at
) on crm.pages to authenticated;
grant update (
  folder_id, title, content, word_count, revision, shared, ydoc,
  edited_by, edited_by_user_id, edited_by_agent_id, edited_at, versioned_at, archived_at
) on crm.pages to crm_agent;
grant select, insert, delete on crm.page_links, crm.page_tags, crm.page_versions to authenticated, crm_agent;

create or replace function private.docs_reassign(p_workspace uuid, p_actor uuid, p_from uuid)
returns table (docs integer, folders integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := private.team_role(p_workspace, p_actor);
  moved_docs integer;
  moved_folders integer;
begin
  if coalesce(actor_role, '') not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can take over a former member''s docs.' using errcode = '42501';
  end if;
  if private.team_role(p_workspace, p_from) is not null then
    raise exception 'They are still in this workspace, so their docs stay theirs.' using errcode = '22023';
  end if;
  update crm.page_folders set user_id = p_actor where workspace_id = p_workspace and user_id = p_from;
  get diagnostics moved_folders = row_count;
  update crm.pages set user_id = p_actor where workspace_id = p_workspace and user_id = p_from and kind = 'note';
  get diagnostics moved_docs = row_count;
  return query select moved_docs, moved_folders;
end;
$$;

revoke all on function private.docs_reassign(uuid, uuid, uuid) from public;
grant execute on function private.docs_reassign(uuid, uuid, uuid) to crm_app;
