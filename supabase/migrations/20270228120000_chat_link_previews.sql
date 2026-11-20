set lock_timeout = '5s';

create table if not exists crm.chat_link_previews (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references crm.chat_messages (id) on delete cascade,
  url text not null,
  position smallint not null default 0,
  title text,
  description text,
  site text,
  image_url text,
  hidden boolean not null default false,
  fetched_at timestamptz not null default now(),
  constraint chat_link_previews_message_url unique (message_id, url),
  constraint chat_link_previews_position_check check (position between 0 and 1),
  constraint chat_link_previews_url_check check (char_length(url) between 1 and 2048),
  constraint chat_link_previews_title_check check (title is null or char_length(title) <= 300),
  constraint chat_link_previews_description_check check (description is null or char_length(description) <= 600),
  constraint chat_link_previews_site_check check (site is null or char_length(site) <= 120),
  constraint chat_link_previews_image_check check (image_url is null or char_length(image_url) <= 2048),
  constraint chat_link_previews_content_check check (hidden or title is not null or description is not null)
);

alter table crm.chat_link_previews enable row level security;
alter table crm.chat_link_previews force row level security;

drop policy if exists chat_link_previews_select on crm.chat_link_previews;
create policy chat_link_previews_select on crm.chat_link_previews
  for select to authenticated
  using (
    not hidden
    and exists (select 1 from crm.chat_messages m where m.id = chat_link_previews.message_id and m.deleted_at is null)
  );

revoke all on crm.chat_link_previews from anon, authenticated, crm_agent;
grant select on crm.chat_link_previews to authenticated;

create or replace function private.chat_preview_source(p_message uuid)
returns table (conversation_id uuid, parent_id uuid, body text, format text, eligible boolean, known text[])
language sql
stable
security definer
set search_path = ''
as $$
  select
    m.conversation_id,
    m.parent_id,
    m.body,
    m.format,
    m.author_user_id is not null
      and m.kind = 'message'
      and m.deleted_at is null
      and m.hook is null
      and m.via_hook_id is null
      and m.via_workflow_id is null,
    coalesce((select array_agg(p.url order by p.position) from crm.chat_link_previews p where p.message_id = m.id), '{}')
  from crm.chat_messages m
  where m.id = p_message
$$;

revoke all on function private.chat_preview_source(uuid) from public;
grant execute on function private.chat_preview_source(uuid) to crm_app;

create or replace function private.chat_store_link_previews(p_message uuid, p_body text, p_format text, p_wanted text[], p_previews jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message crm.chat_messages;
  v_changed boolean := false;
  v_count integer;
  v_wanted text[] := coalesce(p_wanted, '{}');
begin
  if cardinality(v_wanted) > 2 then
    raise exception 'A message shows up to 2 link previews.' using errcode = '22023';
  end if;
  select m.* into v_message from crm.chat_messages m where m.id = p_message for share;
  if not found
    or v_message.author_user_id is null
    or v_message.kind <> 'message'
    or v_message.deleted_at is not null
    or v_message.hook is not null
    or v_message.via_hook_id is not null
    or v_message.via_workflow_id is not null
    or v_message.body is distinct from p_body
    or v_message.format is distinct from p_format then
    return false;
  end if;

  delete from crm.chat_link_previews p where p.message_id = p_message and not (p.url = any(v_wanted));
  get diagnostics v_count = row_count;
  v_changed := v_count > 0;

  if jsonb_typeof(p_previews) = 'array' and jsonb_array_length(p_previews) > 0 then
    insert into crm.chat_link_previews (message_id, url, position, title, description, site, image_url)
      select p_message, f.url, (array_position(v_wanted, f.url) - 1)::smallint, f.title, f.description, f.site, f.image_url
      from jsonb_to_recordset(p_previews) as f(url text, title text, description text, site text, image_url text)
      where f.url = any(v_wanted) and (f.title is not null or f.description is not null)
      on conflict (message_id, url) do nothing;
    get diagnostics v_count = row_count;
    v_changed := v_changed or v_count > 0;
  end if;

  update crm.chat_link_previews p
    set position = (array_position(v_wanted, p.url) - 1)::smallint
    where p.message_id = p_message and p.position <> (array_position(v_wanted, p.url) - 1);
  return v_changed;
end;
$$;

revoke all on function private.chat_store_link_previews(uuid, text, text, text[], jsonb) from public;
grant execute on function private.chat_store_link_previews(uuid, text, text, text[], jsonb) to crm_app;

create or replace function private.chat_hide_link_preview(p_user uuid, p_preview uuid)
returns table (message_id uuid, conversation_id uuid, parent_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message crm.chat_messages;
  v_preview crm.chat_link_previews;
begin
  select p.* into v_preview from crm.chat_link_previews p where p.id = p_preview and not p.hidden for update;
  if not found then
    raise exception 'Preview not found.' using errcode = 'P0002';
  end if;
  select m.* into v_message from crm.chat_messages m where m.id = v_preview.message_id;
  if not found
    or v_message.deleted_at is not null
    or v_message.author_user_id is distinct from p_user
    or not private.chat_attachment_open_to(v_message.conversation_id, p_user) then
    raise exception 'Preview not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from crm.chat_conversations c where c.id = v_message.conversation_id and c.archived_at is not null) then
    raise exception 'This room is archived.' using errcode = '22023';
  end if;
  update crm.chat_link_previews p
    set hidden = true, title = null, description = null, site = null, image_url = null
    where p.id = p_preview;
  return query select v_message.id, v_message.conversation_id, v_message.parent_id;
end;
$$;

revoke all on function private.chat_hide_link_preview(uuid, uuid) from public;
grant execute on function private.chat_hide_link_preview(uuid, uuid) to crm_app;

create or replace function private.chat_link_previews_forget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from crm.chat_link_previews p where p.message_id = new.id;
  return null;
end;
$$;

revoke all on function private.chat_link_previews_forget() from public;

drop trigger if exists chat_messages_link_previews_forget on crm.chat_messages;
create trigger chat_messages_link_previews_forget
  after update of deleted_at on crm.chat_messages
  for each row
  when (new.deleted_at is not null and old.deleted_at is null)
  execute function private.chat_link_previews_forget();

reset lock_timeout;
