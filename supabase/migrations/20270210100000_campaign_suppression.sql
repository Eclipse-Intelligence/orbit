set lock_timeout = '5s';

create table if not exists crm.suppressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  contact_id uuid references crm.contacts (id) on delete set null,
  kind text not null,
  value text not null,
  reason text not null,
  source text not null,
  campaign_id uuid references crm.campaigns (id) on delete set null,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_by_agent_id uuid references crm.agents (id) on delete set null,
  blocked_at timestamptz,
  block_attempts integer not null default 0,
  bounced_at timestamptz,
  created_at timestamptz not null default now(),
  constraint suppressions_kind check (kind in ('email', 'linkedin')),
  constraint suppressions_reason check (reason in ('unsubscribed', 'bounced', 'manual')),
  constraint suppressions_value_length check (char_length(value) between 1 and 500),
  constraint suppressions_source_length check (char_length(source) between 1 and 40)
);

alter table crm.mail_drafts add column if not exists scheduled_at timestamptz;

create unique index if not exists suppressions_value_uidx on crm.suppressions (workspace_id, kind, value);
create index if not exists suppressions_contact_idx on crm.suppressions (workspace_id, contact_id) where contact_id is not null;
create index if not exists suppressions_unblocked_idx on crm.suppressions (workspace_id, created_at)
  where kind = 'email' and blocked_at is null and reason <> 'bounced';

alter table crm.suppressions enable row level security;
alter table crm.suppressions force row level security;

drop policy if exists suppressions_select_member on crm.suppressions;
create policy suppressions_select_member on crm.suppressions
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists suppressions_select_agent on crm.suppressions;
create policy suppressions_select_agent on crm.suppressions
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));

revoke all on crm.suppressions from anon, authenticated, crm_agent;
grant select on crm.suppressions to authenticated, crm_agent;

alter table crm.campaign_prospects drop constraint if exists campaign_prospects_stop_reason;
alter table crm.campaign_prospects
  add constraint campaign_prospects_stop_reason check (stop_reason is null or stop_reason in ('replied', 'removed', 'suppressed'));

create or replace function private.suppress_person_rows(
  p_workspace uuid,
  p_contact uuid,
  p_emails text[],
  p_linkedins text[],
  p_reason text,
  p_source text,
  p_user uuid,
  p_agent uuid,
  p_campaign uuid,
  p_except uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_email text;
  v_contact_linkedin text;
  v_emails text[];
  v_linkedins text[];
  v_already boolean;
  v_stopping jsonb;
  v_skipped integer;
begin
  if p_reason not in ('unsubscribed', 'manual') then
    raise exception 'The reason must be unsubscribed or manual.' using errcode = '22023';
  end if;
  if p_contact is not null then
    select c.normalized_email, c.normalized_linkedin into v_contact_email, v_contact_linkedin
    from crm.contacts c where c.id = p_contact and c.workspace_id = p_workspace;
    if not found then
      raise exception 'That person isn''t in this workspace.' using errcode = 'P0002';
    end if;
  end if;
  v_emails := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_emails, '{}'::text[]) || v_contact_email) x where nullif(btrim(x), '') is not null);
  v_linkedins := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_linkedins, '{}'::text[]) || v_contact_linkedin) x where nullif(btrim(x), '') is not null);
  if cardinality(v_emails) = 0 and cardinality(v_linkedins) = 0 then
    raise exception 'Add an email address or LinkedIn profile first.' using errcode = '22023';
  end if;

  select exists (
    select 1 from crm.suppressions s
    where s.workspace_id = p_workspace and s.reason <> 'bounced'
      and (
        (p_contact is not null and s.contact_id = p_contact)
        or (s.kind = 'email' and s.value = any(v_emails))
        or (s.kind = 'linkedin' and s.value = any(v_linkedins))
      )
  ) into v_already;

  insert into crm.suppressions as s (workspace_id, contact_id, kind, value, reason, source, campaign_id, created_by_user_id, created_by_agent_id, blocked_at)
  select p_workspace, p_contact, w.kind, w.value, p_reason, left(p_source, 40), p_campaign, p_user, p_agent,
    case when p_source = 'smartlead' then now() end
  from (
    select 'email'::text as kind, e as value from unnest(v_emails) e
    union all
    select 'linkedin'::text, l from unnest(v_linkedins) l
  ) w
  order by w.kind, w.value
  on conflict (workspace_id, kind, value) do update
  set reason = case when s.reason = 'bounced' then excluded.reason else s.reason end,
      source = case when s.reason = 'bounced' then excluded.source else s.source end,
      campaign_id = case when s.reason = 'bounced' then excluded.campaign_id else s.campaign_id end,
      created_by_user_id = case when s.reason = 'bounced' then excluded.created_by_user_id else s.created_by_user_id end,
      created_by_agent_id = case when s.reason = 'bounced' then excluded.created_by_agent_id else s.created_by_agent_id end,
      blocked_at = case when s.reason = 'bounced' then excluded.blocked_at else s.blocked_at end,
      created_at = case when s.reason = 'bounced' then now() else s.created_at end,
      contact_id = coalesce(s.contact_id, excluded.contact_id)
  where s.reason = 'bounced' or (s.contact_id is null and excluded.contact_id is not null);

  with person as (
    select p.id
    from crm.campaign_prospects p
    join crm.campaigns k on k.id = p.campaign_id
    where p.workspace_id = p_workspace
      and (p_except is null or p.id <> p_except)
      and (
        (p_contact is not null and p.contact_id = p_contact)
        or p.email = any(v_emails)
        or p.linkedin = any(v_linkedins)
      )
      and private.campaign_prospect_active(p.state, p.stopped_at, p.lead_status, k.status)
      and p.stop_requested_at is null
    order by p.id
    for no key update of p
  ),
  changed as (
    update crm.campaign_prospects p
    set state = case when p.state in ('queued', 'filling') then 'skipped' else p.state end,
        skip_reason = case when p.state in ('queued', 'filling') then 'Do not contact' else p.skip_reason end,
        claimed_at = case when p.state in ('queued', 'filling') then null else p.claimed_at end,
        stop_requested_at = case when p.state in ('pushing', 'pushed') then now() else p.stop_requested_at end,
        stop_reason = case when p.state in ('pushing', 'pushed') then 'suppressed' else p.stop_reason end
    from person
    where p.id = person.id
    returning p.id, p.campaign_id, p.state, p.external_lead_id, p.email, p.linkedin, p.sender_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'prospect_id', c.id,
      'campaign_id', c.campaign_id,
      'campaign_external_id', k.external_id,
      'provider', k.provider,
      'external_lead_id', c.external_lead_id,
      'email', c.email,
      'linkedin', c.linkedin,
      'sender_id', c.sender_id,
      'stop_reason', 'suppressed'
    )) filter (where c.state = 'pushed'), '[]'::jsonb),
    count(*) filter (where c.state = 'skipped')::integer
  into v_stopping, v_skipped
  from changed c
  join crm.campaigns k on k.id = c.campaign_id;

  return jsonb_build_object('changed', not v_already, 'stopping', v_stopping, 'skipped', coalesce(v_skipped, 0));
end;
$$;

create or replace function private.suppression_audit(p_workspace uuid, p_audit jsonb, p_more jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event uuid;
  v_created timestamptz;
  v_changes jsonb := coalesce(p_audit -> 'changes', '{}'::jsonb) || coalesce(p_more, '{}'::jsonb);
begin
  insert into crm.audit_events (
    workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, actor_agent_id, credential_id, source, source_url, operation, changes
  ) values (
    p_workspace, p_audit ->> 'eventType', p_audit ->> 'entityType', (p_audit ->> 'entityId')::uuid, p_audit ->> 'actorType',
    (p_audit ->> 'userId')::uuid, (p_audit ->> 'agentId')::uuid, (p_audit ->> 'credentialId')::uuid,
    p_audit ->> 'source', p_audit ->> 'sourceUrl', coalesce(p_audit ->> 'operation', p_audit ->> 'eventType'), v_changes
  )
  returning id, created_at into v_event, v_created;
  insert into crm.webhook_deliveries (workspace_id, endpoint_id, event_id, event_type, payload)
  select p_workspace, endpoint.id, v_event, p_audit ->> 'eventType', jsonb_build_object(
    'id', v_event,
    'type', p_audit ->> 'eventType',
    'createdAt', private.handover_instant(v_created),
    'workspaceId', p_workspace,
    'entity', jsonb_build_object('type', p_audit ->> 'entityType', 'id', p_audit ->> 'entityId'),
    'actor', jsonb_build_object('type', p_audit ->> 'actorType', 'userId', p_audit ->> 'userId', 'agentId', p_audit ->> 'agentId'),
    'source', p_audit ->> 'source',
    'sourceUrl', p_audit ->> 'sourceUrl',
    'data', v_changes
  )
  from crm.webhook_endpoints endpoint
  where endpoint.workspace_id = p_workspace
    and endpoint.archived_at is null
    and endpoint.enabled
    and ((p_audit ->> 'eventType') = any(endpoint.events) or '*' = any(endpoint.events));
  return v_event;
end;
$$;

create or replace function private.suppress_person(
  p_workspace uuid,
  p_contact uuid,
  p_emails text[],
  p_linkedins text[],
  p_reason text,
  p_source text,
  p_user uuid,
  p_agent uuid,
  p_campaign uuid,
  p_except uuid,
  p_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_result := private.suppress_person_rows(p_workspace, p_contact, p_emails, p_linkedins, p_reason, p_source, p_user, p_agent, p_campaign, p_except);
  if p_audit is not null and (v_result ->> 'changed')::boolean then
    perform private.suppression_audit(p_workspace, p_audit, jsonb_build_object(
      'stopped', jsonb_array_length(v_result -> 'stopping'),
      'skipped', (v_result ->> 'skipped')::integer
    ));
  end if;
  return v_result;
end;
$$;

create or replace function private.suppression_lift(p_workspace uuid, p_contact uuid, p_emails text[], p_linkedins text[], p_audit jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_email text;
  v_contact_linkedin text;
  v_emails text[];
  v_linkedins text[];
  v_targets uuid[];
  v_lifted jsonb;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_contact is not null then
    select c.normalized_email, c.normalized_linkedin into v_contact_email, v_contact_linkedin
    from crm.contacts c where c.id = p_contact and c.workspace_id = p_workspace;
  end if;
  v_emails := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_emails, '{}'::text[]) || v_contact_email) x where nullif(btrim(x), '') is not null);
  v_linkedins := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_linkedins, '{}'::text[]) || v_contact_linkedin) x where nullif(btrim(x), '') is not null);
  select coalesce(array_agg(t.id order by t.id), '{}'::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'value', t.value, 'reason', t.reason) order by t.kind, t.value), '[]'::jsonb)
  into v_targets, v_lifted
  from (
    select s.id, s.kind, s.value, s.reason
    from crm.suppressions s
    where s.workspace_id = p_workspace and s.reason in ('manual', 'unsubscribed')
      and (
        (p_contact is not null and s.contact_id = p_contact)
        or (s.kind = 'email' and s.value = any(v_emails))
        or (s.kind = 'linkedin' and s.value = any(v_linkedins))
      )
    order by s.id
    for update
  ) t;
  if cardinality(v_targets) = 0 then
    return v_lifted;
  end if;
  delete from crm.suppressions s where s.id = any(v_targets) and s.bounced_at is null;
  update crm.suppressions s
  set reason = 'bounced', created_at = s.bounced_at, created_by_user_id = null, created_by_agent_id = null
  where s.id = any(v_targets) and s.bounced_at is not null;
  update crm.campaign_prospects p
  set stop_requested_at = null, stop_reason = null
  where p.workspace_id = p_workspace and p.stop_reason = 'suppressed' and p.stopped_at is null
    and (
      (p_contact is not null and p.contact_id = p_contact)
      or p.email = any(v_emails)
      or p.linkedin = any(v_linkedins)
    );
  if p_audit is not null then
    perform private.suppression_audit(p_workspace, p_audit, jsonb_build_object('lifted', v_lifted));
  end if;
  return v_lifted;
end;
$$;

create or replace function private.suppress_from_event(p_event uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event record;
begin
  select e.id, e.kind, e.workspace_id, e.campaign_id, p.id as prospect_id, p.contact_id, p.email, p.linkedin, k.provider,
    (select c.id from crm.contacts c where c.id = p.contact_id and c.workspace_id = e.workspace_id) as live_contact
  into v_event
  from crm.campaign_events e
  join crm.campaign_prospects p on p.id = e.prospect_id
  join crm.campaigns k on k.id = e.campaign_id
  where e.id = p_event;
  if not found or v_event.kind not in ('unsubscribed', 'bounced') then
    return;
  end if;
  if v_event.kind = 'unsubscribed' then
    if v_event.email is null and v_event.linkedin is null and v_event.live_contact is null then
      return;
    end if;
    perform private.suppress_person_rows(
      v_event.workspace_id, v_event.live_contact, array[v_event.email], array[v_event.linkedin], 'unsubscribed', v_event.provider,
      null, null, v_event.campaign_id, v_event.prospect_id
    );
    return;
  end if;
  if v_event.email is null then
    return;
  end if;
  insert into crm.suppressions as s (workspace_id, contact_id, kind, value, reason, source, campaign_id, blocked_at, bounced_at)
  values (v_event.workspace_id, v_event.live_contact, 'email', v_event.email, 'bounced', v_event.provider, v_event.campaign_id,
    case when v_event.provider = 'smartlead' then now() end, now())
  on conflict (workspace_id, kind, value) do update
  set bounced_at = excluded.bounced_at
  where s.bounced_at is null;
  if v_event.live_contact is not null and not exists (
    select 1 from crm.enrichment_lookups l
    where l.workspace_id = v_event.workspace_id and l.value = v_event.email and l.field = 'email_check'
      and l.record_type = 'contact' and l.record_id = v_event.live_contact and l.status = 'invalid' and l.provider = v_event.provider
  ) then
    insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value)
    values (v_event.workspace_id, 'contact', v_event.live_contact, 'email_check', 'invalid', v_event.provider, v_event.email);
  end if;
end;
$$;

create or replace function private.campaign_event_suppress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind in ('unsubscribed', 'bounced') then
    perform private.suppress_from_event(new.id);
  end if;
  return null;
end;
$$;

drop trigger if exists campaign_events_suppress on crm.campaign_events;
create trigger campaign_events_suppress
  after insert on crm.campaign_events
  for each row
  when (new.kind in ('unsubscribed', 'bounced'))
  execute function private.campaign_event_suppress();

create or replace function private.suppressions_follow_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    update crm.suppressions s set contact_id = null where s.contact_id = new.id and s.workspace_id <> new.workspace_id;
  end if;
  return null;
end;
$$;

drop trigger if exists contacts_suppressions_follow on crm.contacts;
create trigger contacts_suppressions_follow
  after update of workspace_id on crm.contacts
  for each row
  execute function private.suppressions_follow_contact();

create or replace function private.suppression_block_pending(p_workspace uuid, p_limit integer)
returns table (id uuid, value text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select s.id, s.value
  from crm.suppressions s
  where s.workspace_id = p_workspace and s.kind = 'email' and s.blocked_at is null and s.reason <> 'bounced'
    and s.source <> 'smartlead' and s.block_attempts < 3
  order by s.created_at, s.id
  limit least(greatest(p_limit, 1), 500);
end;
$$;

create or replace function private.suppression_block_failed(p_workspace uuid, p_ids uuid[])
returns table (id uuid, attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  update crm.suppressions s set block_attempts = s.block_attempts + 1
  where s.workspace_id = p_workspace and s.id = any(p_ids) and s.blocked_at is null
  returning s.id, s.block_attempts;
end;
$$;

create or replace function private.suppression_blocked(p_workspace uuid, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.suppressions s set blocked_at = now()
  where s.workspace_id = p_workspace and s.id = any(p_ids) and s.blocked_at is null;
end;
$$;

create or replace function private.merge_contact_references(
  p_workspace uuid,
  p_user uuid,
  p_agent uuid,
  p_keep uuid,
  p_merge uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  keep_row crm.contacts%rowtype;
  merge_row crm.contacts%rowtype;
  moved jsonb := '{}'::jsonb;
  target text;
  calendar_replaced integer;
  calendar_shared integer;
  marks integer;
  follow_ups integer;
  routes integer;
  links_dropped integer;
  links_moved integer;
  prospect record;
  prospects_combined integer := 0;
  suppressions_moved integer;
begin
  perform private.merge_actor_check(p_workspace, p_user, p_agent);
  if p_keep = p_merge then
    raise exception 'Pick a different person to merge into.' using errcode = '22023';
  end if;
  perform 1 from crm.contacts c
    where c.workspace_id = p_workspace and c.id in (p_keep, p_merge)
    order by c.id
    for update;
  select * into keep_row from crm.contacts c where c.id = p_keep and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The person to keep isn''t in this workspace.' using errcode = 'P0002';
  end if;
  select * into merge_row from crm.contacts c where c.id = p_merge and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The person to merge isn''t in this workspace.' using errcode = 'P0002';
  end if;
  if keep_row.archived_at is not null then
    raise exception '% is archived, so they can''t be merged into.',
      coalesce(nullif(trim(concat_ws(' ', keep_row.first_name, keep_row.last_name)), ''), keep_row.email, 'This person')
      using errcode = '22023';
  end if;
  if merge_row.archived_at is not null then
    raise exception '% is already archived, so they can''t be merged.',
      coalesce(nullif(trim(concat_ws(' ', merge_row.first_name, merge_row.last_name)), ''), merge_row.email, 'This person')
      using errcode = '22023';
  end if;

  perform set_config('orbit.merging', 'on', true);

  foreach target in array array[
    'tasks', 'activities', 'email_messages', 'call_records', 'call_insights',
    'conversation_imports', 'workflow_runs', 'documents'
  ] loop
    moved := moved || jsonb_build_object(target, private.merge_move(target, 'contact_id', p_workspace, p_merge, p_keep));
  end loop;
  moved := moved || jsonb_build_object('task_series', private.merge_move('task_series', 'contact_id', p_workspace, p_merge, p_keep));
  moved := moved || jsonb_build_object(
    'opportunities', private.merge_move('opportunities', 'primary_contact_id', p_workspace, p_merge, p_keep)
  );

  with changed as (
    update crm.calendar_events e
    set contact_ids = array_replace(e.contact_ids, p_merge, p_keep)
    where e.workspace_id = p_workspace and p_merge = any(e.contact_ids) and not (p_keep = any(e.contact_ids))
    returning e.id
  )
  select count(*)::integer into calendar_replaced from changed;
  with changed as (
    update crm.calendar_events e
    set contact_ids = array_remove(e.contact_ids, p_merge)
    where e.workspace_id = p_workspace and p_merge = any(e.contact_ids)
    returning e.id
  )
  select count(*)::integer into calendar_shared from changed;

  with changed as (
    update crm.workflow_record_marks m
    set record_id = p_keep
    where m.workspace_id = p_workspace and m.record_id = p_merge
      and not exists (
        select 1 from crm.workflow_record_marks k
        where k.workflow_id = m.workflow_id and k.record_id = p_keep
      )
    returning m.workflow_id
  )
  select count(*)::integer into marks from changed;

  update crm.follow_up_suggestions f set contact_id = p_keep where f.contact_id = p_merge;
  get diagnostics follow_ups = row_count;
  update crm.mail_thread_routes r set contact_id = p_keep where r.contact_id = p_merge;
  get diagnostics routes = row_count;

  for prospect in
    select dup.id as merge_id, kept.id as keep_id, dup.replied_at, dup.last_event_at, dup.external_lead_id, dup.email, dup.linkedin,
      dup.stop_requested_at, dup.stopped_at, dup.stop_reason
    from crm.campaign_prospects dup
    join crm.campaign_prospects kept
      on kept.campaign_id = dup.campaign_id and kept.contact_id = p_keep and kept.workspace_id = p_workspace
    where dup.workspace_id = p_workspace and dup.contact_id = p_merge
    order by dup.id
    for update of dup, kept
  loop
    update crm.campaign_events e set prospect_id = prospect.keep_id where e.prospect_id = prospect.merge_id;
    update crm.campaign_messages m set prospect_id = prospect.keep_id where m.prospect_id = prospect.merge_id;
    update crm.campaign_prospects k
    set replied_at = case
          when k.replied_at is null then prospect.replied_at
          when prospect.replied_at is null then k.replied_at
          else least(k.replied_at, prospect.replied_at)
        end,
        last_event_at = greatest(k.last_event_at, prospect.last_event_at),
        stop_requested_at = case
          when prospect.stop_requested_at is not null and prospect.stopped_at is null and k.stopped_at is null
            then coalesce(k.stop_requested_at, prospect.stop_requested_at)
          else k.stop_requested_at
        end,
        stop_reason = case
          when prospect.stop_requested_at is not null and prospect.stopped_at is null and k.stopped_at is null
            then coalesce(k.stop_reason, prospect.stop_reason)
          else k.stop_reason
        end
    where k.id = prospect.keep_id;
    delete from crm.campaign_prospects d where d.id = prospect.merge_id;
    update crm.campaign_prospects k
    set external_lead_id = coalesce(k.external_lead_id, prospect.external_lead_id),
        email = coalesce(k.email, prospect.email),
        linkedin = coalesce(k.linkedin, prospect.linkedin)
    where k.id = prospect.keep_id
      and (k.external_lead_id is null or k.email is null or k.linkedin is null);
    prospects_combined := prospects_combined + 1;
  end loop;
  moved := moved || jsonb_build_object(
    'campaign_prospects', private.merge_move('campaign_prospects', 'contact_id', p_workspace, p_merge, p_keep)
  );

  update crm.suppressions s set contact_id = p_keep
  where s.workspace_id = p_workspace
    and (
      s.contact_id = p_merge
      or (
        s.contact_id is null and s.reason <> 'bounced'
        and ((s.kind = 'email' and s.value = merge_row.normalized_email) or (s.kind = 'linkedin' and s.value = merge_row.normalized_linkedin))
      )
    );
  get diagnostics suppressions_moved = row_count;

  delete from crm.page_links l
  where l.target_kind = 'contact' and l.target_record_id = p_merge
    and exists (
      select 1 from crm.page_links k
      where k.page_id = l.page_id and k.target_kind = 'contact' and k.target_record_id = p_keep
    );
  get diagnostics links_dropped = row_count;
  update crm.page_links l
  set target_record_id = p_keep
  where l.target_kind = 'contact' and l.target_record_id = p_merge;
  get diagnostics links_moved = row_count;

  perform set_config('orbit.merging', 'off', true);

  return moved || jsonb_build_object(
    'calendar_events', calendar_replaced,
    'calendar_events_shared', calendar_shared,
    'workflow_record_marks', marks,
    'follow_up_suggestions', follow_ups,
    'mail_thread_routes', routes,
    'page_links', links_dropped + links_moved,
    'campaign_prospects_combined', prospects_combined,
    'suppressions', suppressions_moved
  );
end;
$$;

revoke all on function private.suppress_person_rows(uuid, uuid, text[], text[], text, text, uuid, uuid, uuid, uuid) from public;
revoke all on function private.suppress_person(uuid, uuid, text[], text[], text, text, uuid, uuid, uuid, uuid, jsonb) from public;
revoke all on function private.suppression_lift(uuid, uuid, text[], text[], jsonb) from public;
revoke all on function private.suppress_from_event(uuid) from public;
revoke all on function private.campaign_event_suppress() from public;
revoke all on function private.suppressions_follow_contact() from public;
revoke all on function private.suppression_block_pending(uuid, integer) from public;
revoke all on function private.suppression_blocked(uuid, uuid[]) from public;
revoke all on function private.suppression_block_failed(uuid, uuid[]) from public;
revoke all on function private.suppression_audit(uuid, jsonb, jsonb) from public;
revoke all on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) from public;

grant execute on function private.suppress_person(uuid, uuid, text[], text[], text, text, uuid, uuid, uuid, uuid, jsonb) to crm_app;
grant execute on function private.suppression_lift(uuid, uuid, text[], text[], jsonb) to crm_app;
grant execute on function private.suppression_block_pending(uuid, integer) to crm_app;
grant execute on function private.suppression_blocked(uuid, uuid[]) to crm_app;
grant execute on function private.suppression_block_failed(uuid, uuid[]) to crm_app;
grant execute on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) to crm_app;

do $$
declare
  v_event uuid;
begin
  if exists (select 1 from crm.suppressions) then
    return;
  end if;
  for v_event in
    select e.id from crm.campaign_events e
    where e.kind in ('unsubscribed', 'bounced')
    order by e.occurred_at, e.id
  loop
    perform private.suppress_from_event(v_event);
  end loop;
end;
$$;

reset lock_timeout;
