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

create or replace function private.campaign_connection_webhooks(p_connection uuid, p_key_fingerprint text, p_state jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_state) is distinct from 'object' then
    raise exception 'Pick the webhooks to save.' using errcode = '22023';
  end if;
  update crm.campaign_connections c
  set details = jsonb_set(coalesce(c.details, '{}'::jsonb), '{webhooks}', p_state)
  where c.id = p_connection and c.key_fingerprint = p_key_fingerprint;
end;
$$;

create or replace function private.campaign_prospect_tags(p_workspace uuid, p_provider text, p_campaign text, p_linkedin text, p_patch jsonb, p_positive boolean)
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
  if coalesce(p_linkedin, '') = '' or coalesce(p_campaign, '') = '' or jsonb_typeof(p_patch) is distinct from 'object' then
    return 0;
  end if;
  update crm.campaign_prospects p
  set provider_state = p.provider_state || p_patch
        || case when p_positive and not (p.provider_state ? 'positiveAt') then jsonb_build_object('positiveAt', now()) else '{}'::jsonb end
  from crm.campaigns k
  where k.id = p.campaign_id
    and k.workspace_id = p_workspace
    and k.provider = p_provider
    and k.external_id = p_campaign
    and p.linkedin = p_linkedin;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.campaign_connection_webhooks(uuid, text, jsonb) from public;
revoke all on function private.campaign_prospect_tags(uuid, text, text, text, jsonb, boolean) from public;
grant execute on function private.campaign_connection_webhooks(uuid, text, jsonb) to crm_app;
grant execute on function private.campaign_prospect_tags(uuid, text, text, text, jsonb, boolean) to crm_app;

reset lock_timeout;
