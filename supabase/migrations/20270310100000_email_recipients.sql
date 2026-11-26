set lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'Run this as a role that bypasses row-level security: it merges activities and writes audit rows.';
  end if;
end;
$$;

create or replace function private.activity_contacts_free_mail(p_domain text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select p_domain = any (array['gmail.com', 'googlemail.com', 'outlook.com', 'outlook.co.uk', 'outlook.fr', 'outlook.de', 'outlook.ie', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'hotmail.es', 'live.com', 'live.co.uk', 'live.fr', 'live.de', 'live.ie', 'msn.com', 'windowslive.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.ie', 'yahoo.it', 'yahoo.es', 'ymail.com', 'rocketmail.com', 'btinternet.com', 'btopenworld.com', 'talk21.com', 'sky.com', 'virginmedia.com', 'virgin.net', 'ntlworld.com', 'blueyonder.co.uk', 'talktalk.net', 'tiscali.co.uk', 'plus.com', 'freeserve.co.uk', 'orange.fr', 'wanadoo.fr', 'wanadoo.co.uk', 'free.fr', 'laposte.net', 'sfr.fr', 't-online.de', 'freenet.de', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aol.co.uk', 'aim.com', 'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'gmx.co.uk', 'gmx.fr', 'web.de', 'mail.com', 'email.com', 'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'fastmail.com', 'fastmail.fm', 'hey.com', 'tutanota.com', 'tuta.io', 'qq.com', '163.com', 'hushmail.com']) $$;

do $$
declare
  dup record;
  keep_main uuid;
  keep_company uuid;
  copy_company uuid;
  promote boolean;
  linked_before uuid[];
  linked_after uuid[];
  message_key text;
begin
  foreach message_key in array array['internetMessageId', 'mailMessageId', 'providerMessageId'] loop
    for dup in
      select ranked.id, ranked.workspace_id, ranked.type, ranked.title, ranked.occurred_at, ranked.company_id, ranked.contact_id, ranked.keep_id
      from (
        select a.id, a.workspace_id, a.type, a.title, a.occurred_at, a.company_id, a.contact_id, a.created_at,
          first_value(a.id) over message as keep_id,
          row_number() over message as position
        from crm.activities a
        where a.type = 'email' and a.archived_at is null and nullif(a.metadata ->> message_key, '') is not null
        window message as (partition by a.workspace_id, a.metadata ->> message_key order by a.created_at, a.id)
      ) ranked
      where ranked.position > 1
      order by ranked.created_at, ranked.id
    loop
      select k.contact_id, k.company_id into keep_main, keep_company from crm.activities k where k.id = dup.keep_id;
      linked_before := array(select l.contact_id from crm.activity_contacts l where l.activity_id = dup.keep_id order by l.created_at, l.contact_id);
      promote := false;
      if keep_main is null and dup.contact_id is not null then
        select c.company_id into copy_company from crm.contacts c where c.id = dup.contact_id and c.archived_at is null;
        if found and (keep_company is null or copy_company is null or keep_company = copy_company) then
          promote := true;
          update crm.activities set contact_id = dup.contact_id, company_id = coalesce(company_id, copy_company) where id = dup.keep_id;
        end if;
      end if;
      insert into crm.activity_contacts (activity_id, contact_id, implicit)
      select dup.keep_id, l.contact_id, false
      from crm.activity_contacts l
      join crm.contacts c on c.id = l.contact_id and c.workspace_id = dup.workspace_id and c.archived_at is null
      where l.activity_id = dup.id
      on conflict (activity_id, contact_id) do nothing;
      update crm.mail_tracking t set activity_id = dup.keep_id
      where t.activity_id = dup.id
        and not exists (select 1 from crm.mail_tracking k where k.activity_id = dup.keep_id);
      update crm.activities set archived_at = now() where id = dup.id and archived_at is null;
      linked_after := array(select l.contact_id from crm.activity_contacts l where l.activity_id = dup.keep_id order by l.created_at, l.contact_id);
      if linked_after is distinct from linked_before then
        insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, source, operation, changes)
        values (
          dup.workspace_id, 'activity.updated', 'activity', dup.keep_id, 'system', 'migration', 'merge_email_copies',
          jsonb_build_object(
            'fields', case when promote then jsonb_build_array('contactId', 'attendees') else jsonb_build_array('attendees') end,
            'before', jsonb_build_object('attendees', to_jsonb(linked_before)) || case when promote then jsonb_build_object('contactId', null) else '{}'::jsonb end,
            'after', jsonb_build_object('attendees', to_jsonb(linked_after)) || case when promote then jsonb_build_object('contactId', dup.contact_id) else '{}'::jsonb end,
            'mergedFrom', dup.id
          )
        );
      end if;
      insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, source, operation, changes)
      values (
        dup.workspace_id, 'activity.archived', 'activity', dup.id, 'system', 'migration', 'merge_email_copies',
        jsonb_build_object(
          'before', jsonb_build_object('archivedAt', null),
          'after', jsonb_build_object('archivedAt', now()),
          'activity', jsonb_build_object('type', dup.type, 'title', dup.title, 'occurredAt', dup.occurred_at, 'companyId', dup.company_id, 'contactId', dup.contact_id),
          'mergedInto', dup.keep_id
        )
      );
    end loop;
  end loop;
end;
$$;

do $$
declare
  filed record;
  linked_before uuid[];
  linked_after uuid[];
begin
  for filed in
    with mail as (
      select a.id, a.workspace_id, a.type, a.title, a.occurred_at, a.company_id, a.contact_id, a.metadata ->> 'direction' as direction,
        case when a.metadata ->> 'mailMessageId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (a.metadata ->> 'mailMessageId')::uuid end as mail_id
      from crm.activities a
      where a.type = 'email' and a.archived_at is null and a.metadata ->> 'direction' in ('inbound', 'outbound')
    )
    select a.id, a.workspace_id, a.type, a.title, a.occurred_at, a.company_id, a.contact_id, array_agg(distinct c.id) as wanted
    from mail a
    join crm.mail_messages m on m.id = a.mail_id
    cross join lateral (
      select lower(btrim(listed.address)) as email
      from (
        select m.from_email as address where a.direction = 'inbound'
        union all
        select p ->> 'address' from jsonb_array_elements(case when jsonb_typeof(m.to_recipients) = 'array' then m.to_recipients else '[]'::jsonb end) p where jsonb_typeof(p) = 'object'
        union all
        select p ->> 'address' from jsonb_array_elements(case when jsonb_typeof(m.cc_recipients) = 'array' then m.cc_recipients else '[]'::jsonb end) p where jsonb_typeof(p) = 'object'
      ) listed
    ) x
    join crm.contacts c
      on c.workspace_id = a.workspace_id
     and c.archived_at is null
     and c.normalized_email = x.email
    where nullif(x.email, '') is not null
      and not exists (
        select 1
        from crm.workspace_members wm
        join crm.profiles pr on pr.id = wm.user_id
        where wm.workspace_id = a.workspace_id
          and (
            lower(pr.email) = x.email
            or x.email = any (select lower(o) from unnest(pr.other_emails) o)
            or (
              split_part(lower(pr.email), '@', 2) = split_part(x.email, '@', 2)
              and not private.activity_contacts_free_mail(split_part(x.email, '@', 2))
            )
            or exists (
              select 1 from unnest(pr.other_emails) o
              where split_part(lower(o), '@', 2) = split_part(x.email, '@', 2)
                and not private.activity_contacts_free_mail(split_part(lower(o), '@', 2))
            )
          )
      )
      and not exists (
        select 1
        from crm.workspace_brands b
        where (b.workspace_id = a.workspace_id or b.workspace_id in (select wm.workspace_id from crm.workspace_members wm where wm.user_id = m.user_id))
          and split_part(x.email, '@', 2) = any (b.own_domains)
      )
      and not exists (
        select 1 from (
          select lower(email) as e from crm.mail_sources where user_id = m.user_id
          union select lower(email) from crm.send_identities where user_id = m.user_id
          union select lower(email) from crm.mailbox_connections where user_id = m.user_id and email is not null
          union select lower(email) from crm.calendar_accounts where user_id = m.user_id and email is not null
          union select lower(email) from crm.profiles where id = m.user_id and email is not null
        ) own
        where own.e = x.email
          or (
            split_part(own.e, '@', 2) = split_part(x.email, '@', 2)
            and not private.activity_contacts_free_mail(split_part(x.email, '@', 2))
          )
      )
    group by a.id, a.workspace_id, a.type, a.title, a.occurred_at, a.company_id, a.contact_id
    order by a.occurred_at, a.id
  loop
    linked_before := array(select l.contact_id from crm.activity_contacts l where l.activity_id = filed.id order by l.created_at, l.contact_id);
    insert into crm.activity_contacts (activity_id, contact_id, implicit)
    select filed.id, w.contact_id, false from unnest(filed.wanted) as w(contact_id)
    on conflict (activity_id, contact_id) do nothing;
    linked_after := array(select l.contact_id from crm.activity_contacts l where l.activity_id = filed.id order by l.created_at, l.contact_id);
    if linked_after is distinct from linked_before then
      insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, source, operation, changes)
      values (
        filed.workspace_id, 'activity.updated', 'activity', filed.id, 'system', 'migration', 'link_email_recipients',
        jsonb_build_object(
          'fields', jsonb_build_array('attendees'),
          'before', jsonb_build_object('attendees', to_jsonb(linked_before)),
          'after', jsonb_build_object('attendees', to_jsonb(linked_after)),
          'activity', jsonb_build_object('type', filed.type, 'title', filed.title, 'occurredAt', filed.occurred_at, 'companyId', filed.company_id, 'contactId', filed.contact_id)
        )
      );
    end if;
  end loop;
end;
$$;

drop function if exists private.activity_contacts_free_mail(text);

reset lock_timeout;
