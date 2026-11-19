set lock_timeout = '5s';

create table if not exists crm.chat_reactions (
  message_id uuid not null references crm.chat_messages (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (message_id, user_id, emoji),
  constraint chat_reactions_emoji_check check (length(emoji) between 1 and 64)
);

create index if not exists chat_reactions_user_idx on crm.chat_reactions (user_id);

alter table crm.chat_reactions enable row level security;
alter table crm.chat_reactions force row level security;

drop policy if exists chat_reactions_select on crm.chat_reactions;
create policy chat_reactions_select on crm.chat_reactions
  for select to authenticated
  using (exists (select 1 from crm.chat_messages m where m.id = chat_reactions.message_id));

revoke all on crm.chat_reactions from anon, authenticated, crm_agent;
grant select on crm.chat_reactions to authenticated;

create or replace function private.chat_toggle_reaction(p_user uuid, p_message uuid, p_emoji text)
returns table (added boolean, conversation_id uuid, parent_id uuid, changed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message crm.chat_messages;
  v_conversation crm.chat_conversations;
  v_removed integer;
begin
  select m.* into v_message from crm.chat_messages m where m.id = p_message for no key update;
  if not found then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  select c.* into v_conversation from crm.chat_conversations c where c.id = v_message.conversation_id;
  if not found
    or (v_conversation.kind in ('room', 'dm') and not exists (
      select 1 from crm.chat_members cm where cm.conversation_id = v_conversation.id and cm.user_id = p_user
    ))
    or (v_conversation.kind not in ('room', 'dm') and not private.chat_subject_open_to(v_conversation.id, p_user)) then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  if v_conversation.archived_at is not null then
    raise exception 'This room is archived.' using errcode = '22023';
  end if;
  if v_message.deleted_at is not null then
    raise exception 'That message was deleted.' using errcode = '22023';
  end if;

  delete from crm.chat_reactions r where r.message_id = p_message and r.user_id = p_user and r.emoji = p_emoji;
  get diagnostics v_removed = row_count;
  if v_removed = 0 then
    if not exists (select 1 from crm.chat_reactions r where r.message_id = p_message and r.emoji = p_emoji)
      and (select count(distinct r.emoji) from crm.chat_reactions r where r.message_id = p_message) >= 20 then
      raise exception 'A message can have up to 20 different reactions.' using errcode = '22023';
    end if;
    insert into crm.chat_reactions (message_id, user_id, emoji) values (p_message, p_user, p_emoji);
  end if;

  return query select v_removed = 0, v_message.conversation_id, v_message.parent_id, clock_timestamp();
end;
$$;

revoke all on function private.chat_toggle_reaction(uuid, uuid, text) from public;
grant execute on function private.chat_toggle_reaction(uuid, uuid, text) to crm_app;

reset lock_timeout;
