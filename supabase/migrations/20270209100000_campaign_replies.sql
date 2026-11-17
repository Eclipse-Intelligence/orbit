set lock_timeout = '5s';

alter table crm.webhook_receipts drop constraint if exists webhook_receipts_source;
alter table crm.webhook_receipts
  add constraint webhook_receipts_source check (source in ('granola', 'clickup', 'smartlead', 'heyreach'));

alter table crm.campaign_prospects add column if not exists stop_reason text;
alter table crm.campaign_prospects add column if not exists sync_claimed_at timestamptz;
alter table crm.campaign_prospects add column if not exists thread_fetched_at timestamptz;
alter table crm.campaign_prospects drop constraint if exists campaign_prospects_stop_reason;
alter table crm.campaign_prospects
  add constraint campaign_prospects_stop_reason check (stop_reason is null or stop_reason in ('replied', 'removed'));

alter table crm.campaign_events add column if not exists claimed_at timestamptz;
alter table crm.campaign_events add column if not exists fired_at timestamptz;
alter table crm.campaign_events add column if not exists counted_at timestamptz;

create table if not exists crm.campaign_event_tombstones (
  campaign_id uuid not null references crm.campaigns (id) on delete cascade,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  constraint campaign_event_tombstones_pkey primary key (campaign_id, dedupe_key),
  constraint campaign_event_tombstones_key_length check (char_length(dedupe_key) between 1 and 500)
);

alter table crm.campaign_event_tombstones enable row level security;
alter table crm.campaign_event_tombstones force row level security;
revoke all on crm.campaign_event_tombstones from anon, authenticated, crm_agent;

create table if not exists crm.campaign_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  campaign_id uuid not null,
  prospect_id uuid not null references crm.campaign_prospects (id) on delete cascade,
  channel text not null,
  direction text not null,
  step integer,
  subject text,
  body text not null default '',
  sent_at timestamptz not null,
  external_id text,
  conversation_id text,
  sender_id text,
  stats_id text,
  provider_message_id text,
  from_address text,
  automatic boolean not null default false,
  send_state text,
  send_error text,
  client_key text,
  sent_by_user_id uuid references crm.profiles (id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_messages_campaign_fk foreign key (campaign_id, workspace_id)
    references crm.campaigns (id, workspace_id) on delete cascade,
  constraint campaign_messages_channel check (channel in ('email', 'linkedin')),
  constraint campaign_messages_direction check (direction in ('inbound', 'outbound')),
  constraint campaign_messages_send_state check (send_state is null or send_state in ('sending', 'sent', 'unknown', 'failed')),
  constraint campaign_messages_text_lengths check (
    char_length(body) <= 100000
    and (subject is null or char_length(subject) <= 1000)
    and (external_id is null or char_length(external_id) between 1 and 300)
    and (conversation_id is null or char_length(conversation_id) <= 200)
    and (sender_id is null or char_length(sender_id) <= 200)
    and (stats_id is null or char_length(stats_id) <= 200)
    and (provider_message_id is null or char_length(provider_message_id) <= 500)
    and (from_address is null or char_length(from_address) <= 320)
    and (send_error is null or char_length(send_error) <= 500)
    and (client_key is null or char_length(client_key) between 1 and 200)
  )
);

create unique index if not exists campaign_messages_external_uidx
  on crm.campaign_messages (campaign_id, external_id) where external_id is not null;
create unique index if not exists campaign_messages_client_key_uidx
  on crm.campaign_messages (workspace_id, client_key) where client_key is not null;
create index if not exists campaign_messages_prospect_idx on crm.campaign_messages (prospect_id, sent_at);

drop trigger if exists campaign_messages_set_updated_at on crm.campaign_messages;
create trigger campaign_messages_set_updated_at
  before update on crm.campaign_messages
  for each row execute function private.set_updated_at();

alter table crm.campaign_messages enable row level security;
alter table crm.campaign_messages force row level security;

drop policy if exists campaign_messages_select_member on crm.campaign_messages;
create policy campaign_messages_select_member on crm.campaign_messages
  for select to authenticated using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists campaign_messages_select_agent on crm.campaign_messages;
create policy campaign_messages_select_agent on crm.campaign_messages
  for select to crm_agent using (workspace_id = (select private.request_workspace_id()));

revoke all on crm.campaign_messages from anon, authenticated, crm_agent;
grant select on crm.campaign_messages to authenticated, crm_agent;

create or replace function private.campaign_webhook_secret(p_workspace uuid, p_provider text, p_new text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_connections c
  set webhook_secret = coalesce(c.webhook_secret, nullif(p_new, ''))
  where c.workspace_id = p_workspace and c.provider = p_provider
  returning c.webhook_secret into v_secret;
  return v_secret;
end;
$$;

create or replace function private.campaign_webhook_check(p_workspace uuid, p_provider text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select c.webhook_secret into v_secret
  from crm.campaign_connections c
  where c.workspace_id = p_workspace and c.provider = p_provider;
  return v_secret;
end;
$$;

create or replace function private.campaign_webhook_receipt(p_workspace uuid, p_source text, p_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_source not in ('smartlead', 'heyreach') or char_length(coalesce(p_key, '')) not between 1 and 200 then
    raise exception 'Unknown webhook receipt.' using errcode = '22023';
  end if;
  delete from crm.webhook_receipts r
  where r.workspace_id = p_workspace and r.source = p_source and r.received_at < now() - interval '7 days';
  insert into crm.webhook_receipts (workspace_id, source, message_id)
  values (p_workspace, p_source, p_key)
  on conflict (workspace_id, source, message_id) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

create or replace function private.campaign_request_sync(
  p_workspace uuid,
  p_provider text,
  p_campaign text,
  p_lead text,
  p_email text,
  p_linkedin text
)
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
  if p_lead is null and p_email is null and p_linkedin is null then
    return 0;
  end if;
  update crm.campaign_prospects p
  set sync_requested_at = now()
  from crm.campaigns k
  where k.id = p.campaign_id
    and k.workspace_id = p_workspace
    and p.workspace_id = p_workspace
    and k.provider = p_provider
    and (p_campaign is null or k.external_id = p_campaign)
    and p.state = 'pushed'
    and (
      (p_lead is not null and p.external_lead_id = p_lead)
      or (p_email is not null and p.email = p_email)
      or (p_linkedin is not null and p.linkedin = p_linkedin)
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function private.campaign_claim_requested(p_workspace uuid, p_provider text, p_limit integer)
returns table (
  prospect_id uuid,
  campaign_id uuid,
  campaign_external_id text,
  sender_ids text[],
  external_lead_id text,
  email text,
  linkedin text,
  sender_id text,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  with chosen as (
    select p.id
    from crm.campaign_prospects p
    join crm.campaigns k on k.id = p.campaign_id
    where p.workspace_id = p_workspace and k.provider = p_provider
      and p.sync_requested_at is not null
      and (p.sync_claimed_at is null or p.sync_claimed_at < now() - interval '5 minutes')
    order by p.sync_requested_at, p.id
    limit least(greatest(p_limit, 1), 100)
    for update of p skip locked
  ),
  claimed as (
    update crm.campaign_prospects p
    set sync_claimed_at = now()
    from chosen
    where p.id = chosen.id
    returning p.id, p.campaign_id, p.external_lead_id, p.email, p.linkedin, p.sender_id, p.sync_requested_at
  )
  select c.id, c.campaign_id, k.external_id, k.sender_ids, c.external_lead_id, c.email, c.linkedin, c.sender_id, c.sync_requested_at
  from claimed c
  join crm.campaigns k on k.id = c.campaign_id;
end;
$$;

create or replace function private.campaign_thread_fetched(p_prospect uuid, p_requested_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set thread_fetched_at = now(),
      sync_claimed_at = case when p_requested_at is null then p.sync_claimed_at end,
      sync_requested_at = case
        when p_requested_at is not null and date_trunc('milliseconds', p.sync_requested_at) <= p_requested_at then null
        else p.sync_requested_at
      end
  where p.id = p_prospect;
end;
$$;

create or replace function private.campaign_find_prospect(p_campaign uuid, p_lead text, p_linkedin text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_lead is not null then
    select p.id into v_id from crm.campaign_prospects p
    where p.campaign_id = p_campaign and p.external_lead_id = p_lead;
  end if;
  if v_id is null and p_linkedin is not null then
    select p.id into v_id from crm.campaign_prospects p
    where p.campaign_id = p_campaign and p.linkedin = p_linkedin
    order by p.external_lead_id is null, p.created_at
    limit 1;
  end if;
  return v_id;
end;
$$;

create or replace function private.campaign_sync_messages(
  p_prospect uuid,
  p_messages jsonb,
  p_reply_events boolean,
  p_handled boolean
)
returns table (message_id uuid, direction text, automatic boolean, sent_at timestamptz, event_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_prospect crm.campaign_prospects%rowtype;
  v_campaign crm.campaigns%rowtype;
  v_message record;
  v_sender text;
  v_id uuid;
  v_event uuid;
  v_confirmed uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_prospect from crm.campaign_prospects p where p.id = p_prospect for update;
  if not found or v_prospect.state <> 'pushed' then
    return;
  end if;
  select * into v_campaign from crm.campaigns k where k.id = v_prospect.campaign_id;
  v_sender := v_prospect.sender_id;
  for v_message in
    select left(nullif(x.external_id, ''), 300) as external_id,
      x.direction,
      x.step,
      left(x.subject, 1000) as subject,
      left(coalesce(x.body, ''), 100000) as body,
      x.sent_at,
      left(nullif(x.conversation_id, ''), 200) as conversation_id,
      left(nullif(x.sender_id, ''), 200) as sender_id,
      left(nullif(x.stats_id, ''), 200) as stats_id,
      left(nullif(x.provider_message_id, ''), 500) as provider_message_id,
      left(nullif(x.from_address, ''), 320) as from_address,
      coalesce(x.automatic, false) as automatic,
      left(nullif(x.reply_key, ''), 500) as reply_key
    from jsonb_to_recordset(coalesce(p_messages, '[]'::jsonb))
      as x(external_id text, direction text, step integer, subject text, body text, sent_at timestamptz,
           conversation_id text, sender_id text, stats_id text, provider_message_id text, from_address text,
           automatic boolean, reply_key text)
    where x.sent_at is not null and x.direction in ('inbound', 'outbound') and coalesce(x.external_id, '') <> ''
    order by x.sent_at
  loop
    if v_campaign.channel = 'linkedin' then
      if v_prospect.pushed_at is null or v_message.sent_at <= v_prospect.pushed_at or v_message.sender_id is null then
        continue;
      end if;
      if v_sender is null then
        if not (v_message.sender_id = any(v_campaign.sender_ids)) then
          continue;
        end if;
        v_sender := v_message.sender_id;
        update crm.campaign_prospects p set sender_id = v_sender where p.id = p_prospect and p.sender_id is null;
      end if;
      if v_message.sender_id is distinct from v_sender then
        continue;
      end if;
    end if;

    v_confirmed := null;
    if v_message.direction = 'outbound'
      and not exists (select 1 from crm.campaign_messages m where m.campaign_id = v_campaign.id and m.external_id = v_message.external_id) then
      select m.id into v_confirmed
      from crm.campaign_messages m
      where m.prospect_id = p_prospect
        and m.send_state in ('sending', 'sent', 'unknown')
        and m.external_id is null
        and char_length(btrim(m.body)) > 0
        and strpos(
          regexp_replace(lower(v_message.body), '\s+', ' ', 'g'),
          btrim(regexp_replace(lower(m.body), '\s+', ' ', 'g'))
        ) > 0
        and m.created_at between v_message.sent_at - interval '1 day' and v_message.sent_at + interval '2 minutes'
      order by abs(extract(epoch from (m.created_at - v_message.sent_at))), m.created_at
      limit 1
      for update;
      if v_confirmed is not null then
        update crm.campaign_messages m
        set external_id = v_message.external_id,
            send_state = 'sent',
            confirmed_at = now(),
            sent_at = v_message.sent_at,
            conversation_id = coalesce(m.conversation_id, v_message.conversation_id),
            sender_id = coalesce(m.sender_id, v_message.sender_id),
            stats_id = coalesce(m.stats_id, v_message.stats_id),
            provider_message_id = coalesce(m.provider_message_id, v_message.provider_message_id),
            from_address = coalesce(m.from_address, v_message.from_address),
            send_error = null
        where m.id = v_confirmed;
        continue;
      end if;
    end if;

    v_id := null;
    insert into crm.campaign_messages as m (
      workspace_id, campaign_id, prospect_id, channel, direction, step, subject, body, sent_at,
      external_id, conversation_id, sender_id, stats_id, provider_message_id, from_address, automatic
    ) values (
      v_prospect.workspace_id, v_campaign.id, p_prospect, v_campaign.channel, v_message.direction, v_message.step,
      v_message.subject, v_message.body, v_message.sent_at, v_message.external_id, v_message.conversation_id,
      v_message.sender_id, v_message.stats_id, v_message.provider_message_id, v_message.from_address, v_message.automatic
    )
    on conflict (campaign_id, external_id) where external_id is not null do nothing
    returning m.id into v_id;
    if v_id is null then
      continue;
    end if;

    v_event := null;
    if p_reply_events and v_message.direction = 'inbound' and not v_message.automatic and v_message.reply_key is not null then
      insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, step, occurred_at, dedupe_key, payload, handled_at)
      values (
        v_prospect.workspace_id, v_campaign.id, p_prospect, 'replied', v_message.step, v_message.sent_at, v_message.reply_key,
        jsonb_strip_nulls(jsonb_build_object('messageId', v_id, 'conversationId', v_message.conversation_id, 'senderId', v_message.sender_id)),
        case when p_handled or v_campaign.backfilled_at is null or v_message.sent_at < v_campaign.backfilled_at then now() end
      )
      on conflict on constraint campaign_events_dedupe do nothing
      returning e.id into v_event;
      update crm.campaign_prospects p
      set replied_at = least(coalesce(p.replied_at, v_message.sent_at), v_message.sent_at)
      where p.id = p_prospect and (p.replied_at is null or p.replied_at > v_message.sent_at);
    end if;
    update crm.campaign_prospects p
    set last_event_at = greatest(p.last_event_at, v_message.sent_at)
    where p.id = p_prospect and p.last_event_at is distinct from greatest(p.last_event_at, v_message.sent_at);

    message_id := v_id;
    direction := v_message.direction;
    automatic := v_message.automatic;
    sent_at := v_message.sent_at;
    event_id := v_event;
    return next;
  end loop;
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

    v_inserted := null;
    insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, step, variant, occurred_at, dedupe_key, payload, handled_at)
    values (v_campaign.workspace_id, p_campaign, v_prospect, v_event.kind, v_event.step, v_event.variant,
      v_event.occurred_at, v_event.dedupe_key, v_event.payload, case when p_handled then now() end)
    on conflict on constraint campaign_events_dedupe do nothing
    returning e.id into v_inserted;

    update crm.campaign_prospects p
    set last_event_at = greatest(p.last_event_at, v_event.occurred_at),
        replied_at = case when v_event.kind = 'replied' then least(coalesce(p.replied_at, v_event.occurred_at), v_event.occurred_at) else p.replied_at end,
        category = case
          when v_campaign.provider = 'heyreach' then coalesce(p.category, v_event.category)
          else coalesce(v_event.category, p.category)
        end
    where p.id = v_prospect
      and (
        p.last_event_at is distinct from greatest(p.last_event_at, v_event.occurred_at)
        or (v_event.kind = 'replied' and (p.replied_at is null or p.replied_at > v_event.occurred_at))
        or (v_event.category is not null and v_campaign.provider <> 'heyreach' and p.category is distinct from v_event.category)
        or (v_event.category is not null and v_campaign.provider = 'heyreach' and p.category is null)
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

create or replace function private.campaign_mark_engaged(p_campaign uuid, p_since timestamptz, p_handled boolean)
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
  insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key, payload, handled_at)
  select p.workspace_id, p.campaign_id, p.id, 'engaged',
    least(o.second_open, c.first_click), 'engaged:' || p.id::text,
    jsonb_build_object('rule', case when o.second_open is not null and (c.first_click is null or o.second_open <= c.first_click) then 'opened_twice' else 'clicked' end),
    case when p_handled then now() end
  from crm.campaign_prospects p
  join crm.campaigns k on k.id = p.campaign_id and k.channel = 'email'
  left join lateral (
    select e.occurred_at as second_open
    from crm.campaign_events e
    where e.prospect_id = p.id and e.kind = 'opened'
    order by e.occurred_at
    offset 1 limit 1
  ) o on true
  left join lateral (
    select min(e.occurred_at) as first_click
    from crm.campaign_events e
    where e.prospect_id = p.id and e.kind = 'clicked'
      and exists (
        select 1 from crm.campaign_events s
        where s.prospect_id = p.id and s.kind = 'sent' and s.step is not distinct from e.step
          and e.occurred_at > s.occurred_at + interval '1 minute'
      )
  ) c on true
  where p.campaign_id = p_campaign
    and (p_since is null or p.last_event_at >= p_since)
    and (o.second_open is not null or c.first_click is not null)
    and not exists (select 1 from crm.campaign_events x where x.prospect_id = p.id and x.kind = 'engaged')
  on conflict on constraint campaign_events_dedupe do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function private.campaign_claim_events(p_campaign uuid, p_limit integer)
returns table (event_id uuid, prospect_id uuid, contact_id uuid, kind text, occurred_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  with chosen as (
    select e.id
    from crm.campaign_events e
    where e.campaign_id = p_campaign and e.handled_at is null
      and (e.claimed_at is null or e.claimed_at < now() - interval '5 minutes')
    order by e.created_at, e.id
    limit least(greatest(p_limit, 1), 1000)
    for update skip locked
  ),
  claimed as (
    update crm.campaign_events e
    set claimed_at = now()
    from chosen
    where e.id = chosen.id
    returning e.id, e.prospect_id, e.kind, e.occurred_at, e.created_at
  )
  select c.id, c.prospect_id, p.contact_id, c.kind, c.occurred_at
  from claimed c
  join crm.campaign_prospects p on p.id = c.prospect_id
  order by c.created_at, c.id;
end;
$$;

create or replace function private.campaign_events_release(p_campaign uuid, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_events e set claimed_at = null
  where e.campaign_id = p_campaign and e.id = any(p_ids) and e.handled_at is null;
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
      and e.kind in ('added', 'replied', 'category', 'engaged', 'bounced', 'unsubscribed', 'invite_accepted')
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

create or replace function private.campaign_reply_uncount(p_event uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prospect uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with gone as (
    delete from crm.campaign_events e
    where e.id = p_event and e.kind = 'replied' and e.counted_at is null
    returning e.prospect_id, e.campaign_id, e.dedupe_key
  ),
  kept as (
    insert into crm.campaign_event_tombstones (campaign_id, dedupe_key)
    select gone.campaign_id, gone.dedupe_key from gone
    on conflict on constraint campaign_event_tombstones_pkey do nothing
  )
  select gone.prospect_id into v_prospect from gone;
  if v_prospect is null then
    return false;
  end if;
  update crm.campaign_prospects p
  set replied_at = (select min(e.occurred_at) from crm.campaign_events e where e.prospect_id = p.id and e.kind = 'replied')
  where p.id = v_prospect;
  return true;
end;
$$;

create or replace function private.campaign_reply_counted(p_event uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_events e set counted_at = now()
  where e.id = p_event and e.kind = 'replied' and e.counted_at is null;
end;
$$;

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
  set sync_state = k.sync_state - 'webhookId' - 'webhookFailedAt'
  where k.workspace_id = p_workspace and k.provider = p_provider
    and (k.sync_state ? 'webhookId' or k.sync_state ? 'webhookFailedAt');
end;
$$;

create or replace function private.campaign_stop_person(p_workspace uuid, p_prospect uuid)
returns table (prospect_id uuid, campaign_id uuid, campaign_name text, action text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_source crm.campaign_prospects%rowtype;
  v_email text;
  v_linkedin text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_source from crm.campaign_prospects p where p.id = p_prospect and p.workspace_id = p_workspace;
  if not found then
    return;
  end if;
  select c.normalized_email, c.normalized_linkedin into v_email, v_linkedin
  from crm.contacts c where c.id = v_source.contact_id and c.workspace_id = p_workspace;
  return query
  with person as (
    select p.id
    from crm.campaign_prospects p
    join crm.campaigns k on k.id = p.campaign_id
    where p.workspace_id = p_workspace
      and p.id <> p_prospect
      and (
        (v_source.contact_id is not null and p.contact_id = v_source.contact_id)
        or (v_source.email is not null and p.email = v_source.email)
        or (v_source.linkedin is not null and p.linkedin = v_source.linkedin)
        or (v_email is not null and p.email = v_email)
        or (v_linkedin is not null and p.linkedin = v_linkedin)
      )
      and private.campaign_prospect_active(p.state, p.stopped_at, p.lead_status, k.status)
      and p.stop_requested_at is null
    for update of p
  ),
  changed as (
    update crm.campaign_prospects p
    set state = case when p.state in ('queued', 'filling') then 'skipped' else p.state end,
        skip_reason = case when p.state in ('queued', 'filling') then 'Already replied' else p.skip_reason end,
        claimed_at = case when p.state in ('queued', 'filling') then null else p.claimed_at end,
        stop_requested_at = case when p.state in ('pushing', 'pushed') then now() else p.stop_requested_at end,
        stop_reason = case when p.state in ('pushing', 'pushed') then 'replied' else p.stop_reason end
    from person
    where p.id = person.id
    returning p.id, p.campaign_id, case when p.state = 'skipped' then 'skipped' else 'stopping' end as action
  )
  select c.id, c.campaign_id, k.name, c.action
  from changed c
  join crm.campaigns k on k.id = c.campaign_id;
end;
$$;

create or replace function private.campaign_pending_stops(p_workspace uuid, p_provider text, p_limit integer)
returns table (
  prospect_id uuid,
  campaign_id uuid,
  campaign_external_id text,
  external_lead_id text,
  email text,
  linkedin text,
  sender_id text,
  stop_reason text
)
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
  select p.id, p.campaign_id, k.external_id, p.external_lead_id, p.email, p.linkedin, p.sender_id, p.stop_reason
  from crm.campaign_prospects p
  join crm.campaigns k on k.id = p.campaign_id
  where p.workspace_id = p_workspace and k.provider = p_provider
    and p.stop_requested_at is not null and p.stopped_at is null
    and p.state = 'pushed'
  order by p.stop_requested_at, p.id
  limit least(greatest(p_limit, 1), 500);
end;
$$;

create or replace function private.campaign_stop_confirmed(p_workspace uuid, p_prospect uuid, p_lead_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set stopped_at = coalesce(p.stopped_at, now()),
      lead_status = coalesce(left(nullif(p_lead_status, ''), 100), p.lead_status)
  where p.id = p_prospect and p.workspace_id = p_workspace and p.stop_requested_at is not null;
end;
$$;

create or replace function private.campaign_prospect_remove(p_workspace uuid, p_prospect uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_stopped timestamptz;
  v_reason text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select p.state, p.stopped_at, p.stop_reason into v_state, v_stopped, v_reason from crm.campaign_prospects p
  where p.id = p_prospect and p.workspace_id = p_workspace
  for update;
  if not found then
    return null;
  end if;
  if v_state in ('skipped', 'failed') or v_stopped is not null or v_reason = 'removed' then
    return 'unchanged';
  end if;
  update crm.campaign_prospects p
  set state = case when p.state in ('queued', 'filling') then 'skipped' else p.state end,
      skip_reason = case when p.state in ('queued', 'filling') then 'Removed' else p.skip_reason end,
      claimed_at = case when p.state in ('queued', 'filling') then null else p.claimed_at end,
      stop_requested_at = case when p.state in ('pushing', 'pushed') and p.stopped_at is null then coalesce(p.stop_requested_at, now()) else p.stop_requested_at end,
      stop_reason = case when p.state in ('pushing', 'pushed') and p.stopped_at is null then 'removed' else p.stop_reason end
  where p.id = p_prospect;
  return v_state;
end;
$$;

create or replace function private.campaign_prospect_lead_status(p_workspace uuid, p_prospect uuid, p_lead_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.campaign_prospects p
  set lead_status = left(nullif(p_lead_status, ''), 100)
  where p.id = p_prospect and p.workspace_id = p_workspace;
end;
$$;

create or replace function private.campaign_status_set(p_workspace uuid, p_campaign uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status not in ('active', 'paused') then
    raise exception 'Pick a campaign status.' using errcode = '22023';
  end if;
  update crm.campaigns k set status = p_status where k.id = p_campaign and k.workspace_id = p_workspace;
end;
$$;

create or replace function private.campaign_set_category(
  p_workspace uuid,
  p_prospect uuid,
  p_category text,
  p_dedupe text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prospect crm.campaign_prospects%rowtype;
  v_event uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_prospect from crm.campaign_prospects p
  where p.id = p_prospect and p.workspace_id = p_workspace
  for update;
  if not found then
    return null;
  end if;
  update crm.campaign_prospects p
  set category = left(nullif(btrim(p_category), ''), 200)
  where p.id = p_prospect;
  if nullif(btrim(p_category), '') is null then
    return null;
  end if;
  insert into crm.campaign_events as e (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key, payload, claimed_at)
  values (p_workspace, v_prospect.campaign_id, p_prospect, 'category', now(), left(p_dedupe, 500),
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('category', left(btrim(p_category), 200)), now())
  on conflict on constraint campaign_events_dedupe do nothing
  returning e.id into v_event;
  return v_event;
end;
$$;

create or replace function private.campaign_reply_begin(
  p_workspace uuid,
  p_prospect uuid,
  p_user uuid,
  p_body text,
  p_client_key text,
  p_reply jsonb
)
returns table (message_id uuid, send_state text, created boolean, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_prospect crm.campaign_prospects%rowtype;
  v_campaign crm.campaigns%rowtype;
  v_existing crm.campaign_messages%rowtype;
  v_id uuid;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_prospect from crm.campaign_prospects p where p.id = p_prospect and p.workspace_id = p_workspace;
  if not found then
    raise exception 'Prospect not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from crm.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user) then
    raise exception 'Only people in this workspace can reply.' using errcode = '42501';
  end if;
  select * into v_campaign from crm.campaigns k where k.id = v_prospect.campaign_id;
  perform pg_advisory_xact_lock(hashtextextended('campaign-reply|' || p_workspace::text || '|' || p_client_key, 0));
  select * into v_existing from crm.campaign_messages m
  where m.workspace_id = p_workspace and m.client_key = p_client_key
  for update;
  if found then
    if v_existing.prospect_id <> p_prospect or v_existing.sent_by_user_id is distinct from p_user then
      raise exception 'That reply belongs to another thread.' using errcode = '22023';
    end if;
    if v_existing.send_state = 'sending' and v_existing.created_at < now() - interval '5 minutes' then
      update crm.campaign_messages m
      set send_state = 'unknown', send_error = 'May not have gone.'
      where m.id = v_existing.id;
      v_existing.send_state := 'unknown';
    end if;
    if v_existing.send_state = 'failed' then
      update crm.campaign_messages m
      set send_state = 'sending', send_error = null, body = left(p_body, 100000), created_at = now()
      where m.id = v_existing.id;
      message_id := v_existing.id;
      send_state := 'sending';
      created := true;
      created_at := now();
      return next;
      return;
    end if;
    message_id := v_existing.id;
    send_state := v_existing.send_state;
    created := false;
    created_at := v_existing.created_at;
    return next;
    return;
  end if;
  insert into crm.campaign_messages as m (
    workspace_id, campaign_id, prospect_id, channel, direction, subject, body, sent_at,
    conversation_id, sender_id, stats_id, send_state, client_key, sent_by_user_id
  ) values (
    p_workspace, v_campaign.id, p_prospect, v_campaign.channel, 'outbound',
    left(nullif(p_reply ->> 'subject', ''), 1000), left(p_body, 100000), now(),
    left(nullif(p_reply ->> 'conversationId', ''), 200), left(nullif(p_reply ->> 'senderId', ''), 200),
    left(nullif(p_reply ->> 'statsId', ''), 200), 'sending', p_client_key, p_user
  )
  returning m.id into v_id;
  message_id := v_id;
  send_state := 'sending';
  created := true;
  created_at := now();
  return next;
end;
$$;

create or replace function private.campaign_reply_finish(
  p_workspace uuid,
  p_message uuid,
  p_state text,
  p_provider_message_id text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_state not in ('sent', 'unknown', 'failed') then
    raise exception 'Unknown send state.' using errcode = '22023';
  end if;
  update crm.campaign_messages m
  set send_state = case when m.confirmed_at is not null then 'sent' else p_state end,
      provider_message_id = coalesce(m.provider_message_id, left(nullif(p_provider_message_id, ''), 500)),
      send_error = case when p_state = 'sent' then null else left(p_error, 500) end,
      sent_at = case when p_state = 'sent' and m.confirmed_at is null then now() else m.sent_at end
  where m.id = p_message and m.workspace_id = p_workspace and m.send_state = 'sending';
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
    'campaign_prospects_combined', prospects_combined
  );
end;
$$;

revoke all on function private.campaign_webhook_secret(uuid, text, text) from public;
revoke all on function private.campaign_webhook_check(uuid, text) from public;
revoke all on function private.campaign_webhook_receipt(uuid, text, text) from public;
revoke all on function private.campaign_request_sync(uuid, text, text, text, text, text) from public;
revoke all on function private.campaign_claim_requested(uuid, text, integer) from public;
revoke all on function private.campaign_thread_fetched(uuid, timestamptz) from public;
revoke all on function private.campaign_find_prospect(uuid, text, text) from public;
revoke all on function private.campaign_sync_messages(uuid, jsonb, boolean, boolean) from public;
revoke all on function private.campaign_sync_events(uuid, jsonb, boolean) from public;
revoke all on function private.campaign_mark_engaged(uuid, timestamptz, boolean) from public;
revoke all on function private.campaign_claim_events(uuid, integer) from public;
revoke all on function private.campaign_events_release(uuid, uuid[]) from public;
revoke all on function private.campaign_fire_events(uuid[]) from public;
revoke all on function private.campaign_reply_uncount(uuid) from public;
revoke all on function private.campaign_reply_counted(uuid) from public;
revoke all on function private.campaign_forget_webhooks(uuid, text) from public;
revoke all on function private.campaign_stop_person(uuid, uuid) from public;
revoke all on function private.campaign_pending_stops(uuid, text, integer) from public;
revoke all on function private.campaign_stop_confirmed(uuid, uuid, text) from public;
revoke all on function private.campaign_prospect_remove(uuid, uuid) from public;
revoke all on function private.campaign_prospect_lead_status(uuid, uuid, text) from public;
revoke all on function private.campaign_status_set(uuid, uuid, text) from public;
revoke all on function private.campaign_set_category(uuid, uuid, text, text, jsonb) from public;
revoke all on function private.campaign_reply_begin(uuid, uuid, uuid, text, text, jsonb) from public;
revoke all on function private.campaign_reply_finish(uuid, uuid, text, text, text) from public;
revoke all on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) from public;

grant execute on function private.campaign_webhook_secret(uuid, text, text) to crm_app;
grant execute on function private.campaign_webhook_check(uuid, text) to crm_app;
grant execute on function private.campaign_webhook_receipt(uuid, text, text) to crm_app;
grant execute on function private.campaign_request_sync(uuid, text, text, text, text, text) to crm_app;
grant execute on function private.campaign_claim_requested(uuid, text, integer) to crm_app;
grant execute on function private.campaign_thread_fetched(uuid, timestamptz) to crm_app;
grant execute on function private.campaign_find_prospect(uuid, text, text) to crm_app;
grant execute on function private.campaign_sync_messages(uuid, jsonb, boolean, boolean) to crm_app;
grant execute on function private.campaign_sync_events(uuid, jsonb, boolean) to crm_app;
grant execute on function private.campaign_mark_engaged(uuid, timestamptz, boolean) to crm_app;
grant execute on function private.campaign_claim_events(uuid, integer) to crm_app;
grant execute on function private.campaign_events_release(uuid, uuid[]) to crm_app;
grant execute on function private.campaign_fire_events(uuid[]) to crm_app;
grant execute on function private.campaign_reply_uncount(uuid) to crm_app;
grant execute on function private.campaign_reply_counted(uuid) to crm_app;
grant execute on function private.campaign_forget_webhooks(uuid, text) to crm_app;
grant execute on function private.campaign_stop_person(uuid, uuid) to crm_app;
grant execute on function private.campaign_pending_stops(uuid, text, integer) to crm_app;
grant execute on function private.campaign_stop_confirmed(uuid, uuid, text) to crm_app;
grant execute on function private.campaign_prospect_remove(uuid, uuid) to crm_app;
grant execute on function private.campaign_prospect_lead_status(uuid, uuid, text) to crm_app;
grant execute on function private.campaign_status_set(uuid, uuid, text) to crm_app;
grant execute on function private.campaign_set_category(uuid, uuid, text, text, jsonb) to crm_app;
grant execute on function private.campaign_reply_begin(uuid, uuid, uuid, text, text, jsonb) to crm_app;
grant execute on function private.campaign_reply_finish(uuid, uuid, text, text, text) to crm_app;
grant execute on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) to crm_app;

reset lock_timeout;

create index concurrently if not exists campaign_prospects_sync_requested_idx on crm.campaign_prospects (workspace_id, sync_requested_at) where sync_requested_at is not null;

create index concurrently if not exists campaign_prospects_stopping_idx on crm.campaign_prospects (workspace_id, stop_requested_at) where stop_requested_at is not null and stopped_at is null;

create index concurrently if not exists campaign_prospects_email_person_idx on crm.campaign_prospects (workspace_id, email) where email is not null;

create index concurrently if not exists campaign_prospects_linkedin_person_idx on crm.campaign_prospects (workspace_id, linkedin) where linkedin is not null;
