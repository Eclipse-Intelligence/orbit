set lock_timeout = '5s';

create table if not exists crm.campaign_senders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  provider text not null,
  external_id text not null,
  name text not null default '',
  email text,
  linkedin text,
  user_id uuid references crm.profiles (id) on delete set null,
  invite_limit integer,
  message_limit integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_senders_provider check (provider in ('heyreach')),
  constraint campaign_senders_external unique (workspace_id, provider, external_id),
  constraint campaign_senders_external_id_length check (char_length(external_id) between 1 and 200),
  constraint campaign_senders_text_lengths check (
    char_length(name) <= 300
    and (email is null or char_length(email) <= 320)
    and (linkedin is null or char_length(linkedin) <= 500)
  ),
  constraint campaign_senders_limits check (
    (invite_limit is null or invite_limit >= 0) and (message_limit is null or message_limit >= 0)
  )
);

create index if not exists campaign_senders_user_idx on crm.campaign_senders (workspace_id, user_id) where user_id is not null;

alter table crm.campaigns add column if not exists day_stats jsonb not null default '[]'::jsonb;

drop trigger if exists campaign_senders_set_updated_at on crm.campaign_senders;
create trigger campaign_senders_set_updated_at
  before update on crm.campaign_senders
  for each row execute function private.set_updated_at();

alter table crm.campaign_senders enable row level security;
alter table crm.campaign_senders force row level security;

drop policy if exists campaign_senders_select_member on crm.campaign_senders;
create policy campaign_senders_select_member on crm.campaign_senders
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists campaign_senders_update_admin on crm.campaign_senders;
create policy campaign_senders_update_admin on crm.campaign_senders
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id))
  with check (
    workspace_id in (select private.user_workspace_ids())
    and private.is_workspace_admin(workspace_id)
    and (
      user_id is null
      or exists (select 1 from crm.workspace_members m where m.workspace_id = campaign_senders.workspace_id and m.user_id = campaign_senders.user_id)
    )
  );
drop policy if exists campaign_senders_select_agent on crm.campaign_senders;
create policy campaign_senders_select_agent on crm.campaign_senders
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));

revoke all on crm.campaign_senders from anon, authenticated, crm_agent;
grant select on crm.campaign_senders to authenticated, crm_agent;
grant update (user_id) on crm.campaign_senders to authenticated;

create or replace function private.campaign_sync_senders(p_workspace uuid, p_provider text, p_items jsonb)
returns table (sender_id uuid, user_id uuid, name text, external_id text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from crm.campaign_connections c where c.workspace_id = p_workspace and c.provider = p_provider) then
    return;
  end if;
  return query
  with items as (
    select distinct on (left(x.external_id, 200))
      left(x.external_id, 200) as external_id,
      left(coalesce(x.name, ''), 300) as name,
      case when char_length(btrim(coalesce(x.email, ''))) between 3 and 320 then lower(btrim(x.email)) end as email,
      left(nullif(x.linkedin, ''), 500) as linkedin,
      case when x.invite_limit >= 0 then x.invite_limit end as invite_limit,
      case when x.message_limit >= 0 then x.message_limit end as message_limit
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb))
      as x(external_id text, name text, email text, linkedin text, invite_limit integer, message_limit integer)
    where coalesce(x.external_id, '') <> ''
    order by left(x.external_id, 200)
  ),
  matched as (
    select items.*,
      (
        select case when count(*) = 1 then min(m.user_id::text)::uuid end
        from crm.workspace_members m
        join crm.profiles pr on pr.id = m.user_id
        where m.workspace_id = p_workspace
          and items.email is not null
          and lower(btrim(coalesce(pr.email, ''))) = items.email
      ) as member_id
    from items
  ),
  saved as (
    insert into crm.campaign_senders as s (workspace_id, provider, external_id, name, email, linkedin, invite_limit, message_limit, user_id)
    select p_workspace, p_provider, matched.external_id, matched.name, matched.email, matched.linkedin, matched.invite_limit, matched.message_limit, matched.member_id
    from matched
    on conflict on constraint campaign_senders_external do update
    set name = excluded.name,
        email = excluded.email,
        linkedin = excluded.linkedin,
        invite_limit = excluded.invite_limit,
        message_limit = excluded.message_limit
    where (s.name, s.email, s.linkedin, s.invite_limit, s.message_limit)
      is distinct from (excluded.name, excluded.email, excluded.linkedin, excluded.invite_limit, excluded.message_limit)
    returning s.id, s.user_id, s.name, s.external_id, (s.xmax = 0) as inserted
  )
  select saved.id, saved.user_id, saved.name, saved.external_id
  from saved
  where saved.inserted and saved.user_id is not null;
end;
$$;

revoke all on function private.campaign_sync_senders(uuid, text, jsonb) from public;
grant execute on function private.campaign_sync_senders(uuid, text, jsonb) to crm_app;

create or replace function private.campaign_sync_update(p_campaign uuid, p_patch jsonb)
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
  set sequence = case when p_patch ? 'sequence' then p_patch -> 'sequence' else k.sequence end,
      variables = case
        when p_patch ? 'variables' then array(select jsonb_array_elements_text(p_patch -> 'variables'))
        else k.variables
      end,
      stats = case when p_patch ? 'stats' then p_patch -> 'stats' else k.stats end,
      step_stats = case when p_patch ? 'stepStats' then p_patch -> 'stepStats' else k.step_stats end,
      day_stats = case when jsonb_typeof(p_patch -> 'dayStats') = 'array' then p_patch -> 'dayStats' else k.day_stats end,
      sender_ids = case
        when p_patch ? 'senderIds' then array(select jsonb_array_elements_text(p_patch -> 'senderIds'))
        else k.sender_ids
      end,
      sync_state = case
        when p_patch ? 'syncState' then jsonb_strip_nulls(k.sync_state || (p_patch -> 'syncState'))
        else k.sync_state
      end,
      sync_error = case when p_patch ? 'syncError' then left(p_patch ->> 'syncError', 500) else k.sync_error end,
      backfilled_at = case when coalesce((p_patch ->> 'backfilled')::boolean, false) then coalesce(k.backfilled_at, now()) else k.backfilled_at end,
      synced_at = now()
  where k.id = p_campaign;
end;
$$;

create or replace function private.campaign_sync_prospects(p_campaign uuid, p_leads jsonb)
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
    v_id := null;
    if v_lead.external_id is not null then
      select p.id into v_id from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.external_lead_id = v_lead.external_id;
    end if;
    if v_id is null and v_lead.email is not null then
      select p.id into v_id from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.email = v_lead.email
        and (p.external_lead_id is null or v_lead.external_id is null)
      order by p.created_at
      limit 1;
    end if;
    if v_id is null and v_lead.linkedin is not null then
      select p.id into v_id from crm.campaign_prospects p
      where p.campaign_id = p_campaign and p.linkedin = v_lead.linkedin
        and (p.external_lead_id is null or v_lead.external_id is null)
      order by p.created_at
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
      update crm.campaign_prospects p
      set import_error = case
            when (v_lead.email is not null and v_lead.email is distinct from p.email)
              or (v_lead.linkedin is not null and v_lead.linkedin is distinct from p.linkedin)
              or (p.lead || v_lead.lead) is distinct from p.lead
            then null
            else p.import_error
          end,
          external_lead_id = coalesce(p.external_lead_id, v_lead.external_id),
          email = coalesce(p.email, v_lead.email),
          linkedin = coalesce(p.linkedin, v_lead.linkedin),
          lead = p.lead || v_lead.lead,
          lead_status = coalesce(v_lead.lead_status, p.lead_status),
          category = coalesce(v_lead.category, p.category),
          pushed_at = coalesce(p.pushed_at, v_lead.added_at),
          sender_id = coalesce(p.sender_id, v_lead.sender_id)
      where p.id = v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  perform private.campaign_link_contacts(p_campaign, v_ids);
  return coalesce(cardinality(v_ids), 0);
end;
$$;

create or replace function private.team_remove_records(
  p_workspace uuid,
  p_actor uuid,
  p_user uuid,
  p_source text default null,
  p_operation text default 'remove_member',
  p_source_url text default null
)
returns table (record_kind text, record_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := private.team_role(p_workspace, p_actor);
  target_role text := private.team_role(p_workspace, p_user);
  next_home uuid;
  handed jsonb := '[]'::jsonb;
  owner_only jsonb := jsonb_build_object('ownerId', p_user);
  owner_now jsonb := jsonb_build_object('ownerId', p_actor);
  cleared_senders jsonb := '[]'::jsonb;
begin
  if coalesce(actor_role, '') not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can remove people.' using errcode = '42501';
  end if;
  if target_role is null then
    raise exception 'They are not in this workspace.' using errcode = '22023';
  end if;
  if target_role = 'owner' then
    raise exception 'The owner can''t be removed.' using errcode = '42501';
  end if;
  if p_user = p_actor then
    raise exception 'You can''t remove yourself.' using errcode = '42501';
  end if;
  if target_role = 'admin' and actor_role <> 'owner' then
    raise exception 'Only the owner can remove an admin.' using errcode = '42501';
  end if;
  select m.workspace_id into next_home
  from crm.workspace_members m
  where m.user_id = p_user and m.workspace_id <> p_workspace
  order by m.created_at, m.workspace_id
  limit 1;

  with moved as (
    update crm.companies c set owner_id = p_actor
    where c.workspace_id = p_workspace and c.owner_id = p_user
    returning c.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'company', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  with moved as (
    update crm.contacts c set owner_id = p_actor
    where c.workspace_id = p_workspace and c.owner_id = p_user
    returning c.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'contact', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  with moved as (
    update crm.opportunities o set owner_id = p_actor
    where o.workspace_id = p_workspace and o.owner_id = p_user
    returning o.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'opportunity', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  with prior as (
    select t.id, t.owner_id, t.due_at, t.due_has_time, t.scheduled_by, t.remind_minutes
    from crm.tasks t
    where t.workspace_id = p_workspace
      and (t.owner_id = p_user or (t.owner_id is null and t.created_by_user_id = p_user))
    for update
  ),
  moved as (
    update crm.tasks t
      set owner_id = p_actor,
          due_at = case
            when t.due_has_time and t.due_at is not null
            then date_trunc('day', t.due_at at time zone 'Europe/London') at time zone 'Europe/London'
            else t.due_at
          end,
          scheduled_by = case when t.due_has_time then null else t.scheduled_by end,
          remind_minutes = case when t.due_has_time then null else t.remind_minutes end,
          due_has_time = false
    from prior
    where t.id = prior.id
    returning t.id, t.due_at, t.scheduled_by, t.remind_minutes
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object(
    'kind', 'task',
    'id', moved.id,
    'changes', private.handover_changes(
      jsonb_build_object(
        'ownerId', prior.owner_id,
        'dueAt', private.handover_instant(prior.due_at),
        'dueHasTime', coalesce(prior.due_has_time and prior.due_at is not null, false),
        'scheduledBy', prior.scheduled_by,
        'remindMinutes', prior.remind_minutes
      ),
      jsonb_build_object(
        'ownerId', p_actor,
        'dueAt', private.handover_instant(moved.due_at),
        'dueHasTime', false,
        'scheduledBy', moved.scheduled_by,
        'remindMinutes', moved.remind_minutes
      ),
      array['ownerId', 'dueAt', 'dueHasTime', 'scheduledBy', 'remindMinutes']
    )
  )), '[]'::jsonb)
  into handed
  from moved
  join prior on prior.id = moved.id;

  with moved as (
    update crm.documents d set owner_id = p_actor
    where d.workspace_id = p_workspace and d.owner_id = p_user
    returning d.id
  )
  select handed || coalesce(jsonb_agg(jsonb_build_object('kind', 'document', 'id', moved.id, 'changes', private.handover_changes(owner_only, owner_now, array['ownerId']))), '[]'::jsonb)
  into handed from moved;

  update crm.task_occurrence_changes c
  set due_at = date_trunc('day', c.due_at at time zone 'Europe/London') at time zone 'Europe/London',
      due_has_time = false
  from crm.task_series s
  where c.series_id = s.id
    and s.workspace_id = p_workspace
    and s.owner_id = p_user
    and c.due_has_time;
  insert into crm.task_participants (task_id, user_id, added_by)
  select s.current_task_id, p_actor, p_actor
  from crm.task_series s
  join crm.tasks t on t.id = s.current_task_id
  where s.workspace_id = p_workspace and (s.owner_id = p_user or (s.owner_id is null and s.created_by_user_id = p_user))
    and t.owner_id is distinct from p_actor and t.created_by_user_id is distinct from p_actor
  on conflict do nothing;
  with series_events as (
    insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, source, source_url, operation, changes)
    select p_workspace, 'task_series.updated', 'task', handed_series.anchor, 'user', p_actor, p_source, p_source_url, p_operation,
      jsonb_build_object(
        'series', jsonb_build_object('id', handed_series.id),
        'handedOver', jsonb_build_object('from', p_user, 'to', case when handed_series.owner_id is null or handed_series.owner_id = p_user then p_actor else handed_series.owner_id end, 'owner', handed_series.owner_id = p_user, 'creator', handed_series.created_by_user_id = p_user)
      )
    from (
      select s.id, s.owner_id, s.created_by_user_id, coalesce(s.current_task_id, private.series_anchor_task(s.id)) as anchor
      from crm.task_series s
      where s.workspace_id = p_workspace and (s.owner_id = p_user or s.created_by_user_id = p_user)
        and (s.current_task_id is not null or (s.split_from_id is not null and s.ended_at is null and s.archived_at is null))
    ) handed_series
    where handed_series.anchor is not null
    returning id, event_type, entity_type, entity_id, changes, created_at
  )
  insert into crm.webhook_deliveries (workspace_id, endpoint_id, event_id, event_type, payload)
  select p_workspace, endpoint.id, series_events.id, series_events.event_type, jsonb_build_object(
    'id', series_events.id,
    'type', series_events.event_type,
    'createdAt', private.handover_instant(series_events.created_at),
    'workspaceId', p_workspace,
    'entity', jsonb_build_object('type', series_events.entity_type, 'id', series_events.entity_id),
    'actor', jsonb_build_object('type', 'user', 'userId', p_actor, 'agentId', null),
    'source', p_source,
    'sourceUrl', p_source_url,
    'data', series_events.changes
  )
  from series_events
  join crm.webhook_endpoints endpoint
    on endpoint.workspace_id = p_workspace
   and endpoint.archived_at is null
   and endpoint.enabled
   and (series_events.event_type = any(endpoint.events) or '*' = any(endpoint.events));
  update crm.task_series s
  set owner_id = p_actor,
      at = null,
      remind_minutes = null,
      roll_pending = case when s.ended_at is null and s.archived_at is null then true else s.roll_pending end
  where s.workspace_id = p_workspace and s.owner_id = p_user;
  update crm.task_series s set created_by_user_id = coalesce(s.owner_id, p_actor)
  where s.workspace_id = p_workspace and s.created_by_user_id = p_user;

  with items as (
    select item ->> 'kind' as kind, (item ->> 'id')::uuid as id, item -> 'changes' as changes
    from jsonb_array_elements(handed) as item
  ),
  events as (
    insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, source, source_url, operation, changes)
    select p_workspace, items.kind || '.updated', items.kind, items.id, 'user', p_actor, p_source, p_source_url, p_operation, items.changes
    from items
    returning id, event_type, entity_type, entity_id, changes, created_at
  )
  insert into crm.webhook_deliveries (workspace_id, endpoint_id, event_id, event_type, payload)
  select p_workspace, endpoint.id, events.id, events.event_type, jsonb_build_object(
    'id', events.id,
    'type', events.event_type,
    'createdAt', private.handover_instant(events.created_at),
    'workspaceId', p_workspace,
    'entity', jsonb_build_object('type', events.entity_type, 'id', events.entity_id),
    'actor', jsonb_build_object('type', 'user', 'userId', p_actor, 'agentId', null),
    'source', p_source,
    'sourceUrl', p_source_url,
    'data', events.changes
  )
  from events
  join crm.webhook_endpoints endpoint
    on endpoint.workspace_id = p_workspace
   and endpoint.archived_at is null
   and endpoint.enabled
   and (events.event_type = any(endpoint.events) or '*' = any(endpoint.events));

  update crm.webhook_endpoints set created_by_user_id = p_actor
  where workspace_id = p_workspace and created_by_user_id = p_user;

  with cleared as (
    update crm.campaign_senders s set user_id = null
    where s.workspace_id = p_workspace and s.user_id = p_user
    returning s.id, s.provider, s.external_id, s.name
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', cleared.id, 'provider', cleared.provider, 'externalId', cleared.external_id, 'name', cleared.name)), '[]'::jsonb)
  into cleared_senders from cleared;

  with sender_events as (
    insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, source, source_url, operation, changes)
    select p_workspace, 'campaign.sender_linked', 'campaign_sender', (item ->> 'id')::uuid, 'user', p_actor, p_source, p_source_url, p_operation,
      jsonb_build_object(
        'provider', item ->> 'provider',
        'sender', jsonb_build_object('id', item ->> 'id', 'externalId', item ->> 'externalId', 'name', item ->> 'name'),
        'linked', null,
        'unlinked', p_user
      )
    from jsonb_array_elements(cleared_senders) as item
    returning id, event_type, entity_type, entity_id, changes, created_at
  )
  insert into crm.webhook_deliveries (workspace_id, endpoint_id, event_id, event_type, payload)
  select p_workspace, endpoint.id, sender_events.id, sender_events.event_type, jsonb_build_object(
    'id', sender_events.id,
    'type', sender_events.event_type,
    'createdAt', private.handover_instant(sender_events.created_at),
    'workspaceId', p_workspace,
    'entity', jsonb_build_object('type', sender_events.entity_type, 'id', sender_events.entity_id),
    'actor', jsonb_build_object('type', 'user', 'userId', p_actor, 'agentId', null),
    'source', p_source,
    'sourceUrl', p_source_url,
    'data', sender_events.changes
  )
  from sender_events
  join crm.webhook_endpoints endpoint
    on endpoint.workspace_id = p_workspace
   and endpoint.archived_at is null
   and endpoint.enabled
   and (sender_events.event_type = any(endpoint.events) or '*' = any(endpoint.events));

  update crm.workflow_runs r
    set status = 'cancelled', waiting_for = null, resume_at = null, finished_at = now()
  where r.workspace_id = p_workspace and r.owner_id = p_user and r.parent_run_id is null and r.status in ('queued', 'running', 'waiting');
  update crm.workflow_runs r
    set status = 'cancelled', waiting_for = null, resume_at = null, finished_at = now()
  where r.workspace_id = p_workspace and r.owner_id = p_user and r.parent_run_id is not null and r.status in ('queued', 'running', 'waiting');

  if next_home is not null then
    perform private.move_personal_rows(p_user, p_workspace, next_home);
  else
    update crm.mailbox_connections
      set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
      where workspace_id = p_workspace and user_id = p_user;
    update crm.calendar_accounts
      set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
      where workspace_id = p_workspace and user_id = p_user;
    delete from crm.ai_accounts where workspace_id = p_workspace and user_id = p_user;
    update crm.ai_companions set revoked_at = now()
      where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  end if;
  delete from crm.granola_keys where workspace_id = p_workspace and user_id = p_user;
  delete from crm.readwise_keys where workspace_id = p_workspace and user_id = p_user;
  delete from crm.recall_keys where workspace_id = p_workspace and user_id = p_user;
  update crm.personal_tokens set revoked_at = now()
    where workspace_id = p_workspace and user_id = p_user and revoked_at is null;
  update crm.agent_mail_messages
    set status = 'failed', status_reason = 'They left the workspace.', advancing_until = null
    where workspace_id = p_workspace and user_id = p_user and status in ('received', 'working') and replied_at is null;
  delete from crm.agent_mail_threads where workspace_id = p_workspace and user_id = p_user;
  delete from crm.workspace_members where workspace_id = p_workspace and user_id = p_user;

  return query
    select item ->> 'kind', (item ->> 'id')::uuid
    from jsonb_array_elements(handed) as item
    union all
    select 'campaign_sender', (item ->> 'id')::uuid
    from jsonb_array_elements(cleared_senders) as item;
end;
$$;

revoke all on function private.team_remove_records(uuid, uuid, uuid, text, text, text) from public;
grant execute on function private.team_remove_records(uuid, uuid, uuid, text, text, text) to crm_app;

reset lock_timeout;
