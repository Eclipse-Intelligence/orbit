alter table crm.workspaces add column if not exists brand_source_id uuid references crm.workspaces (id) on delete set null;

create or replace function private.home_workspace_id(p_user uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id
  from crm.workspace_members m
  where m.user_id = p_user
  order by m.created_at, m.workspace_id
  limit 1;
$$;

revoke all on function private.home_workspace_id(uuid) from public;
grant execute on function private.home_workspace_id(uuid) to crm_app;

create or replace function private.create_workspace(p_user uuid, p_name text, p_brand_source uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_workspace uuid;
  v_pipeline uuid;
  v_slug text;
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'user required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from crm.workspace_members m where m.user_id = p_user and m.role = 'owner'
  ) then
    raise exception 'Only workspace owners can create a workspace.' using errcode = '42501';
  end if;
  if char_length(v_name) = 0 then
    raise exception 'Give the workspace a name.' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Keep the name to 120 characters.' using errcode = '22023';
  end if;
  if p_brand_source is not null and not exists (
    select 1 from crm.workspace_members m where m.user_id = p_user and m.workspace_id = p_brand_source
  ) then
    raise exception 'You can only copy from a workspace you are in.' using errcode = '42501';
  end if;

  loop
    v_slug := 'ws-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
    exit when not exists (select 1 from crm.workspaces w where w.slug = v_slug);
  end loop;

  insert into crm.workspaces (name, slug, brand_source_id)
  values (v_name, v_slug, p_brand_source)
  returning id into v_workspace;

  insert into crm.workspace_members (workspace_id, user_id, role)
  values (v_workspace, p_user, 'owner');

  insert into crm.pipelines (workspace_id, name, is_default)
  values (v_workspace, 'Default', true)
  returning id into v_pipeline;

  insert into crm.pipeline_stages
    (workspace_id, pipeline_id, name, position, probability, is_won, is_lost)
  values
    (v_workspace, v_pipeline, 'New', 0, 10, false, false),
    (v_workspace, v_pipeline, 'Working', 1, 30, false, false),
    (v_workspace, v_pipeline, 'Proposal', 2, 60, false, false),
    (v_workspace, v_pipeline, 'Won', 3, 100, true, false),
    (v_workspace, v_pipeline, 'Lost', 4, 0, false, true);

  insert into crm.capture_seen (workspace_id, user_id, seen_at)
  values (v_workspace, p_user, now())
  on conflict (workspace_id, user_id) do nothing;

  insert into crm.audit_events (
    workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, operation, changes
  )
  values (
    v_workspace,
    'workspace.created',
    'workspace',
    v_workspace,
    'user',
    p_user,
    'create_workspace',
    jsonb_build_object('name', v_name, 'brand_source_id', p_brand_source)
  );

  return v_workspace;
end;
$$;

revoke all on function private.create_workspace(uuid, text, uuid) from public;
grant execute on function private.create_workspace(uuid, text, uuid) to crm_app;

create or replace function private.personal_row_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_home uuid;
begin
  if tg_table_name = 'pages' then
    if new.kind <> 'daily' then
      return new;
    end if;
  end if;
  if new.user_id is null then
    return new;
  end if;
  v_home := private.home_workspace_id(new.user_id);
  if v_home is not null then
    new.workspace_id := v_home;
  end if;
  return new;
end;
$$;

create or replace function private.mail_row_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_found uuid;
begin
  if tg_table_name = 'mail_sources' then
    if new.connection_id is not null then
      select c.workspace_id into v_found from crm.mailbox_connections c where c.id = new.connection_id;
    elsif new.account_id is not null then
      select a.workspace_id into v_found from crm.calendar_accounts a where a.id = new.account_id;
    end if;
  elsif tg_table_name = 'calendars' then
    if new.account_id is not null then
      select a.workspace_id into v_found from crm.calendar_accounts a where a.id = new.account_id;
    elsif new.connection_id is not null then
      select c.workspace_id into v_found from crm.mailbox_connections c where c.id = new.connection_id;
    end if;
  elsif tg_table_name = 'calendar_events' then
    select c.workspace_id into v_found from crm.calendars c where c.id = new.calendar_id;
  elsif v_row ->> 'source_id' is not null then
    select s.workspace_id into v_found from crm.mail_sources s where s.id = (v_row ->> 'source_id')::uuid;
  elsif v_row ->> 'message_id' is not null then
    select m.workspace_id into v_found from crm.mail_messages m where m.id = (v_row ->> 'message_id')::uuid;
  end if;
  if v_found is null and new.user_id is not null and tg_table_name in ('mail_unsubscribes') then
    v_found := private.home_workspace_id(new.user_id);
  end if;
  if v_found is not null then
    new.workspace_id := v_found;
  end if;
  return new;
end;
$$;

revoke all on function private.personal_row_workspace() from public;
revoke all on function private.mail_row_workspace() from public;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'mail_sources', 'mail_folders', 'mail_messages', 'mail_drafts', 'mail_prepared', 'mail_reminders',
    'mail_summaries', 'mail_unsubscribes', 'send_identities', 'mail_attachment_texts',
    'mail_deferral_checks', 'mail_pitch_failures', 'calendars', 'calendar_events'
  ]
  loop
    execute format('drop trigger if exists %I on crm.%I', v_table || '_mail_workspace', v_table);
    execute format(
      'create trigger %I before insert on crm.%I for each row execute function private.mail_row_workspace()',
      v_table || '_mail_workspace',
      v_table
    );
  end loop;

  foreach v_table in array array[
    'mail_preferences', 'mail_sender_rules', 'mail_subscriptions', 'mail_viewer_addresses', 'mail_tracking',
    'email_signatures', 'email_attachments', 'hidden_attendees', 'ai_accounts', 'ai_companions',
    'ai_companion_pairings', 'push_subscriptions', 'push_log', 'pages'
  ]
  loop
    execute format('drop trigger if exists %I on crm.%I', v_table || '_personal_workspace', v_table);
    execute format(
      'create trigger %I before insert on crm.%I for each row execute function private.personal_row_workspace()',
      v_table || '_personal_workspace',
      v_table
    );
  end loop;
end
$$;

drop function if exists private.background_members();

create function private.background_members()
returns table (
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text,
  is_home boolean
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
  select w.id, w.name, m.user_id, m.role, p.email, p.full_name,
    w.id = private.home_workspace_id(m.user_id)
  from crm.workspace_members m
  join crm.workspaces w on w.id = m.workspace_id
  join crm.profiles p on p.id = m.user_id
  order by w.created_at, w.id,
    case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
    m.created_at;
end;
$$;

revoke all on function private.background_members() from public;
grant execute on function private.background_members() to crm_app;

create or replace function private.move_personal_rows(p_user uuid, p_from uuid, p_to uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
begin
  update crm.mailbox_connections c set workspace_id = p_to
  where c.workspace_id = p_from and c.user_id = p_user
    and not exists (
      select 1 from crm.mailbox_connections t
      where t.workspace_id = p_to and t.user_id = p_user and t.provider = c.provider
    );
  update crm.mailbox_connections
    set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null
    where workspace_id = p_from and user_id = p_user;

  update crm.email_signatures s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user
    and not exists (
      select 1 from crm.email_signatures t
      where t.workspace_id = p_to and t.user_id = p_user and t.sender_email = s.sender_email
    );
  update crm.mail_preferences s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user
    and not exists (select 1 from crm.mail_preferences t where t.workspace_id = p_to and t.user_id = p_user);
  update crm.hidden_attendees s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user
    and not exists (
      select 1 from crm.hidden_attendees t where t.workspace_id = p_to and t.user_id = p_user and t.email = s.email
    );
  update crm.pages s set workspace_id = p_to
  where s.workspace_id = p_from and s.user_id = p_user and s.kind = 'daily'
    and not exists (
      select 1 from crm.pages t
      where t.workspace_id = p_to and t.user_id = p_user and t.kind = 'daily' and t.daily_date = s.daily_date
    );
  update crm.integration_state set workspace_id = p_to
  where workspace_id = p_from and user_id = p_user and connection_id is not null;

  foreach v_table in array array[
    'calendar_accounts', 'mail_sources', 'mail_folders', 'mail_messages', 'mail_drafts', 'mail_prepared',
    'mail_reminders', 'mail_summaries', 'mail_unsubscribes', 'send_identities', 'mail_attachment_texts',
    'mail_deferral_checks', 'mail_pitch_failures', 'calendars', 'calendar_events', 'mail_sender_rules',
    'mail_subscriptions', 'mail_viewer_addresses', 'mail_tracking', 'mail_opens', 'email_attachments',
    'ai_accounts', 'ai_companions', 'ai_companion_pairings', 'push_subscriptions', 'push_log', 'booking_pages'
  ]
  loop
    execute format('update crm.%I set workspace_id = $1 where workspace_id = $2 and user_id = $3', v_table)
      using p_to, p_from, p_user;
  end loop;
end;
$$;

revoke all on function private.move_personal_rows(uuid, uuid, uuid) from public;

create or replace function private.team_remove(p_workspace uuid, p_actor uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := private.team_role(p_workspace, p_actor);
  target_role text := private.team_role(p_workspace, p_user);
  next_home uuid;
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
  update crm.companies set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.contacts set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.opportunities set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.tasks set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
  update crm.documents set owner_id = p_actor where workspace_id = p_workspace and owner_id = p_user;
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
  update crm.agent_mail_messages
    set status = 'failed', status_reason = 'They left the workspace.', advancing_until = null
    where workspace_id = p_workspace and user_id = p_user and status in ('received', 'working') and replied_at is null;
  delete from crm.agent_mail_threads where workspace_id = p_workspace and user_id = p_user;
  delete from crm.workspace_members where workspace_id = p_workspace and user_id = p_user;
end;
$$;

revoke all on function private.team_remove(uuid, uuid, uuid) from public;
grant execute on function private.team_remove(uuid, uuid, uuid) to crm_app;

create or replace function private.calendar_alert_members()
returns table (
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
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
  select w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.workspace_members m
  join crm.workspaces w on w.id = m.workspace_id
  join crm.profiles p on p.id = m.user_id
  left join lateral (
    select pr.user_id, pr.notify_calendar_minutes
    from crm.mail_preferences pr
    where pr.user_id = m.user_id
    order by pr.updated_at desc
    limit 1
  ) pref on true
  where m.workspace_id = private.home_workspace_id(m.user_id)
    and (pref.user_id is null or pref.notify_calendar_minutes is not null)
    and exists (select 1 from crm.push_subscriptions s where s.user_id = m.user_id)
    and exists (
      select 1 from crm.calendar_events e
      where e.user_id = m.user_id
        and not e.is_cancelled and not e.is_all_day
        and e.starts_at > now() - interval '2 minutes'
        and e.starts_at <= now() + make_interval(mins => coalesce(pref.notify_calendar_minutes, 10))
    );
end;
$$;

revoke all on function private.calendar_alert_members() from public;
grant execute on function private.calendar_alert_members() to crm_app;

create or replace function private.mail_due_members()
returns table (
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
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
  select w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.workspace_members m
  join crm.workspaces w on w.id = m.workspace_id
  join crm.profiles p on p.id = m.user_id
  where m.workspace_id = private.home_workspace_id(m.user_id)
    and (
      exists (
        select 1 from crm.mail_drafts d
        where d.user_id = m.user_id and d.send_at <= now()
      )
      or exists (
        select 1 from crm.mail_reminders r
        where r.user_id = m.user_id and r.state = 'waiting' and r.due_at <= now()
      )
      or exists (
        select 1 from crm.mail_reminders r
        where r.user_id = m.user_id and r.state = 'sending'
          and coalesce(r.sending_at, r.created_at) < now() - interval '10 minutes'
      )
    );
end;
$$;

revoke all on function private.mail_due_members() from public;
grant execute on function private.mail_due_members() to crm_app;
