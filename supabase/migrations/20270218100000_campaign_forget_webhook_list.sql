set lock_timeout = '5s';

create or replace function private.campaign_forget_webhooks(p_workspace uuid, p_provider text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaigns k
  set sync_state = k.sync_state - 'webhookId' - 'webhookFailedAt' - 'webhooks'
  where k.workspace_id = p_workspace and k.provider = p_provider
    and (k.sync_state ? 'webhookId' or k.sync_state ? 'webhookFailedAt' or k.sync_state ? 'webhooks');
end;
$$;

revoke all on function private.campaign_forget_webhooks(uuid, text) from public;
grant execute on function private.campaign_forget_webhooks(uuid, text) to crm_app;

reset lock_timeout;
