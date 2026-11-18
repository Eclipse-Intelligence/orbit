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

create or replace function private.suppress_person_group(
  p_workspace uuid,
  p_contacts uuid[],
  p_emails text[],
  p_linkedins text[],
  p_reason text,
  p_source text,
  p_user uuid,
  p_agent uuid,
  p_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contacts uuid[];
  v_contact uuid;
  v_emails text[];
  v_linkedins text[];
  v_already boolean;
  v_stopping jsonb;
  v_skipped integer;
  v_still_blocked text[];
  v_result jsonb;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_reason not in ('unsubscribed', 'manual') then
    raise exception 'The reason must be unsubscribed or manual.' using errcode = '22023';
  end if;
  v_contacts := array(
    select c.id from unnest(coalesce(p_contacts, '{}'::uuid[])) with ordinality as x(id, n)
    join crm.contacts c on c.id = x.id and c.workspace_id = p_workspace
    order by x.n
  );
  v_contact := v_contacts[1];
  v_emails := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_emails, '{}'::text[])) x where nullif(btrim(x), '') is not null);
  v_linkedins := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_linkedins, '{}'::text[])) x where nullif(btrim(x), '') is not null);
  if cardinality(v_emails) = 0 and cardinality(v_linkedins) = 0 then
    raise exception 'Add an email address or LinkedIn profile first.' using errcode = '22023';
  end if;

  with gone as (
    delete from crm.campaign_block_lifts b where b.workspace_id = p_workspace and b.value = any(v_emails)
    returning b.value
  )
  select coalesce(array_agg(gone.value), '{}'::text[]) into v_still_blocked from gone;

  select exists (
    select 1 from crm.suppressions s
    where s.workspace_id = p_workspace and s.reason <> 'bounced'
      and (
        s.contact_id = any(v_contacts)
        or (s.kind = 'email' and s.value = any(v_emails))
        or (s.kind = 'linkedin' and s.value = any(v_linkedins))
      )
  ) into v_already;

  insert into crm.suppressions as s (workspace_id, contact_id, kind, value, reason, source, campaign_id, created_by_user_id, created_by_agent_id, blocked_at)
  select p_workspace, v_contact, w.kind, w.value, p_reason, left(p_source, 40), null, p_user, p_agent,
    case when p_source = 'smartlead' or (w.kind = 'email' and w.value = any(v_still_blocked)) then now() end
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
      and (
        p.contact_id = any(v_contacts)
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

  v_result := jsonb_build_object('changed', not v_already, 'stopping', v_stopping, 'skipped', coalesce(v_skipped, 0));
  if p_audit is not null and (v_result ->> 'changed')::boolean then
    perform private.suppression_audit(p_workspace, p_audit, jsonb_build_object(
      'stopped', jsonb_array_length(v_result -> 'stopping'),
      'skipped', (v_result ->> 'skipped')::integer
    ));
  end if;
  return v_result;
end;
$$;

create or replace function private.suppression_lift_person(p_workspace uuid, p_contacts uuid[], p_emails text[], p_linkedins text[], p_audit jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contacts uuid[];
  v_emails text[];
  v_linkedins text[];
  v_targets uuid[];
  v_lifted jsonb;
  v_replied boolean;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_contacts := array(select distinct x from unnest(coalesce(p_contacts, '{}'::uuid[])) x where x is not null);
  v_emails := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_emails, '{}'::text[])) x where nullif(btrim(x), '') is not null);
  v_linkedins := array(select distinct nullif(btrim(x), '') from unnest(coalesce(p_linkedins, '{}'::text[])) x where nullif(btrim(x), '') is not null);
  select coalesce(array_agg(t.id order by t.id), '{}'::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'value', t.value, 'reason', t.reason) order by t.kind, t.value), '[]'::jsonb)
  into v_targets, v_lifted
  from (
    select s.id, s.kind, s.value, s.reason
    from crm.suppressions s
    where s.workspace_id = p_workspace and s.reason in ('manual', 'unsubscribed')
      and (
        s.contact_id = any(v_contacts)
        or (s.kind = 'email' and s.value = any(v_emails))
        or (s.kind = 'linkedin' and s.value = any(v_linkedins))
      )
    order by s.id
    for update
  ) t;
  if cardinality(v_targets) = 0 then
    return v_lifted;
  end if;
  insert into crm.campaign_block_lifts as b (workspace_id, value)
  select p_workspace, s.value
  from crm.suppressions s
  where s.id = any(v_targets) and s.bounced_at is null and s.kind = 'email' and s.blocked_at is not null and s.source <> 'smartlead'
  on conflict on constraint campaign_block_lifts_unique do update set attempts = 0, last_tried_at = null;
  delete from crm.suppressions s where s.id = any(v_targets) and s.bounced_at is null;
  update crm.suppressions s
  set reason = 'bounced', created_at = s.bounced_at, created_by_user_id = null, created_by_agent_id = null
  where s.id = any(v_targets) and s.bounced_at is not null;
  select exists (
    select 1 from crm.campaign_prospects p
    where p.workspace_id = p_workspace and p.replied_at is not null
      and (
        p.contact_id = any(v_contacts)
        or p.email = any(v_emails)
        or p.linkedin = any(v_linkedins)
      )
  ) into v_replied;
  update crm.campaign_prospects p
  set stop_requested_at = case when v_replied then p.stop_requested_at end,
      stop_reason = case when v_replied then 'replied' end
  where p.workspace_id = p_workspace and p.stop_reason = 'suppressed' and p.stopped_at is null
    and (
      p.contact_id = any(v_contacts)
      or p.email = any(v_emails)
      or p.linkedin = any(v_linkedins)
    )
    and not exists (
      select 1
      from crm.suppressions s
      left join crm.contacts c on c.id = p.contact_id and c.workspace_id = p.workspace_id
      where s.workspace_id = p.workspace_id and s.reason <> 'bounced'
        and (
          (p.contact_id is not null and s.contact_id = p.contact_id)
          or (s.kind = 'email' and s.value in (p.email, c.normalized_email))
          or (s.kind = 'linkedin' and s.value in (p.linkedin, c.normalized_linkedin))
        )
    );
  if p_audit is not null then
    perform private.suppression_audit(p_workspace, p_audit, jsonb_build_object('lifted', v_lifted));
  end if;
  return v_lifted;
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
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_contact is not null then
    select c.normalized_email, c.normalized_linkedin into v_contact_email, v_contact_linkedin
    from crm.contacts c where c.id = p_contact and c.workspace_id = p_workspace;
  end if;
  return private.suppression_lift_person(
    p_workspace,
    array_remove(array[p_contact], null),
    coalesce(p_emails, '{}'::text[]) || v_contact_email,
    coalesce(p_linkedins, '{}'::text[]) || v_contact_linkedin,
    p_audit
  );
end;
$$;

revoke all on function private.suppress_person_group(uuid, uuid[], text[], text[], text, text, uuid, uuid, jsonb) from public;
revoke all on function private.suppression_lift_person(uuid, uuid[], text[], text[], jsonb) from public;
revoke all on function private.suppression_lift(uuid, uuid, text[], text[], jsonb) from public;
grant execute on function private.suppress_person_group(uuid, uuid[], text[], text[], text, text, uuid, uuid, jsonb) to crm_app;
grant execute on function private.suppression_lift_person(uuid, uuid[], text[], text[], jsonb) to crm_app;
grant execute on function private.suppression_lift(uuid, uuid, text[], text[], jsonb) to crm_app;

reset lock_timeout;

create index concurrently if not exists campaign_messages_workspace_idx on crm.campaign_messages (workspace_id, prospect_id, sent_at);
