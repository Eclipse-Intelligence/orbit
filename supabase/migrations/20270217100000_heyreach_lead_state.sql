set lock_timeout = '5s';

alter table crm.campaign_prospects add column if not exists provider_state jsonb not null default '{}'::jsonb;

create or replace function private.campaign_sync_prospects(p_campaign uuid, p_leads jsonb, p_handled boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign crm.campaigns%rowtype;
  v_lead record;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_revived uuid[] := '{}';
  v_row crm.campaign_prospects%rowtype;
  v_block text;
  v_old text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_campaign from crm.campaigns k where k.id = p_campaign;
  if not found then
    return 0;
  end if;
  for v_lead in
    select left(nullif(x.external_id, ''), 200) as external_id,
      case when char_length(coalesce(x.email, '')) between 3 and 320 then x.email end as email,
      left(nullif(x.linkedin, ''), 500) as linkedin,
      coalesce(x.lead, '{}'::jsonb) as lead,
      left(nullif(x.lead_status, ''), 100) as lead_status,
      left(nullif(x.category, ''), 200) as category,
      x.added_at,
      left(nullif(x.sender_id, ''), 200) as sender_id,
      case when jsonb_typeof(x.provider_state) = 'object' then jsonb_strip_nulls(x.provider_state) else '{}'::jsonb end as provider_state
    from jsonb_to_recordset(coalesce(p_leads, '[]'::jsonb))
      as x(external_id text, email text, linkedin text, lead jsonb, lead_status text, category text, added_at timestamptz, sender_id text, provider_state jsonb)
  loop
    perform private.campaign_person_lock(p_campaign, v_lead.linkedin, v_lead.email, v_lead.external_id);
    v_id := null;
    if v_lead.external_id is not null then
      select p.id into v_id from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.external_lead_id = v_lead.external_id;
    end if;
    if v_id is null and v_lead.email is not null then
      select p.id into v_id from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.email = v_lead.email
        and (p.external_lead_id is null or v_lead.external_id is null)
      order by (p.state in ('skipped', 'failed')), p.created_at
      limit 1;
    end if;
    if v_id is null and v_lead.linkedin is not null then
      select p.id into v_id from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.linkedin = v_lead.linkedin
        and (p.external_lead_id is null or v_lead.external_id is null)
      order by (p.state in ('skipped', 'failed')), p.created_at
      limit 1;
    end if;
    if v_id is null then
      insert into crm.campaign_prospects (
        workspace_id, campaign_id, email, linkedin, lead, state, external_lead_id, lead_status, category, pushed_at, sender_id, provider_state
      ) values (
        v_campaign.workspace_id, p_campaign, v_lead.email, v_lead.linkedin, v_lead.lead, 'pushed',
        v_lead.external_id, v_lead.lead_status, v_lead.category, coalesce(v_lead.added_at, now()), v_lead.sender_id, v_lead.provider_state
      )
      returning id into v_id;
    else
      select p.state into v_old from crm.campaign_prospects p where p.id = v_id;
      update crm.campaign_prospects p
      set import_error = case
            when (v_lead.email is not null and v_lead.email is distinct from p.email)
              or (v_lead.linkedin is not null and v_lead.linkedin is distinct from p.linkedin)
              or (p.lead || v_lead.lead) is distinct from p.lead
            then null
            else p.import_error
          end,
          state = case when p.state in ('skipped', 'failed') and v_lead.external_id is not null then 'pushed' else p.state end,
          claimed_at = case when p.state in ('skipped', 'failed') and v_lead.external_id is not null then null else p.claimed_at end,
          claimed_by = case when p.state in ('skipped', 'failed') and v_lead.external_id is not null then null else p.claimed_by end,
          external_lead_id = coalesce(p.external_lead_id, v_lead.external_id),
          email = coalesce(p.email, v_lead.email),
          linkedin = coalesce(p.linkedin, v_lead.linkedin),
          lead = p.lead || v_lead.lead,
          lead_status = coalesce(v_lead.lead_status, p.lead_status),
          pushed_at = coalesce(p.pushed_at, v_lead.added_at, case when p.state in ('skipped', 'failed') and v_lead.external_id is not null then now() end),
          sender_id = coalesce(p.sender_id, v_lead.sender_id),
          provider_state = p.provider_state || v_lead.provider_state
      where p.id = v_id;
      if v_old in ('skipped', 'failed') and v_lead.external_id is not null then
        v_revived := v_revived || v_id;
      end if;
    end if;
    v_ids := v_ids || v_id;
    if v_lead.lead_status in ('unsubscribed', 'bounced') then
      perform private.campaign_status_event(v_id, v_lead.lead_status, p_handled);
    end if;
  end loop;
  perform private.campaign_link_contacts(p_campaign, v_ids);
  for v_row in
    select p.* from crm.campaign_prospects p
    where p.id = any(v_revived) and p.state = 'pushed' and p.stop_requested_at is null and p.stopped_at is null
  loop
    if v_row.skip_reason = 'Removed' then
      update crm.campaign_prospects p set stop_requested_at = now(), stop_reason = 'removed' where p.id = v_row.id;
      continue;
    end if;
    v_block := private.campaign_person_block(
      v_row.workspace_id, v_campaign.channel, p_campaign, v_row.id, v_row.contact_id, v_row.email, v_row.linkedin, false
    );
    if v_block in ('Do not contact', 'Already replied') then
      update crm.campaign_prospects p
      set stop_requested_at = now(), stop_reason = case when v_block = 'Do not contact' then 'suppressed' else 'replied' end
      where p.id = v_row.id;
    end if;
  end loop;
  return coalesce(cardinality(v_ids), 0);
end;
$$;
revoke all on function private.campaign_sync_prospects(uuid, jsonb, boolean) from public;
grant execute on function private.campaign_sync_prospects(uuid, jsonb, boolean) to crm_app;

reset lock_timeout;
