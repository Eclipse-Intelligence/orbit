set lock_timeout = '5s';

create or replace function private.team_remove_records(p_workspace uuid, p_actor uuid, p_user uuid)
returns table (
  record_kind text,
  record_id uuid,
  due_before timestamptz,
  due_after timestamptz,
  had_time boolean,
  scheduled_before text,
  remind_before integer
)
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
  return query
    with moved as (
      update crm.companies c set owner_id = p_actor
      where c.workspace_id = p_workspace and c.owner_id = p_user
      returning c.id
    )
    select 'company'::text, moved.id, null::timestamptz, null::timestamptz, null::boolean, null::text, null::integer from moved;
  return query
    with moved as (
      update crm.contacts c set owner_id = p_actor
      where c.workspace_id = p_workspace and c.owner_id = p_user
      returning c.id
    )
    select 'contact'::text, moved.id, null::timestamptz, null::timestamptz, null::boolean, null::text, null::integer from moved;
  return query
    with moved as (
      update crm.opportunities o set owner_id = p_actor
      where o.workspace_id = p_workspace and o.owner_id = p_user
      returning o.id
    )
    select 'opportunity'::text, moved.id, null::timestamptz, null::timestamptz, null::boolean, null::text, null::integer from moved;
  return query
    with prior as (
      select t.id, t.due_at, t.due_has_time, t.scheduled_by, t.remind_minutes
      from crm.tasks t
      where t.workspace_id = p_workspace and t.owner_id = p_user and t.completed_at is null
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
      returning t.id, t.due_at
    )
    select 'task'::text, moved.id, prior.due_at, moved.due_at, coalesce(prior.due_has_time and prior.due_at is not null, false), prior.scheduled_by, prior.remind_minutes
    from moved
    join prior on prior.id = moved.id;
  return query
    with moved as (
      update crm.documents d set owner_id = p_actor
      where d.workspace_id = p_workspace and d.owner_id = p_user
      returning d.id
    )
    select 'document'::text, moved.id, null::timestamptz, null::timestamptz, null::boolean, null::text, null::integer from moved;
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
end;
$$;

revoke all on function private.team_remove_records(uuid, uuid, uuid) from public;
grant execute on function private.team_remove_records(uuid, uuid, uuid) to crm_app;

create or replace function private.team_remove(p_workspace uuid, p_actor uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.team_remove_records(p_workspace, p_actor, p_user);
end;
$$;

revoke all on function private.team_remove(uuid, uuid, uuid) from public;
grant execute on function private.team_remove(uuid, uuid, uuid) to crm_app;

reset lock_timeout;
