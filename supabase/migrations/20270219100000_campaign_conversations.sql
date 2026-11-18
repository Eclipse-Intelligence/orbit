set lock_timeout = '5s';

alter table crm.campaign_prospects add column if not exists conversation_read_at timestamptz;

create or replace function private.campaign_conversation_read(p_workspace uuid, p_user uuid, p_prospects uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from crm.workspace_members w where w.workspace_id = p_workspace and w.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set conversation_read_at = now()
  where p.workspace_id = p_workspace
    and p.id = any(coalesce(p_prospects, '{}'::uuid[]))
    and exists (
      select 1 from crm.campaign_messages m
      where m.prospect_id = p.id
        and m.direction = 'inbound'
        and not m.automatic
        and m.created_at > coalesce(p.conversation_read_at, '-infinity'::timestamptz)
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.campaign_conversation_read(uuid, uuid, uuid[]) from public;
grant execute on function private.campaign_conversation_read(uuid, uuid, uuid[]) to crm_app;

reset lock_timeout;

create index concurrently if not exists campaign_messages_workspace_idx on crm.campaign_messages (workspace_id, prospect_id, sent_at);
