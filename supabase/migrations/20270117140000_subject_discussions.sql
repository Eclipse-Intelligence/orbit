set lock_timeout = '5s';

create or replace function private.chat_subject_open_to(p_conversation uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from crm.chat_conversations c
    join crm.tasks t on t.id = c.task_id
    join crm.workspace_members wm on wm.workspace_id = t.workspace_id and wm.user_id = p_user
    where c.id = p_conversation and c.kind = 'task'
      and (
        t.owner_id = p_user
        or t.created_by_user_id = p_user
        or wm.role in ('owner', 'admin')
        or exists (select 1 from crm.task_participants tp where tp.task_id = t.id and tp.user_id = p_user)
      )
  ) or exists (
    select 1
    from crm.chat_conversations c
    join crm.pages p on p.id = c.page_id
    join crm.workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = p_user
    where c.id = p_conversation and c.kind = 'doc' and p.effective_shared and p.kind = 'note'
  )
$$;

revoke all on function private.chat_subject_open_to(uuid, uuid) from public;

create or replace function private.chat_subject_followers(p_user uuid, p_root uuid)
returns table (user_id uuid, last_read_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.user_id, t.last_read_at
  from crm.chat_messages r
  join crm.chat_conversations c on c.id = r.conversation_id and c.kind in ('task', 'doc')
  join crm.chat_thread_reads t on t.message_id = r.id
  where r.id = p_root and r.parent_id is null
    and private.chat_subject_open_to(c.id, p_user)
    and private.chat_subject_open_to(c.id, t.user_id)
$$;

revoke all on function private.chat_subject_followers(uuid, uuid) from public;
grant execute on function private.chat_subject_followers(uuid, uuid) to crm_app;

drop policy if exists chat_conversations_insert_subject on crm.chat_conversations;
create policy chat_conversations_insert_subject on crm.chat_conversations
  for insert to authenticated
  with check (
    created_by = (select private.session_user_id())
    and workspace_id is null
    and name is null
    and dm_key is null
    and archived_at is null
    and (
      (kind = 'task' and page_id is null and exists (select 1 from crm.tasks t where t.id = chat_conversations.task_id))
      or (kind = 'doc' and task_id is null and exists (
        select 1 from crm.pages p where p.id = chat_conversations.page_id and p.effective_shared and p.kind = 'note'
      ))
    )
  );

grant insert (kind, task_id, page_id, created_by) on crm.chat_conversations to authenticated;

reset lock_timeout;
