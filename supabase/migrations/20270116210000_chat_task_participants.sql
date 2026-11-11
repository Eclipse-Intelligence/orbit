create or replace function private.chat_follow(p_root uuid, p_users uuid[], p_read_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation crm.chat_conversations;
begin
  select c.* into v_conversation
    from crm.chat_messages m join crm.chat_conversations c on c.id = m.conversation_id
    where m.id = p_root;
  if v_conversation.id is null then
    return;
  end if;
  insert into crm.chat_thread_reads (message_id, user_id, last_read_at)
    select p_root, u.id, p_read_at
    from (select distinct x as id from unnest(p_users) as x where x is not null) u
    where case v_conversation.kind
      when 'task' then exists (
        select 1 from crm.tasks t
        join crm.workspace_members wm on wm.workspace_id = t.workspace_id and wm.user_id = u.id
        where t.id = v_conversation.task_id
          and (
            t.owner_id = u.id
            or t.created_by_user_id = u.id
            or wm.role in ('owner', 'admin')
            or exists (select 1 from crm.task_participants tp where tp.task_id = t.id and tp.user_id = u.id)
          )
      )
      when 'doc' then exists (
        select 1 from crm.pages p
        join crm.workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = u.id
        where p.id = v_conversation.page_id and p.effective_shared and p.kind = 'note'
      )
      else exists (select 1 from crm.chat_members cm where cm.conversation_id = v_conversation.id and cm.user_id = u.id)
    end
  on conflict (message_id, user_id) do nothing;
end;
$$;

revoke all on function private.chat_follow(uuid, uuid[], timestamptz) from public;
