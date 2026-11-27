set lock_timeout = '5s';

alter table crm.page_comments add column if not exists author_agent_id uuid references crm.agents (id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'page_comments_author_kind' and conrelid = 'crm.page_comments'::regclass) then
    alter table crm.page_comments add constraint page_comments_author_kind
      check (author_agent_id is null or (author_user_id is null and visitor_key_hash is null));
  end if;
end;
$$;

grant select (id, workspace_id, page_id, parent_id, author_name, author_user_id, author_agent_id, body, anchor, resolved_at, resolved_by, created_at, edited_at, deleted_at)
  on crm.page_comments to authenticated, crm_agent;
grant insert (workspace_id, page_id, parent_id, author_name, author_user_id, author_agent_id, body)
  on crm.page_comments to authenticated, crm_agent;
grant update (resolved_at, resolved_by, deleted_at)
  on crm.page_comments to authenticated, crm_agent;

do $$
begin
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'Run this as a role that bypasses row-level security: the comment helper functions read crm.pages and crm.page_comments.';
  end if;
end;
$$;

create or replace function private.comment_root_open(p_parent uuid, p_page uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.page_comments r
    where r.id = p_parent and r.page_id = p_page and r.parent_id is null and r.deleted_at is null
  );
$$;

revoke all on function private.comment_root_open(uuid, uuid) from public;
grant execute on function private.comment_root_open(uuid, uuid) to authenticated, crm_agent;

drop policy if exists page_comments_member on crm.page_comments;
create policy page_comments_member on crm.page_comments
  for select to authenticated
  using (exists (select 1 from crm.pages p where p.id = page_comments.page_id and p.workspace_id = page_comments.workspace_id));

drop policy if exists page_comments_agent on crm.page_comments;
create policy page_comments_agent on crm.page_comments
  for select to crm_agent
  using (exists (select 1 from crm.pages p where p.id = page_comments.page_id and p.workspace_id = page_comments.workspace_id));

drop policy if exists page_comments_member_reply on crm.page_comments;
create policy page_comments_member_reply on crm.page_comments
  for insert to authenticated
  with check (
    parent_id is not null
    and anchor is null
    and visitor_key_hash is null
    and author_agent_id is null
    and author_user_id = (select private.session_user_id())
    and exists (select 1 from crm.pages p where p.id = page_comments.page_id and p.workspace_id = page_comments.workspace_id and p.kind = 'note')
    and (select private.comment_root_open(page_comments.parent_id, page_comments.page_id))
  );

drop policy if exists page_comments_agent_reply on crm.page_comments;
create policy page_comments_agent_reply on crm.page_comments
  for insert to crm_agent
  with check (
    parent_id is not null
    and anchor is null
    and visitor_key_hash is null
    and author_user_id is null
    and author_agent_id = nullif(current_setting('app.agent_id', true), '')::uuid
    and exists (select 1 from crm.pages p where p.id = page_comments.page_id and p.workspace_id = page_comments.workspace_id and p.kind = 'note')
    and (select private.comment_root_open(page_comments.parent_id, page_comments.page_id))
  );

drop policy if exists page_comments_member_update on crm.page_comments;
create policy page_comments_member_update on crm.page_comments
  for update to authenticated
  using (
    deleted_at is null
    and exists (select 1 from crm.pages p where p.id = page_comments.page_id and p.workspace_id = page_comments.workspace_id)
  )
  with check (
    (resolved_by is null or resolved_by = (select private.session_user_id()))
    and (parent_id is null or resolved_at is null)
    and exists (select 1 from crm.pages p where p.id = page_comments.page_id and p.workspace_id = page_comments.workspace_id)
  );

drop policy if exists page_comments_agent_update on crm.page_comments;
create policy page_comments_agent_update on crm.page_comments
  for update to crm_agent
  using (
    deleted_at is null
    and exists (select 1 from crm.pages p where p.id = page_comments.page_id and p.workspace_id = page_comments.workspace_id)
  )
  with check (
    resolved_by is null
    and (parent_id is null or resolved_at is null)
    and exists (select 1 from crm.pages p where p.id = page_comments.page_id and p.workspace_id = page_comments.workspace_id)
  );

create or replace function private.comment_alert_target(p_comment uuid)
returns table (page_id uuid, title text, workspace_id uuid, workspace_name text, user_id uuid, role text, email text, full_name text, author_name text, body text, is_reply boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, p.workspace_id, w.name, m.user_id, m.role, pr.email, pr.full_name, c.author_name, c.body, c.parent_id is not null
  from crm.page_comments c
  join crm.pages p on p.id = c.page_id
  join crm.workspaces w on w.id = p.workspace_id
  cross join lateral (
    select member.user_id, member.role
    from crm.workspace_members member
    where member.workspace_id = p.workspace_id
      and (member.user_id = p.user_id or member.role = 'owner')
    order by coalesce(member.user_id = p.user_id, false) desc, member.created_at, member.user_id
    limit 1
  ) m
  join crm.profiles pr on pr.id = m.user_id
  where c.id = p_comment
    and c.deleted_at is null
    and c.visitor_key_hash is not null
    and p.kind = 'note';
$$;

revoke all on function private.comment_alert_target(uuid) from public;
grant execute on function private.comment_alert_target(uuid) to crm_app;

reset lock_timeout;
