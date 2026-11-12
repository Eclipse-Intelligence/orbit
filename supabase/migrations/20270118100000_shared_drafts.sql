set lock_timeout = '5s';

alter table crm.mail_shares alter column thread_key drop not null;
alter table crm.mail_shares add column if not exists draft_id uuid references crm.mail_drafts (id) on delete set null;
alter table crm.mail_shares add column if not exists draft_state text;
alter table crm.mail_shares add column if not exists draft_held_until timestamptz;
alter table crm.mail_shares add column if not exists draft_version integer not null default 0;
alter table crm.mail_shares add column if not exists sent_internet_id text;

alter table crm.mail_shares drop constraint if exists mail_shares_draft_state_check;
alter table crm.mail_shares add constraint mail_shares_draft_state_check check (draft_state is null or draft_state in ('sent', 'discarded'));

alter table crm.mail_shares drop constraint if exists mail_shares_sent_internet_id_check;
alter table crm.mail_shares add constraint mail_shares_sent_internet_id_check check (sent_internet_id is null or char_length(sent_internet_id) between 1 and 1000);

create unique index if not exists mail_shares_draft_idx on crm.mail_shares (draft_id) where draft_id is not null;
create index if not exists mail_shares_owner_pending_idx on crm.mail_shares (owner_user_id, source_id) where thread_key is null and sent_internet_id is not null;

grant select (draft_id) on crm.mail_shares to authenticated;
grant update (draft_id, source_id) on crm.mail_shares to authenticated;

drop policy if exists mail_shares_owner_update on crm.mail_shares;
create policy mail_shares_owner_update on crm.mail_shares
  for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (
    owner_user_id = (select auth.uid())
    and (mail_shares.draft_id is null or exists (select 1 from crm.mail_drafts d where d.id = mail_shares.draft_id))
    and exists (select 1 from crm.mail_sources ms where ms.id = mail_shares.source_id)
  );

create or replace function private.shared_draft_sending(p_share crm.mail_shares, p_draft crm.mail_drafts)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_share.draft_held_until > now(), false)
    or coalesce(p_draft.sending_at > now() - interval '10 minutes', false)
    or p_draft.send_attempted_at is not null
$$;

revoke all on function private.shared_draft_sending(crm.mail_shares, crm.mail_drafts) from public;

create or replace function private.mail_share_owner_first_name(p_owner uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(split_part(nullif(btrim(p.full_name), ''), ' ', 1), 'The owner') from crm.profiles p where p.id = p_owner
$$;

revoke all on function private.mail_share_owner_first_name(uuid) from public;

create or replace function private.mail_share_draft_add(p_user uuid, p_draft uuid, p_people uuid[])
returns table (share_id uuid, added uuid[], members uuid[], added_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_draft crm.mail_drafts;
  v_share crm.mail_shares;
  v_people uuid[];
  v_added uuid[] := '{}';
begin
  select d.* into v_draft from crm.mail_drafts d where d.id = p_draft and d.user_id = p_user for update;
  if v_draft.id is null then
    raise exception 'That draft has gone. Save it again.' using errcode = 'P0002';
  end if;
  if v_draft.send_at is not null or coalesce(v_draft.sending_at > now() - interval '10 minutes', false) or v_draft.send_attempted_at is not null then
    raise exception 'This draft is sending or scheduled. Share it after cancelling.' using errcode = '55006';
  end if;
  v_people := array(select distinct x from unnest(coalesce(p_people, '{}')) as x where x is not null and x <> p_user);
  if cardinality(v_people) > 50 then
    raise exception 'Add up to 50 people at a time.' using errcode = '22023';
  end if;
  if cardinality(v_people) > 0 and v_draft.reply_to is not null then
    raise exception 'Add people to the thread with Share.' using errcode = '22023';
  end if;
  select s.* into v_share from crm.mail_shares s where s.draft_id = p_draft and s.owner_user_id = p_user for update;
  if v_share.id is null and v_draft.reply_to is not null then
    select s.* into v_share from crm.mail_shares s
      where s.owner_user_id = p_user and s.source_id = v_draft.source_id
        and s.thread_key = coalesce(v_draft.thread_key, 'm:' || v_draft.reply_to::text)
      for update;
    if v_share.id is null or not exists (select 1 from crm.mail_share_members m where m.share_id = v_share.id) then
      raise exception 'Share this thread first.' using errcode = '22023';
    end if;
    if v_share.draft_id is not null and v_share.draft_id <> p_draft then
      raise exception 'Another draft in this thread is shared. Send or discard it first.' using errcode = '22023';
    end if;
    update crm.mail_shares s set draft_id = p_draft, draft_state = null, draft_held_until = null, draft_version = s.draft_version + 1
      where s.id = v_share.id;
    v_added := array(select m.user_id from crm.mail_share_members m where m.share_id = v_share.id);
  elsif v_share.id is null then
    if cardinality(v_people) = 0 then
      raise exception 'Pick someone to share it with.' using errcode = '22023';
    end if;
    insert into crm.mail_shares (owner_user_id, source_id, thread_key, draft_id)
      values (p_user, v_draft.source_id, null, p_draft)
      returning * into v_share;
  end if;
  if cardinality(v_people) > 0 then
    perform 1 from crm.workspace_members m
      where m.user_id = any(array[p_user] || v_people)
      order by m.workspace_id, m.user_id
      for share;
    if exists (select 1 from unnest(v_people) as x(id) where not private.chat_shares_workspace(p_user, x.id)) then
      raise exception 'Someone you picked doesn''t share a workspace with you.' using errcode = '22023';
    end if;
    with inserted as (
      insert into crm.mail_share_members (share_id, user_id, added_by)
        select v_share.id, x, p_user from unnest(v_people) as x
        on conflict (share_id, user_id) do nothing
        returning user_id
    )
    select v_added || coalesce(array_agg(i.user_id), '{}') into v_added from inserted i;
  end if;
  return query select v_share.id, v_added, array(select m.user_id from crm.mail_share_members m where m.share_id = v_share.id), now();
end;
$$;

revoke all on function private.mail_share_draft_add(uuid, uuid, uuid[]) from public;
grant execute on function private.mail_share_draft_add(uuid, uuid, uuid[]) to crm_app;

create or replace function private.merge_shared_draft(p_user uuid, p_share uuid, p_subject text, p_body text)
returns table (version integer, owner_user_id uuid, members uuid[])
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_share crm.mail_shares;
  v_draft crm.mail_drafts;
begin
  if p_user is null or not private.mail_share_open_to(p_share, p_user) then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  select s.* into v_share from crm.mail_shares s where s.id = p_share for update;
  select d.* into v_draft from crm.mail_drafts d where d.id = v_share.draft_id and d.user_id = v_share.owner_user_id for update;
  if v_draft.id is null then
    raise exception 'This draft was sent or discarded.' using errcode = 'P0002';
  end if;
  if p_body is not null and char_length(p_body) > 20000 then
    raise exception 'Keep the message under 20,000 characters.' using errcode = '22023';
  end if;
  if p_subject is not null and char_length(p_subject) > 300 then
    raise exception 'Keep the subject under 300 characters.' using errcode = '22023';
  end if;
  if v_draft.send_at is not null or v_draft.send_error is not null then
    raise exception 'Scheduled. Read only until % cancels it.', private.mail_share_owner_first_name(v_share.owner_user_id) using errcode = '55006';
  end if;
  if coalesce(v_draft.sending_at > now() - interval '10 minutes', false) or v_draft.send_attempted_at is not null
    or (p_user <> v_share.owner_user_id and coalesce(v_share.draft_held_until > now(), false)) then
    raise exception '% is sending. Read only.', private.mail_share_owner_first_name(v_share.owner_user_id) using errcode = '55006';
  end if;
  if coalesce(p_subject, v_draft.subject, '') is distinct from coalesce(v_draft.subject, '') or coalesce(p_body, v_draft.body) is distinct from v_draft.body then
    update crm.mail_drafts d set subject = coalesce(p_subject, d.subject), body = coalesce(p_body, d.body), updated_at = now()
      where d.id = v_draft.id;
    update crm.mail_shares s set draft_version = s.draft_version + 1 where s.id = v_share.id returning * into v_share;
  end if;
  return query select v_share.draft_version, v_share.owner_user_id, array(select m.user_id from crm.mail_share_members m where m.share_id = v_share.id);
end;
$$;

revoke all on function private.merge_shared_draft(uuid, uuid, text, text) from public;
grant execute on function private.merge_shared_draft(uuid, uuid, text, text) to crm_app;

create or replace function private.shared_draft(p_user uuid, p_share uuid)
returns table (
  owner_user_id uuid,
  state text,
  mode text,
  from_email text,
  to_recipients jsonb,
  cc_recipients jsonb,
  subject text,
  body text,
  attachments jsonb,
  send_at timestamptz,
  version integer,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.owner_user_id,
    case
      when d.id is null then coalesce(s.draft_state, 'none')
      when d.send_at is not null or d.send_error is not null then 'scheduled'
      when private.shared_draft_sending(s, d) then 'sending'
      else 'editing'
    end,
    d.mode,
    coalesce((select i.email from crm.send_identities i where i.id = d.identity_id and i.user_id = s.owner_user_id), src.email),
    coalesce(d.to_recipients, '[]'::jsonb),
    coalesce(d.cc_recipients, '[]'::jsonb),
    d.subject,
    d.body,
    coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'size', a.size, 'contentType', a.content_type) order by a.name)
      from crm.email_attachments a where a.id = any(d.attachments) and a.user_id = s.owner_user_id
    ), '[]'::jsonb),
    d.send_at,
    s.draft_version,
    d.updated_at
  from crm.mail_shares s
  left join crm.mail_drafts d on d.id = s.draft_id and d.user_id = s.owner_user_id
  left join crm.mail_sources src on src.id = d.source_id
  where s.id = p_share and private.mail_share_open_to(p_share, p_user)
$$;

revoke all on function private.shared_draft(uuid, uuid) from public;
grant execute on function private.shared_draft(uuid, uuid) to crm_app;

create or replace function private.mail_share_draft_hold(p_user uuid, p_draft uuid, p_hold boolean)
returns table (share_id uuid, members uuid[])
language sql
security definer
set search_path = ''
as $$
  update crm.mail_shares s
    set draft_held_until = case when p_hold then now() + interval '2 minutes' end
    where s.draft_id = p_draft and s.owner_user_id = p_user
    returning s.id, array(select m.user_id from crm.mail_share_members m where m.share_id = s.id)
$$;

revoke all on function private.mail_share_draft_hold(uuid, uuid, boolean) from public;
grant execute on function private.mail_share_draft_hold(uuid, uuid, boolean) to crm_app;

create or replace function private.mail_share_draft_members(p_user uuid, p_draft uuid)
returns table (share_id uuid, members uuid[])
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, array(select m.user_id from crm.mail_share_members m where m.share_id = s.id)
  from crm.mail_shares s
  where s.draft_id = p_draft and s.owner_user_id = p_user
$$;

revoke all on function private.mail_share_draft_members(uuid, uuid) from public;
grant execute on function private.mail_share_draft_members(uuid, uuid) to crm_app;

create or replace function private.mail_share_draft_closed(p_user uuid, p_share uuid, p_state text, p_thread_key text, p_internet_id text)
returns table (share_id uuid, members uuid[])
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_share crm.mail_shares;
  v_thread text;
begin
  if p_state not in ('sent', 'discarded') then
    raise exception 'Unknown draft state.' using errcode = '22023';
  end if;
  select s.* into v_share from crm.mail_shares s where s.id = p_share and s.owner_user_id = p_user for update;
  if v_share.id is null then
    return;
  end if;
  v_thread := v_share.thread_key;
  if v_thread is null and p_state = 'sent' and p_thread_key is not null and char_length(p_thread_key) between 1 and 450
    and not exists (
      select 1 from crm.mail_shares o
      where o.owner_user_id = p_user and o.source_id = v_share.source_id and o.thread_key = p_thread_key and o.id <> v_share.id
    ) then
    v_thread := p_thread_key;
  end if;
  update crm.mail_shares s set
      draft_id = null,
      draft_state = p_state,
      draft_held_until = null,
      draft_version = s.draft_version + 1,
      thread_key = v_thread,
      sent_internet_id = case when v_thread is null and p_state = 'sent' then left(p_internet_id, 1000) else null end
    where s.id = v_share.id;
  return query select v_share.id, array(select m.user_id from crm.mail_share_members m where m.share_id = v_share.id);
end;
$$;

revoke all on function private.mail_share_draft_closed(uuid, uuid, text, text, text) from public;
grant execute on function private.mail_share_draft_closed(uuid, uuid, text, text, text) to crm_app;

create or replace function private.mail_shares_follow_sent(p_user uuid, p_source uuid, p_thread_keys text[])
returns table (share_id uuid, members uuid[])
language sql
security definer
set search_path = ''
as $$
  with found as (
    select distinct on (s.id) s.id, m.thread_key
    from crm.mail_shares s
    join crm.mail_messages m on m.source_id = s.source_id and m.thread_key = any(p_thread_keys) and m.user_id = s.owner_user_id
      and m.internet_message_id = s.sent_internet_id
    where s.owner_user_id = p_user and s.source_id = p_source and s.thread_key is null and s.sent_internet_id is not null
      and not exists (
        select 1 from crm.mail_shares o
        where o.owner_user_id = p_user and o.source_id = p_source and o.thread_key = m.thread_key
      )
    order by s.id, m.thread_key
  )
  update crm.mail_shares s set thread_key = found.thread_key, sent_internet_id = null
    from found where s.id = found.id
    returning s.id, array(select sm.user_id from crm.mail_share_members sm where sm.share_id = s.id)
$$;

revoke all on function private.mail_shares_follow_sent(uuid, uuid, text[]) from public;
grant execute on function private.mail_shares_follow_sent(uuid, uuid, text[]) to crm_app;

create or replace function private.shared_threads(p_user uuid)
returns table (
  share_id uuid,
  owner_user_id uuid,
  owner_name text,
  shared_at timestamptz,
  subject text,
  latest_at timestamptz,
  snippet text,
  counterpart_name text,
  counterpart_email text,
  message_count integer,
  has_attachments boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.owner_user_id, coalesce(nullif(btrim(p.full_name), ''), p.email, 'Someone'), sm.created_at,
    coalesce(latest.subject, d.subject), coalesce(latest.at, d.updated_at), latest.snippet,
    coalesce(them.name, latest.to_name, d.to_recipients -> 0 ->> 'name'), coalesce(them.address, latest.to_address, d.to_recipients -> 0 ->> 'address'),
    stats.n, stats.attachments
  from crm.mail_share_members sm
  join crm.mail_shares s on s.id = sm.share_id
  join crm.profiles p on p.id = s.owner_user_id
  left join crm.mail_drafts d on d.id = s.draft_id and d.user_id = s.owner_user_id
  cross join lateral (
    select count(*)::integer as n, coalesce(bool_or(m.has_attachments), false) as attachments
    from private.mail_share_messages(s.id) m
  ) stats
  left join lateral (
    select m.subject, m.snippet, coalesce(m.received_at, m.sent_at, m.created_at) as at,
      m.to_recipients -> 0 ->> 'name' as to_name, m.to_recipients -> 0 ->> 'address' as to_address
    from private.mail_share_messages(s.id) m
    order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.id desc
    limit 1
  ) latest on true
  left join lateral (
    select m.from_name as name, m.from_email as address
    from private.mail_share_messages(s.id) m
    where m.from_email is not null
      and lower(m.from_email) not in (select a from private.mail_share_owner_addresses(s.owner_user_id) a)
    order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.id desc
    limit 1
  ) them on true
  where sm.user_id = p_user and (stats.n > 0 or d.id is not null)
  order by coalesce(latest.at, d.updated_at) desc, s.id
$$;

revoke all on function private.shared_threads(uuid) from public;
grant execute on function private.shared_threads(uuid) to crm_app;

reset lock_timeout;
