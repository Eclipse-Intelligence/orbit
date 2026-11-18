set lock_timeout = '5s';

alter table crm.campaigns add column if not exists auto_add text not null default 'off';
alter table crm.campaigns drop constraint if exists campaigns_auto_add;
alter table crm.campaigns
  add constraint campaigns_auto_add check (auto_add in ('off', 'accepted', 'replied')) not valid;
alter table crm.campaigns validate constraint campaigns_auto_add;

alter table crm.campaign_events drop constraint if exists campaign_events_kind;
alter table crm.campaign_events
  add constraint campaign_events_kind check (kind in (
    'added', 'sent', 'opened', 'clicked', 'engaged', 'replied', 'bounced', 'unsubscribed', 'category',
    'invite_sent', 'invite_accepted', 'message_sent', 'inmail_sent',
    'profile_viewed', 'post_liked', 'followed', 'finished'
  )) not valid;
alter table crm.campaign_events validate constraint campaign_events_kind;

drop policy if exists campaigns_update_member on crm.campaigns;
create policy campaigns_update_member on crm.campaigns
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

grant update (auto_add) on crm.campaigns to authenticated;

create or replace function private.campaign_person_lock(p_campaign uuid, p_linkedin text, p_email text, p_lead text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person text := coalesce(nullif(p_linkedin, ''), nullif(p_email, ''), nullif(p_lead, ''));
begin
  if v_person is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('campaign-person:' || p_campaign::text || ':' || v_person, 0));
end;
$$;

create or replace function private.campaign_person_replied(p_prospect uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from crm.campaign_prospects p
    left join crm.contacts c on c.id = p.contact_id
    join crm.campaign_prospects o on o.workspace_id = p.workspace_id
    where p.id = p_prospect
      and (o.replied_at is not null or exists (select 1 from crm.campaign_events e where e.prospect_id = o.id and e.kind = 'replied'))
      and (
        o.id = p.id
        or (p.contact_id is not null and o.contact_id = p.contact_id)
        or (coalesce(c.normalized_email, p.email) is not null and o.email = coalesce(c.normalized_email, p.email))
        or (coalesce(c.normalized_linkedin, p.linkedin) is not null and o.linkedin = coalesce(c.normalized_linkedin, p.linkedin))
      )
  );
$$;

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
      left(nullif(x.sender_id, ''), 200) as sender_id
    from jsonb_to_recordset(coalesce(p_leads, '[]'::jsonb))
      as x(external_id text, email text, linkedin text, lead jsonb, lead_status text, category text, added_at timestamptz, sender_id text)
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
        workspace_id, campaign_id, email, linkedin, lead, state, external_lead_id, lead_status, category, pushed_at, sender_id
      ) values (
        v_campaign.workspace_id, p_campaign, v_lead.email, v_lead.linkedin, v_lead.lead, 'pushed',
        v_lead.external_id, v_lead.lead_status, v_lead.category, coalesce(v_lead.added_at, now()), v_lead.sender_id
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
          sender_id = coalesce(p.sender_id, v_lead.sender_id)
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



create or replace function private.campaign_sync_events(p_campaign uuid, p_events jsonb, p_handled boolean)
returns table (event_id uuid, prospect_id uuid, contact_id uuid, kind text, occurred_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign crm.campaigns%rowtype;
  v_event record;
  v_prospect uuid;
  v_contact uuid;
  v_category text;
  v_inserted uuid;
  v_key text;
  v_step integer;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_campaign from crm.campaigns k where k.id = p_campaign;
  if not found then
    return;
  end if;
  for v_event in
    select left(nullif(x.external_lead_id, ''), 200) as external_lead_id,
      case when char_length(coalesce(x.email, '')) between 3 and 320 then x.email end as email,
      left(nullif(x.linkedin, ''), 500) as linkedin,
      coalesce(x.lead, '{}'::jsonb) as lead,
      x.kind,
      x.step,
      left(nullif(x.variant, ''), 100) as variant,
      x.occurred_at,
      left(x.dedupe_key, 500) as dedupe_key,
      left(nullif(x.category, ''), 200) as category,
      coalesce(x.payload, '{}'::jsonb) as payload
    from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb))
      as x(external_lead_id text, email text, linkedin text, lead jsonb, kind text, step integer, variant text,
           occurred_at timestamptz, dedupe_key text, category text, payload jsonb)
    where x.occurred_at is not null and coalesce(x.dedupe_key, '') <> ''
    order by x.occurred_at
  loop
    if exists (select 1 from crm.campaign_event_tombstones t where t.campaign_id = p_campaign and t.dedupe_key = v_event.dedupe_key) then
      continue;
    end if;
    perform private.campaign_person_lock(p_campaign, v_event.linkedin, v_event.email, v_event.external_lead_id);
    v_prospect := null;
    v_category := null;
    if v_event.external_lead_id is not null then
      select p.id, p.contact_id, p.category into v_prospect, v_contact, v_category from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.external_lead_id = v_event.external_lead_id;
    end if;
    if v_prospect is null and v_event.email is not null then
      select p.id, p.contact_id, p.category into v_prospect, v_contact, v_category from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.email = v_event.email
      order by p.external_lead_id is null, p.created_at
      limit 1;
    end if;
    if v_prospect is null and v_event.linkedin is not null then
      select p.id, p.contact_id, p.category into v_prospect, v_contact, v_category from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.linkedin = v_event.linkedin
      order by p.external_lead_id is null, p.created_at
      limit 1;
    end if;
    if v_prospect is null then
      if v_event.email is null and v_event.linkedin is null and v_event.external_lead_id is null then
        continue;
      end if;
      insert into crm.campaign_prospects (
        workspace_id, campaign_id, email, linkedin, lead, state, external_lead_id, pushed_at
      ) values (
        v_campaign.workspace_id, p_campaign, v_event.email, v_event.linkedin, v_event.lead, 'pushed',
        v_event.external_lead_id, v_event.occurred_at
      )
      returning id into v_prospect;
      perform private.campaign_link_contacts(p_campaign, array[v_prospect]);
      select p.contact_id into v_contact from crm.campaign_prospects p where p.id = v_prospect;
    end if;

    if v_campaign.provider = 'heyreach' and v_event.kind = 'category' and v_category is not null then
      continue;
    end if;

    if v_event.kind in ('unsubscribed', 'bounced', 'invite_sent', 'invite_accepted', 'profile_viewed', 'post_liked', 'followed', 'finished') and exists (
      select 1 from crm.campaign_events x where x.prospect_id = v_prospect and x.kind = v_event.kind
    ) then
      continue;
    end if;

    v_key := v_event.dedupe_key;
    v_step := v_event.step;
    if v_event.kind in ('message_sent', 'inmail_sent') then
      if (v_event.payload ->> 'countSent') = 'true' then
        if exists (
          select 1 from crm.campaign_events x
          where x.prospect_id = v_prospect and x.kind = v_event.kind
            and x.occurred_at >= v_event.occurred_at - interval '10 minutes'
        ) then
          continue;
        end if;
        select count(*)::integer + 1 into v_step from crm.campaign_events x where x.prospect_id = v_prospect and x.kind = v_event.kind;
        v_key := left(v_event.dedupe_key, 480) || ':' || v_step::text;
      end if;
      if v_step is not null and exists (
        select 1 from crm.campaign_events x where x.prospect_id = v_prospect and x.kind = v_event.kind and x.step = v_step
      ) then
        continue;
      end if;
    end if;

    v_inserted := null;
    insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, step, variant, occurred_at, dedupe_key, payload, handled_at)
    values (v_campaign.workspace_id, p_campaign, v_prospect, v_event.kind, v_step, v_event.variant,
      v_event.occurred_at, v_key, v_event.payload - 'countSent', case when p_handled then now() end)
    on conflict on constraint campaign_events_dedupe do nothing
    returning e.id into v_inserted;

    update crm.campaign_prospects p
    set last_event_at = greatest(p.last_event_at, v_event.occurred_at),
        replied_at = case when v_event.kind = 'replied' then least(coalesce(p.replied_at, v_event.occurred_at), v_event.occurred_at) else p.replied_at end,
        category = case
          when v_inserted is null or v_event.kind <> 'category' then p.category
          when v_campaign.provider = 'heyreach' then coalesce(p.category, v_event.category)
          else coalesce(v_event.category, p.category)
        end
    where p.id = v_prospect
      and (
        p.last_event_at is distinct from greatest(p.last_event_at, v_event.occurred_at)
        or (v_event.kind = 'replied' and (p.replied_at is null or p.replied_at > v_event.occurred_at))
        or (v_inserted is not null and v_event.kind = 'category' and v_event.category is not null and v_campaign.provider <> 'heyreach' and p.category is distinct from v_event.category)
        or (v_inserted is not null and v_event.kind = 'category' and v_event.category is not null and v_campaign.provider = 'heyreach' and p.category is null)
      );

    if v_inserted is not null then
      event_id := v_inserted;
      prospect_id := v_prospect;
      contact_id := v_contact;
      kind := v_event.kind;
      occurred_at := v_event.occurred_at;
      return next;
    end if;
  end loop;
end;
$$;

create or replace function private.campaign_mark_finished(p_campaign uuid, p_handled boolean)
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
  with inserted as (
    insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key, payload, handled_at)
    select p.workspace_id, p.campaign_id, p.id, 'finished', now(), 'orbit:finished:' || p.id::text, '{}'::jsonb,
      case when p_handled then now() end
    from crm.campaign_prospects p
    where p.campaign_id = p_campaign
      and p.state = 'pushed'
      and p.lead_status = 'completed'
      and p.replied_at is null
      and p.stop_requested_at is null
      and p.stopped_at is null
      and not exists (
        select 1 from crm.campaign_events x where x.prospect_id = p.id and x.kind in ('replied', 'finished')
      )
      and not private.campaign_person_replied(p.id)
      and not exists (
        select 1 from crm.campaign_event_tombstones t where t.campaign_id = p.campaign_id and t.dedupe_key = 'orbit:finished:' || p.id::text
      )
    on conflict on constraint campaign_events_dedupe do nothing
    returning e.prospect_id
  ),
  touched as (
    update crm.campaign_prospects p
    set last_event_at = greatest(p.last_event_at, now())
    from inserted i
    where p.id = i.prospect_id
    returning p.id
  )
  select count(*)::integer into v_count from inserted;
  return v_count;
end;
$$;

create or replace function private.campaign_webhook_campaign(p_workspace uuid, p_provider text, p_external text)
returns table (campaign_id uuid, backfilled boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select k.id, k.backfilled_at is not null
  from crm.campaigns k
  where k.workspace_id = p_workspace and k.provider = p_provider and k.external_id = p_external;
end;
$$;

create or replace function private.campaign_fire_events(p_ids uuid[])
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
  with fired as (
    update crm.campaign_events e
    set fired_at = now()
    from crm.campaign_prospects p, crm.campaigns k
    where e.id = any(p_ids)
      and e.fired_at is null
      and e.kind in (
        'added', 'replied', 'category', 'engaged', 'bounced', 'unsubscribed', 'invite_accepted',
        'sent', 'invite_sent', 'message_sent', 'inmail_sent', 'profile_viewed', 'post_liked', 'followed', 'finished'
      )
      and p.id = e.prospect_id
      and k.id = e.campaign_id
    returning e.id, e.workspace_id, e.campaign_id, e.prospect_id, e.kind, e.step, e.occurred_at, e.payload,
      p.contact_id, k.name as campaign_name, k.channel, k.provider,
      coalesce(e.payload ->> 'category', case when e.kind = 'category' then null else p.category end) as category
  )
  insert into crm.workflow_events (
    workspace_id, trigger_types, event_type, entity_type, entity_id, data, actor_user_id, source_workflow_id, depth
  )
  select f.workspace_id,
    array['campaign_event'],
    'campaign.event',
    case when f.contact_id is not null then 'contact' else 'campaign_prospect' end,
    coalesce(f.contact_id, f.prospect_id),
    jsonb_strip_nulls(jsonb_build_object(
      'campaignEventId', f.id,
      'campaignId', f.campaign_id,
      'campaignName', f.campaign_name,
      'prospectId', f.prospect_id,
      'kind', f.kind,
      'channel', f.channel,
      'provider', f.provider,
      'category', f.category,
      'step', f.step,
      'occurredAt', f.occurred_at
    )),
    null,
    case when (f.payload ->> 'sourceWorkflowId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (f.payload ->> 'sourceWorkflowId')::uuid end,
    case when (f.payload ->> 'depth') ~ '^[0-9]{1,2}$' then (f.payload ->> 'depth')::integer else 0 end
  from fired f;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key, payload, handled_at, fired_at)
select p.workspace_id, p.campaign_id, p.id, 'finished', now(), 'orbit:finished:' || p.id::text, jsonb_build_object('seeded', true), now(), now()
from crm.campaign_prospects p
join crm.campaigns k on k.id = p.campaign_id
where k.backfilled_at is not null
  and p.state = 'pushed'
  and p.lead_status = 'completed'
  and p.replied_at is null
  and p.stop_requested_at is null
  and p.stopped_at is null
  and not exists (select 1 from crm.campaign_events x where x.prospect_id = p.id and x.kind in ('replied', 'finished'))
  and not private.campaign_person_replied(p.id)
on conflict on constraint campaign_events_dedupe do nothing;

revoke all on function private.campaign_person_lock(uuid, text, text, text) from public;
revoke all on function private.campaign_person_replied(uuid) from public;
revoke all on function private.campaign_sync_prospects(uuid, jsonb, boolean) from public;
grant execute on function private.campaign_sync_prospects(uuid, jsonb, boolean) to crm_app;
revoke all on function private.campaign_sync_events(uuid, jsonb, boolean) from public;
revoke all on function private.campaign_mark_finished(uuid, boolean) from public;
revoke all on function private.campaign_webhook_campaign(uuid, text, text) from public;
revoke all on function private.campaign_fire_events(uuid[]) from public;
grant execute on function private.campaign_sync_events(uuid, jsonb, boolean) to crm_app;
grant execute on function private.campaign_mark_finished(uuid, boolean) to crm_app;
grant execute on function private.campaign_webhook_campaign(uuid, text, text) to crm_app;
grant execute on function private.campaign_fire_events(uuid[]) to crm_app;

reset lock_timeout;

create index concurrently if not exists campaign_prospects_completed_idx on crm.campaign_prospects (campaign_id) where lead_status = 'completed' and replied_at is null;
