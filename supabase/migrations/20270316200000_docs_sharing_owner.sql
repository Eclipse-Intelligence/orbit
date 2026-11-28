set lock_timeout = '3s';

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
  if new.shared is distinct from old.shared and (acting_agent is not null or acting_user is not null) then
    if old.user_id is null then
      if not new.shared then
        raise exception 'This doc has no owner, so it can''t be made private.' using errcode = '42501';
      end if;
    elsif old.user_id is distinct from acting_user then
      raise exception 'Only the owner can change who can see this doc.' using errcode = '42501';
    end if;
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
  before update of assistant_can_edit, user_id, shared, public_enabled, allow_download, allow_comments, public_token_hash, public_token_enc, public_expires_at, public_slug, public_slug_retired on crm.pages
  for each row execute function private.pages_guard();

create or replace function private.page_folders_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  acting_agent uuid := nullif(current_setting('app.agent_id', true), '')::uuid;
  acting_user uuid := (select private.session_user_id());
begin
  if new.shared is distinct from old.shared and (acting_agent is not null or acting_user is not null) then
    if old.user_id is null then
      if not new.shared then
        raise exception 'This folder has no owner, so it can''t be made private.' using errcode = '42501';
      end if;
    elsif old.user_id is distinct from acting_user then
      raise exception 'Only the owner can change who can see this folder.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.page_folders_guard() from public;

drop trigger if exists page_folders_guard on crm.page_folders;
create trigger page_folders_guard
  before update of shared on crm.page_folders
  for each row execute function private.page_folders_guard();

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
    if tg_op = 'UPDATE' and new.parent_id is distinct from old.parent_id then
      perform pg_advisory_xact_lock(hashtextextended('page_folders:' || new.workspace_id::text, 0));
    end if;
    select f.workspace_id, f.effective_shared into parent_workspace, parent_shared
    from crm.page_folders f where f.id = new.parent_id;
    if parent_workspace is null or parent_workspace <> new.workspace_id then
      raise exception 'That folder isn''t in this workspace.' using errcode = '23503';
    end if;
    if tg_op = 'UPDATE' and exists (
      with recursive up as (
        select f.id, f.parent_id from crm.page_folders f where f.id = new.parent_id
        union
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

create or replace function private.page_folders_spread()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.effective_shared and not new.effective_shared then
    with recursive own as (
      select f.id from crm.page_folders f where f.id = new.id
      union
      select c.id from crm.page_folders c join own o on c.parent_id = o.id where c.user_id is not distinct from new.user_id
    )
    update crm.page_folders c set parent_id = null
    from own o
    where c.parent_id = o.id and c.user_id is distinct from new.user_id;
  end if;
  if new.effective_shared is distinct from old.effective_shared then
    with recursive tree as (
      select new.id as id, new.effective_shared as eff
      union
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
  if old.effective_shared and not new.effective_shared then
    with recursive tree as (
      select new.id as id
      union
      select c.id from crm.page_folders c join tree t on c.parent_id = t.id
    )
    update crm.pages p set folder_id = null
    from crm.page_folders f
    where f.id = p.folder_id
      and f.id in (select id from tree)
      and not f.effective_shared
      and not p.shared
      and p.user_id is not null
      and p.user_id is distinct from f.user_id;
  end if;
  return null;
end;
$$;

update crm.pages p set folder_id = null
from crm.page_folders f
where f.id = p.folder_id
  and not f.effective_shared
  and not p.shared
  and p.user_id is not null
  and p.user_id is distinct from f.user_id;

create or replace function private.private_tagged_pages(p_folder_ids uuid[], p_page_ids uuid[] default '{}')
returns table (page_id uuid, user_id uuid, workspace_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.user_id, p.workspace_id
  from crm.pages p
  where (p.folder_id = any(p_folder_ids) or p.id = any(p_page_ids))
    and p.user_id is not null
    and not p.effective_shared
    and exists (select 1 from crm.page_links l where l.page_id = p.id and l.target_kind = 'member')
  order by p.user_id, p.id;
$$;

drop function if exists private.private_tagged_pages(uuid[]);

revoke all on function private.private_tagged_pages(uuid[], uuid[]) from public;
grant execute on function private.private_tagged_pages(uuid[], uuid[]) to crm_app;
