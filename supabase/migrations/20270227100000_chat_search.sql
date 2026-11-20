set lock_timeout = '5s';

create or replace function private.chat_search_all(p_user uuid, p_text text, p_filters jsonb, p_limit integer, p_cursor jsonb)
returns table (
  id uuid,
  conversation_id uuid,
  parent_id uuid,
  created_at timestamptz,
  created_key text,
  author_user_id uuid,
  author_name text,
  body text,
  format text,
  conversation_kind text,
  conversation_name text,
  workspace_name text,
  archived boolean,
  subject_id uuid,
  subject_title text,
  files jsonb
)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_text text := left(btrim(coalesce(p_text, '')), 200);
  v_pattern text;
  v_in uuid := nullif(p_filters->>'in', '')::uuid;
  v_from uuid := nullif(p_filters->>'from', '')::uuid;
  v_has_file boolean := coalesce((p_filters->>'has_file')::boolean, false);
  v_before timestamptz := nullif(p_filters->>'before', '')::timestamptz;
  v_after timestamptz := nullif(p_filters->>'after', '')::timestamptz;
  v_agent boolean := coalesce((p_filters->>'agent')::boolean, false);
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 100));
  v_cursor_at timestamptz := nullif(p_cursor->>'t', '')::timestamptz;
  v_cursor_id uuid := nullif(p_cursor->>'id', '')::uuid;
begin
  if p_user is null or char_length(v_text) < 3 then
    return;
  end if;
  v_pattern := '%' || regexp_replace(v_text, '([\\%_])', '\\\1', 'g') || '%';
  return query
    with hits as materialized (
      select m.id, m.conversation_id, m.created_at
      from crm.chat_messages m
      where m.deleted_at is null
        and m.kind = 'message'
        and m.body ilike v_pattern
        and (v_in is null or m.conversation_id = v_in)
        and (v_from is null or m.author_user_id = v_from)
        and (not v_has_file or m.attachment_count > 0)
        and (v_before is null or m.created_at < v_before)
        and (v_after is null or m.created_at > v_after)
        and (v_cursor_at is null or v_cursor_id is null or (m.created_at, m.id) < (v_cursor_at, v_cursor_id))
      union all
      select m.id, m.conversation_id, m.created_at
      from crm.chat_messages m
      where m.id = any (array(select a.message_id from crm.chat_attachments a where a.name ilike v_pattern and a.message_id is not null))
        and not (m.body ilike v_pattern)
        and m.deleted_at is null
        and m.kind = 'message'
        and (v_in is null or m.conversation_id = v_in)
        and (v_from is null or m.author_user_id = v_from)
        and (v_before is null or m.created_at < v_before)
        and (v_after is null or m.created_at > v_after)
        and (v_cursor_at is null or v_cursor_id is null or (m.created_at, m.id) < (v_cursor_at, v_cursor_id))
    ),
    matched as materialized (
      select distinct h.conversation_id from hits h
    ),
    open as materialized (
      select c.id
      from matched x
      join crm.chat_conversations c on c.id = x.conversation_id
      where (
          c.kind in ('room', 'dm')
          and (not v_agent or c.archived_at is null)
          and exists (select 1 from crm.chat_members me where me.conversation_id = c.id and me.user_id = p_user)
        )
        or (not v_agent and c.kind in ('task', 'doc', 'mail_thread') and private.chat_subject_open_to(c.id, p_user))
    ),
    top as (
      select h.id, h.created_at
      from hits h
      where h.conversation_id in (select o.id from open o)
      order by h.created_at desc, h.id desc
      limit v_limit
    )
    select
      m.id,
      m.conversation_id,
      m.parent_id,
      m.created_at,
      to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      m.author_user_id,
      m.author_name,
      m.body,
      m.format,
      c.kind,
      case c.kind
        when 'room' then c.name
        when 'dm' then coalesce(nullif(btrim(o.name), ''), nullif(btrim(op.full_name), ''), op.email)
      end,
      w.name,
      c.archived_at is not null,
      coalesce(c.task_id, c.page_id, c.mail_share_id),
      case c.kind
        when 'task' then (select t.title from crm.tasks t where t.id = c.task_id)
        when 'doc' then (select pg.title from crm.pages pg where pg.id = c.page_id)
        when 'mail_thread' then (select s.subject from private.mail_share_messages(c.mail_share_id) s order by s.received_at limit 1)
      end,
      case when m.attachment_count > 0 then coalesce((
        select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name) order by array_position(m.attachment_ids, f.id))
        from crm.chat_attachments f
        where f.message_id = m.id
      ), '[]'::jsonb) else '[]'::jsonb end
    from top t
    join crm.chat_messages m on m.id = t.id
    join crm.chat_conversations c on c.id = m.conversation_id
    left join crm.workspaces w on w.id = c.workspace_id
    left join lateral (
      select (case when split_part(c.dm_key, ':', 1) = p_user::text then split_part(c.dm_key, ':', 2) else split_part(c.dm_key, ':', 1) end)::uuid as id
      where c.kind = 'dm'
    ) partner on true
    left join crm.chat_members o on o.conversation_id = c.id and o.user_id = partner.id
    left join crm.profiles op on op.id = partner.id
    order by m.created_at desc, m.id desc;
end;
$$;

revoke all on function private.chat_search_all(uuid, text, jsonb, integer, jsonb) from public;
grant execute on function private.chat_search_all(uuid, text, jsonb, integer, jsonb) to crm_app;

reset lock_timeout;

create index concurrently if not exists chat_attachments_name_trgm_idx on crm.chat_attachments using gin (name gin_trgm_ops);
