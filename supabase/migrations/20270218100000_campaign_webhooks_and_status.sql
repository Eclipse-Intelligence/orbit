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

create or replace function private.campaign_sync_campaigns(p_workspace uuid, p_provider text, p_channel text, p_items jsonb)
returns table (
  id uuid,
  external_id text,
  name text,
  status text,
  backfilled_at timestamptz,
  synced_at timestamptz,
  sync_state jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from crm.campaign_connections c where c.workspace_id = p_workspace and c.provider = p_provider) then
    return;
  end if;
  with items as (
    select distinct on (left(x.external_id, 200)) left(x.external_id, 200) as external_id, left(coalesce(x.name, ''), 500) as name, nullif(x.status, '') as status
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(external_id text, name text, status text)
    where coalesce(x.external_id, '') <> ''
    order by left(x.external_id, 200)
  )
  insert into crm.campaigns as k (workspace_id, provider, channel, external_id, name, status)
  select p_workspace, p_provider, p_channel, i.external_id, i.name, coalesce(i.status, 'drafted')
  from items i
  on conflict on constraint campaigns_external do update
  set name = excluded.name,
      status = coalesce((select i.status from items i where i.external_id = excluded.external_id), k.status)
  where (k.name, k.status) is distinct from (excluded.name, coalesce((select i.status from items i where i.external_id = excluded.external_id), k.status));

  return query
  select k.id, k.external_id, k.name, k.status, k.backfilled_at, k.synced_at, k.sync_state
  from crm.campaigns k
  where k.workspace_id = p_workspace and k.provider = p_provider
  order by (k.backfilled_at is not null), k.synced_at nulls first, k.created_at;
end;
$$;

revoke all on function private.campaign_sync_campaigns(uuid, text, text, jsonb) from public;
grant execute on function private.campaign_sync_campaigns(uuid, text, text, jsonb) to crm_app;

revoke all on function private.campaign_forget_webhooks(uuid, text) from public;
grant execute on function private.campaign_forget_webhooks(uuid, text) to crm_app;

reset lock_timeout;
