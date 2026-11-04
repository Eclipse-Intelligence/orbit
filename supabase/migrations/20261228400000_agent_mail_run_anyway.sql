create or replace function private.agent_mail_run_anyway(p_id uuid, p_user uuid)
returns table (id uuid, workspace_id uuid, user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  update crm.agent_mail_messages m
  set user_id = p_user, status = 'received', status_reason = null, advancing_until = null
  where m.id = p_id
    and m.status = 'refused'
    and m.direction = 'inbound'
    and m.replied_at is null
    and exists (
      select 1
      from crm.agent_mailbox_senders s
      join crm.workspace_members w on w.workspace_id = s.workspace_id and w.user_id = s.user_id
      where s.workspace_id = m.workspace_id and s.address = lower(m.from_address) and s.user_id = p_user
    )
  returning m.id, m.workspace_id, m.user_id;
end;
$$;

revoke all on function private.agent_mail_run_anyway(uuid, uuid) from public;
grant execute on function private.agent_mail_run_anyway(uuid, uuid) to crm_app;
