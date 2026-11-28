set lock_timeout = '3s';

do $$
begin
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'Run this as a role that bypasses row-level security: the comment functions read crm.pages and crm.page_comments.';
  end if;
end;
$$;

drop function if exists private.public_comments_list(text, text);
drop function if exists private.public_comment_add(text, text, text, text, uuid, jsonb);
drop function if exists private.public_comment_edit(text, text, uuid, text);

create function private.public_comments_list(p_value text, p_key_hash text)
returns table (id uuid, parent_id uuid, author_name text, body text, anchor jsonb, created_at timestamptz, edited_at timestamptz, resolved boolean, mine boolean, author_kind text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.parent_id, c.author_name, c.body, c.anchor, c.created_at, c.edited_at,
    coalesce(r.resolved_at, c.resolved_at) is not null,
    p_key_hash is not null and c.visitor_key_hash is not null and c.visitor_key_hash = p_key_hash,
    case when c.author_user_id is not null or c.author_agent_id is not null then 'team' else 'visitor' end
  from private.public_comment_page(p_value) pg
  join crm.page_comments c on c.page_id = pg.page_id and c.deleted_at is null
  left join crm.page_comments r on r.id = c.parent_id
  where c.parent_id is null or r.deleted_at is null
  order by c.created_at, c.id;
$$;

revoke all on function private.public_comments_list(text, text) from public;
grant execute on function private.public_comments_list(text, text) to crm_app;

create function private.public_comment_add(p_value text, p_key_hash text, p_name text, p_body text, p_parent uuid, p_anchor jsonb)
returns table (id uuid, parent_id uuid, author_name text, body text, anchor jsonb, created_at timestamptz, edited_at timestamptz, resolved boolean, mine boolean, author_kind text)
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
    select c.id, c.parent_id, c.author_name, c.body, c.anchor, c.created_at, c.edited_at, false, true, 'visitor'::text
    from crm.page_comments c
    where c.id = v_id;
end;
$$;

revoke all on function private.public_comment_add(text, text, text, text, uuid, jsonb) from public;
grant execute on function private.public_comment_add(text, text, text, text, uuid, jsonb) to crm_app;

create function private.public_comment_edit(p_value text, p_key_hash text, p_id uuid, p_body text)
returns table (id uuid, parent_id uuid, author_name text, body text, anchor jsonb, created_at timestamptz, edited_at timestamptz, resolved boolean, mine boolean, author_kind text)
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
      true,
      'visitor'::text
    from changed c;
end;
$$;

revoke all on function private.public_comment_edit(text, text, uuid, text) from public;
grant execute on function private.public_comment_edit(text, text, uuid, text) to crm_app;

reset lock_timeout;
