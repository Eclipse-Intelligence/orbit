create or replace function private.agent_mailbox_poll_targets()
returns table (mailbox_id uuid, workspace_id uuid, address text, set_up_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select b.id, b.workspace_id, b.address, b.set_up_at
  from crm.agent_mailboxes b
  where b.webhook_secret is not null and b.set_up_at is not null;
end;
$$;

create or replace function private.agent_mail_known(p_mailbox uuid, p_ids text[])
returns table (message_id text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select m.message_id
  from crm.agent_mail_messages m
  where m.mailbox_id = p_mailbox and m.message_id = any (coalesce(p_ids[1:500], '{}'));
end;
$$;

revoke all on function private.agent_mailbox_poll_targets() from public;
revoke all on function private.agent_mail_known(uuid, text[]) from public;
grant execute on function private.agent_mailbox_poll_targets() to crm_app;
grant execute on function private.agent_mail_known(uuid, text[]) to crm_app;
