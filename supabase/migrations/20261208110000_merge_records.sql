create or replace function private.assert_same_workspace()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  payload jsonb := to_jsonb(new);
  previous jsonb;
  scope_changed boolean;
  merging boolean := current_setting('orbit.merging', true) = 'on'
    and current_user not in ('authenticated', 'crm_agent', 'crm_app');
  company_id uuid := nullif(payload ->> 'company_id', '')::uuid;
  contact_id uuid := nullif(payload ->> 'contact_id', '')::uuid;
  opportunity_id uuid := nullif(payload ->> 'opportunity_id', '')::uuid;
  primary_contact_id uuid := nullif(payload ->> 'primary_contact_id', '')::uuid;
  stage_id uuid := nullif(payload ->> 'stage_id', '')::uuid;
  contact_company uuid;
  opportunity_company uuid;
  primary_company uuid;
begin
  if tg_op = 'UPDATE' then
    previous := to_jsonb(old);
  end if;
  scope_changed := previous is null
    or previous -> 'workspace_id' is distinct from payload -> 'workspace_id'
    or previous -> 'company_id' is distinct from payload -> 'company_id';

  if scope_changed and company_id is not null and not exists (
    select 1
    from crm.companies row
    where row.id = company_id
      and row.workspace_id = new.workspace_id
  ) then
    raise exception 'company belongs to another workspace' using errcode = '23514';
  end if;

  if contact_id is not null
    and (scope_changed or previous -> 'contact_id' is distinct from payload -> 'contact_id') then
    select row.company_id
    into contact_company
    from crm.contacts row
    where row.id = contact_id
      and row.workspace_id = new.workspace_id;
    if not found then
      raise exception 'contact belongs to another workspace' using errcode = '23514';
    end if;
    if not merging and company_id is not null and contact_company is not null and contact_company is distinct from company_id then
      raise exception 'contact belongs to a different company' using errcode = '23514';
    end if;
  end if;

  if primary_contact_id is not null
    and (
      scope_changed
      or previous -> 'primary_contact_id' is distinct from payload -> 'primary_contact_id'
    ) then
    select row.company_id
    into primary_company
    from crm.contacts row
    where row.id = primary_contact_id
      and row.workspace_id = new.workspace_id;
    if not found then
      raise exception 'contact belongs to another workspace' using errcode = '23514';
    end if;
    if not merging and company_id is not null and primary_company is not null and primary_company is distinct from company_id then
      raise exception 'contact belongs to a different company' using errcode = '23514';
    end if;
  end if;

  if opportunity_id is not null
    and (scope_changed or previous -> 'opportunity_id' is distinct from payload -> 'opportunity_id') then
    select row.company_id
    into opportunity_company
    from crm.opportunities row
    where row.id = opportunity_id
      and row.workspace_id = new.workspace_id;
    if not found then
      raise exception 'opportunity belongs to another workspace' using errcode = '23514';
    end if;
    if not merging and company_id is not null and opportunity_company is distinct from company_id then
      raise exception 'opportunity belongs to a different company' using errcode = '23514';
    end if;
  end if;

  if stage_id is not null
    and (
      previous is null
      or previous -> 'workspace_id' is distinct from payload -> 'workspace_id'
      or previous -> 'stage_id' is distinct from payload -> 'stage_id'
    )
    and not exists (
      select 1
      from crm.pipeline_stages row
      where row.id = stage_id
        and row.workspace_id = new.workspace_id
    ) then
    raise exception 'stage belongs to another workspace' using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function private.merge_move(
  p_table text,
  p_column text,
  p_workspace uuid,
  p_from uuid,
  p_to uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  moved jsonb;
begin
  execute format(
    'with moved as (update crm.%I set %I = $1 where workspace_id = $2 and %I = $3 returning id)
     select coalesce(jsonb_agg(id order by id), ''[]''::jsonb) from moved',
    p_table, p_column, p_column
  )
  into moved
  using p_to, p_workspace, p_from;
  return moved;
end;
$$;

create or replace function private.merge_actor_check(p_workspace uuid, p_user uuid, p_agent uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_user is not null then
    if not exists (
      select 1 from crm.workspace_members m
      where m.workspace_id = p_workspace and m.user_id = p_user
    ) then
      raise exception 'You are not a member of this workspace.' using errcode = '42501';
    end if;
  elsif p_agent is null or not exists (
    select 1 from crm.agents a
    where a.id = p_agent and a.workspace_id = p_workspace and a.enabled
  ) then
    raise exception 'This agent can''t change this workspace.' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.merge_company_references(
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
  keep_row crm.companies%rowtype;
  merge_row crm.companies%rowtype;
  moved jsonb := '{}'::jsonb;
  target text;
  calendar_replaced jsonb;
  calendar_shared jsonb;
  marks jsonb;
  web_state text := 'none';
begin
  perform private.merge_actor_check(p_workspace, p_user, p_agent);
  if p_keep = p_merge then
    raise exception 'Pick a different company to merge into.' using errcode = '22023';
  end if;
  perform 1 from crm.companies c
    where c.workspace_id = p_workspace and c.id in (p_keep, p_merge)
    order by c.id
    for update;
  select * into keep_row from crm.companies c where c.id = p_keep and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The company to keep isn''t in this workspace.' using errcode = 'P0002';
  end if;
  select * into merge_row from crm.companies c where c.id = p_merge and c.workspace_id = p_workspace;
  if not found then
    raise exception 'The company to merge isn''t in this workspace.' using errcode = 'P0002';
  end if;
  if keep_row.archived_at is not null then
    raise exception '% is archived, so it can''t be merged into.', keep_row.name using errcode = '22023';
  end if;
  if merge_row.archived_at is not null then
    raise exception '% is already archived, so it can''t be merged.', merge_row.name using errcode = '22023';
  end if;

  perform set_config('orbit.merging', 'on', true);

  foreach target in array array[
    'contacts', 'opportunities', 'tasks', 'activities', 'email_messages', 'call_records',
    'call_insights', 'conversation_imports', 'workflow_runs', 'documents', 'memories',
    'market_notes', 'watchlist', 'knowledge_items', 'company_signals'
  ] loop
    moved := moved || jsonb_build_object(target, private.merge_move(target, 'company_id', p_workspace, p_merge, p_keep));
  end loop;

  with changed as (
    update crm.calendar_events e
    set company_ids = array_replace(e.company_ids, p_merge, p_keep)
    where e.workspace_id = p_workspace and p_merge = any(e.company_ids) and not (p_keep = any(e.company_ids))
    returning e.id
  )
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into calendar_replaced from changed;
  with changed as (
    update crm.calendar_events e
    set company_ids = array_remove(e.company_ids, p_merge)
    where e.workspace_id = p_workspace and p_merge = any(e.company_ids)
    returning e.id
  )
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into calendar_shared from changed;

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
  select coalesce(jsonb_agg(workflow_id order by workflow_id), '[]'::jsonb) into marks from changed;

  if exists (select 1 from crm.company_web_state w where w.company_id = p_merge) then
    if exists (select 1 from crm.company_web_state w where w.company_id = p_keep) then
      web_state := 'kept';
    else
      update crm.company_web_state set company_id = p_keep where company_id = p_merge;
      web_state := 'moved';
    end if;
  end if;

  perform set_config('orbit.merging', 'off', true);

  return moved || jsonb_build_object(
    'calendar_events', calendar_replaced,
    'calendar_events_shared', calendar_shared,
    'workflow_record_marks', marks,
    'company_web_state', web_state
  );
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
  calendar_replaced jsonb;
  calendar_shared jsonb;
  marks jsonb;
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
  moved := moved || jsonb_build_object(
    'opportunities', private.merge_move('opportunities', 'primary_contact_id', p_workspace, p_merge, p_keep)
  );

  with changed as (
    update crm.calendar_events e
    set contact_ids = array_replace(e.contact_ids, p_merge, p_keep)
    where e.workspace_id = p_workspace and p_merge = any(e.contact_ids) and not (p_keep = any(e.contact_ids))
    returning e.id
  )
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into calendar_replaced from changed;
  with changed as (
    update crm.calendar_events e
    set contact_ids = array_remove(e.contact_ids, p_merge)
    where e.workspace_id = p_workspace and p_merge = any(e.contact_ids)
    returning e.id
  )
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into calendar_shared from changed;

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
  select coalesce(jsonb_agg(workflow_id order by workflow_id), '[]'::jsonb) into marks from changed;

  perform set_config('orbit.merging', 'off', true);

  return moved || jsonb_build_object(
    'calendar_events', calendar_replaced,
    'calendar_events_shared', calendar_shared,
    'workflow_record_marks', marks
  );
end;
$$;

revoke all on function private.merge_move(text, text, uuid, uuid, uuid) from public;
revoke all on function private.merge_actor_check(uuid, uuid, uuid) from public;
revoke all on function private.merge_company_references(uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) from public;

grant execute on function private.merge_company_references(uuid, uuid, uuid, uuid, uuid) to crm_app;
grant execute on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) to crm_app;
