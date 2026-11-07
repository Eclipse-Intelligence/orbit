drop policy if exists workflow_runs_select on crm.workflow_runs;
create policy workflow_runs_select on crm.workflow_runs
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and owner_id = (select private.session_user_id())
  );

drop policy if exists workflow_run_steps_select on crm.workflow_run_steps;
create policy workflow_run_steps_select on crm.workflow_run_steps
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and owner_id = (select private.session_user_id())
  );

create or replace function private.waiting_approvals_of_others(p_user uuid, p_workspace uuid)
returns table (
  id uuid,
  workflow_id uuid,
  workflow_name text,
  title text,
  owner_name text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.workflow_id, w.name, r.state -> 'approval' ->> 'title',
    coalesce(nullif(p.full_name, ''), p.email), r.updated_at
  from crm.workflow_runs r
  join crm.workflows w on w.id = r.workflow_id
  left join crm.profiles p on p.id = r.owner_id
  where r.workspace_id = p_workspace
    and r.owner_id <> p_user
    and r.status = 'waiting'
    and r.waiting_for = 'approval'
    and exists (
      select 1 from crm.workspace_members m
      where m.workspace_id = p_workspace and m.user_id = p_user and m.role in ('owner', 'admin')
    )
  order by r.updated_at
  limit 50;
$$;

revoke all on function private.waiting_approvals_of_others(uuid, uuid) from public;
grant execute on function private.waiting_approvals_of_others(uuid, uuid) to crm_app;

create or replace function private.revoke_invites_of_former_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace uuid := coalesce(new.workspace_id, old.workspace_id);
  v_user uuid := coalesce(new.user_id, old.user_id);
begin
  if tg_op = 'UPDATE' and new.role in ('owner', 'admin') then
    return new;
  end if;
  update crm.workspace_invites
    set revoked_at = now()
    where workspace_id = v_workspace and invited_by = v_user and accepted_at is null and revoked_at is null;
  return coalesce(new, old);
end;
$$;

revoke all on function private.revoke_invites_of_former_admin() from public;

drop trigger if exists workspace_members_revoke_invites on crm.workspace_members;
create trigger workspace_members_revoke_invites
  after delete or update of role on crm.workspace_members
  for each row execute function private.revoke_invites_of_former_admin();

update crm.workspace_invites i
  set revoked_at = now()
  where i.accepted_at is null and i.revoked_at is null
    and not exists (
      select 1 from crm.workspace_members m
      where m.workspace_id = i.workspace_id and m.user_id = i.invited_by and m.role in ('owner', 'admin')
    );

update crm.workspace_invites i
  set revoked_at = now()
  from (
    select x.id,
      row_number() over (partition by x.workspace_id, lower(x.email) order by x.created_at desc, x.id desc) as place
    from crm.workspace_invites x
    where x.accepted_at is null and x.revoked_at is null
  ) ranked
  where ranked.id = i.id and ranked.place > 1;

create unique index if not exists workspace_invites_one_pending_idx
  on crm.workspace_invites (workspace_id, lower(email))
  where accepted_at is null and revoked_at is null;

create or replace function private.team_invite(
  p_workspace uuid,
  p_actor uuid,
  p_email text,
  p_role text,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := private.team_role(p_workspace, p_actor);
  address text := lower(trim(coalesce(p_email, '')));
  created uuid;
begin
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can invite people.' using errcode = '42501';
  end if;
  if p_role not in ('member', 'admin') then
    raise exception 'Choose member or admin.' using errcode = '22023';
  end if;
  if p_role = 'admin' and actor_role <> 'owner' then
    raise exception 'Only the owner can invite an admin.' using errcode = '42501';
  end if;
  if position('@' in address) < 2 then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('workspace_invite:' || p_workspace::text || ':' || address, 0));
  if exists (
    select 1 from crm.workspace_members m join crm.profiles p on p.id = m.user_id
    where m.workspace_id = p_workspace and lower(p.email) = address
  ) then
    raise exception '% is already in this workspace.', address using errcode = '23505';
  end if;
  update crm.workspace_invites
    set revoked_at = now()
    where workspace_id = p_workspace and lower(email) = address and accepted_at is null and revoked_at is null;
  insert into crm.workspace_invites (workspace_id, email, role, token_hash, invited_by)
  values (p_workspace, address, p_role, p_token_hash, p_actor)
  returning id into created;
  return created;
end;
$$;

revoke all on function private.team_invite(uuid, uuid, text, text, text) from public;
grant execute on function private.team_invite(uuid, uuid, text, text, text) to crm_app;

create or replace function private.invite_preview(p_token_hash text)
returns table (
  invite_id uuid,
  workspace_id uuid,
  workspace_name text,
  email text,
  role text,
  invited_by_name text,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    i.id,
    i.workspace_id,
    w.name,
    i.email,
    i.role,
    coalesce(nullif(p.full_name, ''), p.email),
    case
      when i.accepted_at is not null then 'accepted'
      when i.revoked_at is not null then 'revoked'
      when not exists (
        select 1 from crm.workspace_members m
        where m.workspace_id = i.workspace_id and m.user_id = i.invited_by and m.role in ('owner', 'admin')
      ) then 'revoked'
      when i.expires_at < now() then 'expired'
      else 'pending'
    end
  from crm.workspace_invites i
  join crm.workspaces w on w.id = i.workspace_id
  left join crm.profiles p on p.id = i.invited_by
  where i.token_hash = p_token_hash;
$$;

revoke all on function private.invite_preview(text) from public;
grant execute on function private.invite_preview(text) to crm_app;

create or replace function private.accept_invite(p_token_hash text, p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite crm.workspace_invites%rowtype;
  address text;
begin
  select * into invite from crm.workspace_invites where token_hash = p_token_hash for update;
  if not found or invite.revoked_at is not null then
    raise exception 'This invite is no longer valid.' using errcode = '22023';
  end if;
  if invite.accepted_at is not null then
    if invite.accepted_by = p_user then
      return invite.workspace_id;
    end if;
    raise exception 'This invite has already been used.' using errcode = '22023';
  end if;
  if invite.expires_at < now() then
    raise exception 'This invite has expired. Ask for a new one.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from crm.workspace_members m
    where m.workspace_id = invite.workspace_id and m.user_id = invite.invited_by and m.role in ('owner', 'admin')
  ) then
    raise exception 'This invite is no longer valid. Ask the workspace owner for a new one.' using errcode = '22023';
  end if;
  select lower(p.email) into address from crm.profiles p where p.id = p_user;
  if address is null or address <> lower(invite.email) then
    raise exception 'This invite is for %.', invite.email using errcode = '42501';
  end if;
  insert into crm.workspace_members (workspace_id, user_id, role)
  values (invite.workspace_id, p_user, invite.role)
  on conflict (workspace_id, user_id) do nothing;
  update crm.workspace_invites set accepted_at = now(), accepted_by = p_user where id = invite.id;
  return invite.workspace_id;
end;
$$;

revoke all on function private.accept_invite(text, uuid) from public;
grant execute on function private.accept_invite(text, uuid) to crm_app;

create or replace function private.one_card_per_board()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_board text;
  v_company text;
begin
  if new.archived_at is not null or new.pipeline_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.archived_at is null
    and old.company_id = new.company_id and old.pipeline_id = new.pipeline_id then
    return new;
  end if;
  select p.name into v_board from crm.pipelines p where p.id = new.pipeline_id and p.kind = 'board';
  if not found then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('board_card:' || new.pipeline_id::text || ':' || new.company_id::text, 0));
  if exists (
    select 1 from crm.opportunities o
    where o.pipeline_id = new.pipeline_id and o.company_id = new.company_id
      and o.archived_at is null and o.id <> new.id
  ) then
    select c.name into v_company from crm.companies c where c.id = new.company_id;
    raise exception '% is already on %.', coalesce(v_company, 'This company'), v_board using errcode = '23505';
  end if;
  return new;
end;
$$;

revoke all on function private.one_card_per_board() from public;

drop trigger if exists opportunities_one_card_per_board on crm.opportunities;
create trigger opportunities_one_card_per_board
  before insert or update of company_id, pipeline_id, archived_at on crm.opportunities
  for each row execute function private.one_card_per_board();

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
  calendar_replaced integer;
  calendar_shared integer;
  marks integer;
  web_state text := 'none';
  card record;
  combined jsonb := '[]'::jsonb;
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

  for card in
    select dup.id as dup_id, kept.id as kept_id, dup.pipeline_id
    from crm.opportunities dup
    join crm.pipelines p on p.id = dup.pipeline_id and p.kind = 'board'
    join lateral (
      select k.id from crm.opportunities k
      where k.workspace_id = p_workspace and k.pipeline_id = dup.pipeline_id
        and k.company_id = p_keep and k.archived_at is null
      order by k.created_at, k.id
      limit 1
    ) kept on true
    where dup.workspace_id = p_workspace and dup.company_id = p_merge and dup.archived_at is null
    order by dup.created_at, dup.id
  loop
    update crm.activities set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.tasks set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.documents set opportunity_id = card.kept_id
      where workspace_id = p_workspace and opportunity_id = card.dup_id;
    update crm.opportunities set archived_at = now() where id = card.dup_id;
    combined := combined || jsonb_build_array(jsonb_build_object(
      'id', card.dup_id, 'keptId', card.kept_id, 'pipelineId', card.pipeline_id
    ));
  end loop;

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
  select count(*)::integer into calendar_replaced from changed;
  with changed as (
    update crm.calendar_events e
    set company_ids = array_remove(e.company_ids, p_merge)
    where e.workspace_id = p_workspace and p_merge = any(e.company_ids)
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
    'company_web_state', web_state,
    'combined_cards', combined
  );
end;
$$;

revoke all on function private.merge_company_references(uuid, uuid, uuid, uuid, uuid) from public;
grant execute on function private.merge_company_references(uuid, uuid, uuid, uuid, uuid) to crm_app;

create or replace function private.move_records_to_workspace(
  p_user uuid,
  p_source uuid,
  p_target uuid,
  p_input jsonb,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_copy boolean := coalesce((p_input ->> 'copy')::boolean, false);
  v_copy_deals boolean := coalesce((p_input ->> 'copyDeals')::boolean, false);
  v_include_company boolean := coalesce((p_input ->> 'includeCompany')::boolean, false);
  v_include_contacts boolean := coalesce((p_input ->> 'includeContacts')::boolean, true);
  v_company_ids uuid[];
  v_contact_ids uuid[];
  v_pipeline uuid := nullif(p_input ->> 'pipelineId', '')::uuid;
  v_stage uuid := nullif(p_input ->> 'stageId', '')::uuid;
  v_pipeline_kind text;
  v_pipeline_name text;
  v_source_name text;
  v_target_name text;
  v_missing integer;
  v_conflict text;
  v_proposal_conflict text;
  v_link record;
  v_match uuid;
  v_now timestamptz := now();
  v_source_role text;
  v_can_move boolean;
  v_result jsonb;
begin
  select coalesce(array_agg(distinct value::uuid), '{}') into v_company_ids
  from jsonb_array_elements_text(coalesce(p_input -> 'companyIds', '[]'::jsonb));
  select coalesce(array_agg(distinct value::uuid), '{}') into v_contact_ids
  from jsonb_array_elements_text(coalesce(p_input -> 'contactIds', '[]'::jsonb));

  if p_source = p_target then
    raise exception 'Pick another workspace.' using errcode = '22023';
  end if;
  select w.name, m.role into v_source_name, v_source_role
  from crm.workspaces w
  join crm.workspace_members m on m.workspace_id = w.id and m.user_id = p_user
  where w.id = p_source;
  if not found then
    raise exception 'You''re not in that workspace.' using errcode = '42501';
  end if;
  select w.name into v_target_name
  from crm.workspaces w
  join crm.workspace_members m on m.workspace_id = w.id and m.user_id = p_user
  where w.id = p_target;
  if not found then
    raise exception 'You''re not in that workspace.' using errcode = '42501';
  end if;
  v_can_move := v_source_role in ('owner', 'admin');
  if not v_copy and not v_can_move and not p_dry_run then
    raise exception 'Only an owner or admin of % can move records out of it. You can copy them instead.', v_source_name using errcode = '42501';
  end if;
  if cardinality(v_company_ids) + cardinality(v_contact_ids) = 0 then
    raise exception 'Pick a company or contact to move.' using errcode = '22023';
  end if;
  if cardinality(v_company_ids) + cardinality(v_contact_ids) > 100 then
    raise exception 'Move up to 100 records at a time.' using errcode = '22023';
  end if;

  perform 1 from crm.companies c where c.id = any(v_company_ids) order by c.id for update;
  perform 1 from crm.contacts c where c.id = any(v_contact_ids) order by c.id for update;

  select count(*) into v_missing
  from unnest(v_company_ids) as wanted(id)
  where not exists (
    select 1 from crm.companies c where c.id = wanted.id and c.workspace_id = p_source and c.archived_at is null
  );
  if v_missing > 0 then
    raise exception 'Some of these companies aren''t in %, or are archived.', v_source_name using errcode = 'P0002';
  end if;
  select count(*) into v_missing
  from unnest(v_contact_ids) as wanted(id)
  where not exists (
    select 1 from crm.contacts c where c.id = wanted.id and c.workspace_id = p_source and c.archived_at is null
  );
  if v_missing > 0 then
    raise exception 'Some of these people aren''t in %, or are archived.', v_source_name using errcode = 'P0002';
  end if;

  create temporary table if not exists orbit_move_map (
    kind text not null,
    old_id uuid not null,
    new_id uuid,
    merged boolean not null default false,
    stage_id uuid,
    primary key (kind, old_id)
  ) on commit drop;
  delete from pg_temp.orbit_move_map;

  insert into pg_temp.orbit_move_map (kind, old_id)
  select 'company', id from unnest(v_company_ids) as id
  on conflict do nothing;

  for v_link in
    select distinct c.company_id
    from crm.contacts c
    where c.id = any(v_contact_ids)
      and c.company_id is not null
      and not (c.company_id = any(v_company_ids))
  loop
    v_match := case when v_include_company then null else private.move_company_match(v_link.company_id, p_target) end;
    if v_include_company then
      insert into pg_temp.orbit_move_map (kind, old_id)
      values ('company', v_link.company_id)
      on conflict do nothing;
    elsif v_match is not null then
      insert into pg_temp.orbit_move_map (kind, old_id, new_id, merged)
      values ('company_link', v_link.company_id, v_match, true);
    elsif exists (
      select 1 from crm.contacts o
      where o.workspace_id = p_source
        and o.company_id = v_link.company_id
        and o.archived_at is null
        and not (o.id = any(v_contact_ids))
    ) then
      insert into pg_temp.orbit_move_map (kind, old_id, new_id, merged)
      values ('company_link', v_link.company_id, gen_random_uuid(), false);
    else
      insert into pg_temp.orbit_move_map (kind, old_id)
      values ('company', v_link.company_id)
      on conflict do nothing;
    end if;
  end loop;

  update pg_temp.orbit_move_map m
  set new_id = coalesce(found.match, case when v_copy then gen_random_uuid() else m.old_id end),
      merged = found.match is not null
  from (
    select item.old_id, private.move_company_match(item.old_id, p_target) as match
    from pg_temp.orbit_move_map item
    where item.kind = 'company'
  ) found
  where m.kind = 'company' and m.old_id = found.old_id;

  insert into pg_temp.orbit_move_map (kind, old_id)
  select 'contact', id from unnest(v_contact_ids) as id
  on conflict do nothing;
  insert into pg_temp.orbit_move_map (kind, old_id)
  select 'contact', c.id
  from crm.contacts c
  where c.workspace_id = p_source
    and c.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
    and (not v_copy or c.archived_at is null)
    and (v_include_contacts or not (c.company_id = any(v_company_ids)))
  on conflict do nothing;

  if not v_copy then
    insert into pg_temp.orbit_move_map (kind, old_id)
    select distinct 'proposal_contact', c.id
    from crm.documents d
    join crm.contacts c on c.id = d.contact_id
    where d.workspace_id = p_source
      and d.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
      and c.workspace_id = p_source
      and not exists (select 1 from pg_temp.orbit_move_map item where item.kind = 'contact' and item.old_id = c.id)
    on conflict do nothing;
    insert into pg_temp.orbit_move_map (kind, old_id)
    select 'contact', m.old_id from pg_temp.orbit_move_map m where m.kind = 'proposal_contact'
    on conflict do nothing;
    for v_link in
      select distinct c.company_id
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      where m.kind = 'proposal_contact'
        and c.company_id is not null
        and not exists (
          select 1 from pg_temp.orbit_move_map item where item.kind in ('company', 'company_link') and item.old_id = c.company_id
        )
    loop
      v_match := private.move_company_match(v_link.company_id, p_target);
      insert into pg_temp.orbit_move_map (kind, old_id, new_id, merged)
      values ('company_link', v_link.company_id, coalesce(v_match, gen_random_uuid()), v_match is not null);
    end loop;
  end if;

  if not v_include_contacts then
    insert into pg_temp.orbit_move_map (kind, old_id)
    select 'contact_stay', c.id
    from crm.contacts c
    where c.workspace_id = p_source
      and c.company_id = any(v_company_ids)
      and not exists (select 1 from pg_temp.orbit_move_map item where item.kind = 'contact' and item.old_id = c.id)
    on conflict do nothing;
  end if;

  update pg_temp.orbit_move_map m
  set new_id = coalesce(found.match, case when v_copy then gen_random_uuid() else m.old_id end),
      merged = found.match is not null
  from (
    select item.old_id, private.move_contact_match(item.old_id, p_target) as match
    from pg_temp.orbit_move_map item
    where item.kind = 'contact'
  ) found
  where m.kind = 'contact' and m.old_id = found.old_id;

  insert into pg_temp.orbit_move_map (kind, old_id, new_id)
  select
    case when p.kind = 'board' then 'board_card' else 'deal' end,
    o.id,
    case when p.kind = 'board' then null when v_copy then gen_random_uuid() else o.id end
  from crm.opportunities o
  left join crm.pipelines p on p.id = o.pipeline_id
  where o.workspace_id = p_source
    and o.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
    and (not v_copy or (v_copy_deals and o.archived_at is null and coalesce(p.kind, 'sales') <> 'board'));

  if exists (select 1 from pg_temp.orbit_move_map m where m.kind = 'deal') or p_dry_run then
    if v_pipeline is null then
      select p.id into v_pipeline
      from crm.pipelines p
      where p.workspace_id = p_target and p.archived_at is null
      order by p.is_default desc, (p.kind = 'sales') desc, p.position, p.created_at
      limit 1;
    end if;
    select p.kind, p.name into v_pipeline_kind, v_pipeline_name
    from crm.pipelines p
    where p.id = v_pipeline and p.workspace_id = p_target and p.archived_at is null;
    if not found and exists (select 1 from pg_temp.orbit_move_map m where m.kind = 'deal') then
      raise exception 'Pick where the deals go in %.', v_target_name using errcode = '22023';
    end if;
    if v_stage is not null and not exists (
      select 1 from crm.pipeline_stages s where s.id = v_stage and s.pipeline_id = v_pipeline
    ) then
      raise exception 'Pick a stage on %.', coalesce(v_pipeline_name, 'that board') using errcode = '22023';
    end if;
    if exists (select 1 from pg_temp.orbit_move_map m where m.kind = 'deal')
      and not exists (select 1 from crm.pipeline_stages s where s.pipeline_id = v_pipeline) then
      raise exception '% has no stages.', v_pipeline_name using errcode = '22023';
    end if;
  end if;

  update pg_temp.orbit_move_map m
  set stage_id = private.move_deal_stage(o.stage_id, o.status, v_pipeline, v_stage)
  from crm.opportunities o
  where m.kind = 'deal' and o.id = m.old_id;

  if v_pipeline_kind = 'board' then
    select s.name into v_conflict
    from pg_temp.orbit_move_map mc
    join crm.companies s on s.id = mc.old_id
    where mc.kind = 'company'
      and (
        select count(*) from pg_temp.orbit_move_map d
        join crm.opportunities o on o.id = d.old_id
        where d.kind = 'deal' and o.company_id = mc.old_id and o.archived_at is null
      ) + (
        select count(*) from crm.opportunities e
        where e.workspace_id = p_target and e.pipeline_id = v_pipeline and e.company_id = mc.new_id and e.archived_at is null
      ) > 1
    limit 1;
    if v_conflict is not null and not p_dry_run then
      raise exception '% would have more than one card on %. Put the deals on a pipeline instead.', v_conflict, v_pipeline_name using errcode = '22023';
    end if;
  end if;

  insert into pg_temp.orbit_move_map (kind, old_id, new_id)
  select 'activity', a.id, case when v_copy then gen_random_uuid() else a.id end
  from crm.activities a
  where a.workspace_id = p_source
    and (not v_copy or a.archived_at is null)
    and (v_copy or not exists (select 1 from pg_temp.orbit_move_map s where s.kind = 'contact_stay' and s.old_id = a.contact_id))
    and (
      a.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
      or a.contact_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'contact')
      or a.opportunity_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind in ('deal', 'board_card'))
    );

  if not v_copy then
    insert into pg_temp.orbit_move_map (kind, old_id, new_id)
    select 'task', t.id, t.id
    from crm.tasks t
    where t.workspace_id = p_source
      and not exists (select 1 from pg_temp.orbit_move_map s where s.kind = 'contact_stay' and s.old_id = t.contact_id)
      and (
        t.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
        or t.contact_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'contact')
        or t.opportunity_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind in ('deal', 'board_card'))
      );
    insert into pg_temp.orbit_move_map (kind, old_id, new_id)
    select 'document', d.id, d.id
    from crm.documents d
    where d.workspace_id = p_source
      and (
        d.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
        or (
          d.contact_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'contact')
          and d.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company_link')
        )
      );
    select format(
      '%s is named on %s''s %s ''%s''. Move %s too, or change the %s''s contact first.',
      coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Someone'),
      co.name,
      case when d.kind = 'nda' then 'NDA' else 'proposal' end,
      d.title,
      co.name,
      case when d.kind = 'nda' then 'NDA' else 'proposal' end
    ) into v_proposal_conflict
    from crm.documents d
    join pg_temp.orbit_move_map m on m.kind = 'contact' and m.old_id = d.contact_id
    join crm.contacts c on c.id = d.contact_id
    join crm.companies co on co.id = d.company_id
    where d.workspace_id = p_source
      and not exists (select 1 from pg_temp.orbit_move_map item where item.kind = 'document' and item.old_id = d.id)
    order by d.archived_at is not null, co.name, d.title, d.id
    limit 1;
    if v_proposal_conflict is not null and not p_dry_run then
      raise exception '%', v_proposal_conflict using errcode = '22023';
    end if;
    insert into pg_temp.orbit_move_map (kind, old_id, new_id)
    select 'knowledge', k.id, k.id
    from crm.knowledge_items k
    where k.workspace_id = p_source
      and k.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company');
  end if;

  v_result := jsonb_build_object(
    'source', jsonb_build_object('id', p_source, 'name', v_source_name),
    'target', jsonb_build_object('id', p_target, 'name', v_target_name),
    'copy', v_copy,
    'companies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.old_id, 'name', c.name, 'targetId', m.new_id, 'merged', m.merged,
        'targetName', t.name, 'selected', m.old_id = any(v_company_ids),
        'deals', coalesce((
          select jsonb_agg(jsonb_build_object('id', o.id, 'targetId', d.new_id, 'name', o.name, 'stage', st.name) order by o.name)
          from pg_temp.orbit_move_map d
          join crm.opportunities o on o.id = d.old_id
          left join crm.pipeline_stages st on st.id = d.stage_id
          where d.kind = 'deal' and o.company_id = m.old_id
        ), '[]'::jsonb),
        'boardCards', (
          select count(*) from pg_temp.orbit_move_map d
          join crm.opportunities o on o.id = d.old_id
          where d.kind = 'board_card' and o.company_id = m.old_id
        )
      ) order by c.name)
      from pg_temp.orbit_move_map m
      join crm.companies c on c.id = m.old_id
      left join crm.companies t on t.id = m.new_id and m.merged
      where m.kind = 'company'
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.old_id, 'name', c.name, 'targetId', m.new_id, 'merged', m.merged, 'targetName', coalesce(t.name, c.name)
      ) order by c.name)
      from pg_temp.orbit_move_map m
      join crm.companies c on c.id = m.old_id
      left join crm.companies t on t.id = m.new_id and m.merged
      where m.kind = 'company_link'
    ), '[]'::jsonb),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.old_id,
        'name', coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Unnamed'),
        'targetId', m.new_id, 'merged', m.merged,
        'targetName', coalesce(nullif(btrim(concat_ws(' ', t.first_name, t.last_name)), ''), t.email),
        'selected', m.old_id = any(v_contact_ids),
        'archived', c.archived_at is not null,
        'companyId', c.company_id
      ) order by c.first_name, c.last_name)
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      left join crm.contacts t on t.id = m.new_id and m.merged
      where m.kind = 'contact'
    ), '[]'::jsonb),
    'deals', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'deal'),
    'dealsAvailable', (
      select count(*) from crm.opportunities o
      left join crm.pipelines p on p.id = o.pipeline_id
      where o.workspace_id = p_source and o.archived_at is null and coalesce(p.kind, 'sales') <> 'board'
        and o.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
    ),
    'dealStages', coalesce((
      select jsonb_agg(distinct s.name)
      from crm.opportunities o
      left join crm.pipelines p on p.id = o.pipeline_id
      join crm.pipeline_stages s on s.id = o.stage_id
      where o.workspace_id = p_source and o.archived_at is null and coalesce(p.kind, 'sales') <> 'board'
        and o.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
    ), '[]'::jsonb),
    'boardCards', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'board_card'),
    'boards', coalesce((
      select jsonb_agg(distinct p.name)
      from pg_temp.orbit_move_map m
      join crm.opportunities o on o.id = m.old_id
      join crm.pipelines p on p.id = o.pipeline_id
      where m.kind = 'board_card' and o.archived_at is null
    ), '[]'::jsonb),
    'activities', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'activity'),
    'tasks', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'task'),
    'documents', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'document'),
    'knowledge', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'knowledge'),
    'pipelineId', v_pipeline,
    'pipelineName', v_pipeline_name,
    'pipelineKind', v_pipeline_kind,
    'stageName', (select s.name from crm.pipeline_stages s where s.id = v_stage),
    'canMove', v_can_move,
    'boardConflict', v_conflict,
    'proposalConflict', v_proposal_conflict,
    'includeCompany', v_include_company,
    'includeContacts', v_include_contacts,
    'contactCompanies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', co.id,
        'name', co.name,
        'others', (
          select count(*) from crm.contacts o
          where o.workspace_id = p_source and o.company_id = co.id and (not v_copy or o.archived_at is null)
            and not (o.id = any(v_contact_ids))
        )
      ) order by co.name)
      from crm.companies co
      where co.workspace_id = p_source
        and not (co.id = any(v_company_ids))
        and co.id in (select c.company_id from crm.contacts c where c.id = any(v_contact_ids))
    ), '[]'::jsonb),
    'companyContacts', (
      select count(*) from crm.contacts o
      where o.workspace_id = p_source and o.company_id = any(v_company_ids) and (not v_copy or o.archived_at is null)
        and not (o.id = any(v_contact_ids))
    ),
    'leftBehind', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Unnamed'),
        'companyId', c.company_id,
        'archived', c.archived_at is not null
      ) order by c.first_name, c.last_name)
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      where m.kind = 'contact_stay' and not v_copy
    ), '[]'::jsonb),
    'notCopied', coalesce((
      select jsonb_agg(coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Unnamed') order by c.first_name, c.last_name)
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      where m.kind = 'contact_stay' and v_copy and c.archived_at is null
    ), '[]'::jsonb),
    'proposalContacts', coalesce((
      select jsonb_agg(coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Unnamed') order by c.first_name, c.last_name)
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      where m.kind = 'proposal_contact'
    ), '[]'::jsonb),
    'dealsLosingContact', (
      select count(*) from pg_temp.orbit_move_map d
      join crm.opportunities o on o.id = d.old_id
      join pg_temp.orbit_move_map s on s.kind = 'contact_stay' and s.old_id = o.primary_contact_id
      where d.kind = 'deal'
    )
  );

  if p_dry_run then
    return v_result;
  end if;

  perform set_config('orbit.merging', 'on', true);

  if not v_copy then
    update crm.companies c
    set workspace_id = p_target,
        owner_id = private.move_owner(c.owner_id, p_target, p_user),
        archived_at = case when m.merged then v_now else c.archived_at end
    from pg_temp.orbit_move_map m
    where m.kind = 'company' and m.old_id = c.id;

    update crm.contacts p
    set company_id = null
    from pg_temp.orbit_move_map m
    where m.kind = 'contact_stay' and m.old_id = p.id and p.workspace_id = p_source;
  end if;

  insert into crm.companies (
    id, workspace_id, name, normalized_name, domain, website, description, industry, size_category,
    lifecycle, owner_id, source, source_reference, created_by_user_id, tags, linkedin_url, phone,
    address, logo_url, enriched_at, brand, archived_at
  )
  select
    m.new_id, p_target, c.name, c.normalized_name, c.domain, c.website, c.description, c.industry, c.size_category,
    c.lifecycle, private.move_owner(c.owner_id, p_target, p_user), c.source, c.source_reference, p_user, c.tags,
    c.linkedin_url, c.phone, c.address, c.logo_url, c.enriched_at, c.brand, c.archived_at
  from pg_temp.orbit_move_map m
  join crm.companies c on c.id = m.old_id
  where not m.merged and (m.kind = 'company_link' or (v_copy and m.kind = 'company'));

  if not v_copy then
    update crm.contacts p
    set workspace_id = p_target,
        company_id = (
          select mc.new_id from pg_temp.orbit_move_map mc
          where mc.kind in ('company', 'company_link') and mc.old_id = p.company_id
        ),
        owner_id = private.move_owner(p.owner_id, p_target, p_user),
        archived_at = case when m.merged then coalesce(p.archived_at, v_now) else p.archived_at end
    from pg_temp.orbit_move_map m
    where m.kind = 'contact' and m.old_id = p.id;
  else
    insert into crm.contacts (
      id, workspace_id, company_id, first_name, last_name, email, normalized_email, phone, job_title,
      linkedin_url, normalized_linkedin, owner_id, source, source_reference, notes, created_by_user_id,
      tags, location, sales_navigator_url
    )
    select
      m.new_id, p_target,
      (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind in ('company', 'company_link') and mc.old_id = p.company_id),
      p.first_name, p.last_name, p.email, p.normalized_email, p.phone, p.job_title,
      p.linkedin_url, p.normalized_linkedin, private.move_owner(p.owner_id, p_target, p_user), p.source,
      p.source_reference, p.notes, p_user, p.tags, p.location, p.sales_navigator_url
    from pg_temp.orbit_move_map m
    join crm.contacts p on p.id = m.old_id
    where m.kind = 'contact' and not m.merged;
    update crm.contacts k
    set company_id = (
      select mc.new_id from pg_temp.orbit_move_map mc
      where mc.kind in ('company', 'company_link') and mc.old_id = p.company_id
    )
    from pg_temp.orbit_move_map m
    join crm.contacts p on p.id = m.old_id
    where m.kind = 'contact' and m.merged and k.id = m.new_id and k.company_id is null and p.company_id is not null;
  end if;

  if not v_copy then
    update crm.opportunities o
    set workspace_id = p_target,
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = o.company_id),
        primary_contact_id = (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = o.primary_contact_id),
        pipeline_id = v_pipeline,
        stage_id = m.stage_id,
        status = case when s.is_won then 'won' when s.is_lost then 'lost' else 'open' end,
        owner_id = private.move_owner(o.owner_id, p_target, p_user)
    from pg_temp.orbit_move_map m
    join crm.pipeline_stages s on s.id = m.stage_id
    where m.kind = 'deal' and m.old_id = o.id;
  else
    insert into crm.opportunities (
      id, workspace_id, company_id, primary_contact_id, pipeline_id, stage_id, name, value, currency,
      probability, expected_close_date, owner_id, status, source, created_by_user_id
    )
    select
      m.new_id, p_target,
      (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = o.company_id),
      (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = o.primary_contact_id),
      v_pipeline, m.stage_id, o.name, o.value, o.currency, o.probability, o.expected_close_date,
      private.move_owner(o.owner_id, p_target, p_user),
      case when s.is_won then 'won' when s.is_lost then 'lost' else 'open' end,
      o.source, p_user
    from pg_temp.orbit_move_map m
    join crm.opportunities o on o.id = m.old_id
    join crm.pipeline_stages s on s.id = m.stage_id
    where m.kind = 'deal';
  end if;

  if not v_copy then
    update crm.tasks t
    set workspace_id = p_target,
        company_id = coalesce(
          (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind in ('company', 'company_link') and mc.old_id = t.company_id),
          (select mc.new_id from crm.opportunities o join pg_temp.orbit_move_map mc on mc.kind = 'company' and mc.old_id = o.company_id
           where o.id = t.opportunity_id),
          (select mc.new_id from crm.contacts p join pg_temp.orbit_move_map mc on mc.kind in ('company', 'company_link') and mc.old_id = p.company_id
           where p.id = t.contact_id and t.company_id is not null)
        ),
        contact_id = (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = t.contact_id),
        opportunity_id = (select md.new_id from pg_temp.orbit_move_map md where md.kind = 'deal' and md.old_id = t.opportunity_id),
        owner_id = private.move_owner(t.owner_id, p_target, p_user)
    from pg_temp.orbit_move_map m
    where m.kind = 'task' and m.old_id = t.id;

    update crm.activities a
    set workspace_id = p_target,
        company_id = coalesce(
          (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind in ('company', 'company_link') and mc.old_id = a.company_id),
          (select mc.new_id from crm.opportunities o join pg_temp.orbit_move_map mc on mc.kind = 'company' and mc.old_id = o.company_id
           where o.id = a.opportunity_id),
          (select mc.new_id from crm.contacts p join pg_temp.orbit_move_map mc on mc.kind in ('company', 'company_link') and mc.old_id = p.company_id
           where p.id = a.contact_id and a.company_id is not null)
        ),
        contact_id = (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = a.contact_id),
        opportunity_id = (select md.new_id from pg_temp.orbit_move_map md where md.kind = 'deal' and md.old_id = a.opportunity_id)
    from pg_temp.orbit_move_map m
    where m.kind = 'activity' and m.old_id = a.id;

    update crm.activities a
    set company_id = case when a.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else a.company_id end,
        opportunity_id = case when a.opportunity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card')) then null else a.opportunity_id end
    where a.workspace_id = p_source
      and (
        a.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or a.opportunity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card'))
      );

    update crm.tasks t
    set company_id = case when t.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else t.company_id end,
        opportunity_id = case when t.opportunity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card')) then null else t.opportunity_id end
    where t.workspace_id = p_source
      and (
        t.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or t.opportunity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind in ('deal', 'board_card'))
      );

    update crm.companies c
    set health_activity_id = null
    where c.workspace_id = p_source
      and c.health_activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity');

    update crm.companies c
    set health_activity_id = null
    from crm.activities a
    where c.id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
      and a.id = c.health_activity_id
      and a.workspace_id <> c.workspace_id;

    update crm.activity_tones x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'activity' and m.old_id = x.activity_id;
    update crm.activity_tone_failures x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'activity' and m.old_id = x.activity_id;

    update crm.call_insights x
    set workspace_id = p_target,
        company_id = a.company_id,
        contact_id = a.contact_id
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity' and x.activity_id = m.old_id;

    update crm.follow_up_suggestions x
    set workspace_id = p_target,
        company_id = a.company_id,
        contact_id = a.contact_id
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity' and x.activity_id = m.old_id;

    update crm.call_records x
    set workspace_id = p_target,
        company_id = a.company_id,
        contact_id = a.contact_id
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity' and x.activity_id = m.old_id and x.workspace_id = p_source
      and not exists (
        select 1 from crm.call_records y where y.workspace_id = p_target and y.provider_call_id = x.provider_call_id
      );

    update crm.email_messages x
    set workspace_id = p_target,
        company_id = a.company_id,
        contact_id = a.contact_id
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity' and x.activity_id = m.old_id and x.workspace_id = p_source
      and not exists (
        select 1 from crm.email_messages y where y.workspace_id = p_target and y.provider_message_id = x.provider_message_id
      );

    update crm.conversation_imports x
    set workspace_id = p_target,
        company_id = a.company_id,
        contact_id = a.contact_id
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity' and x.activity_id = m.old_id and x.workspace_id = p_source
      and not exists (
        select 1 from crm.conversation_imports y
        where y.workspace_id = p_target and y.source = x.source and y.external_id = x.external_id
          and (x.source = 'granola' or y.user_id = x.user_id)
      );

    update crm.call_records x
    set activity_id = case when x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity') then null else x.activity_id end,
        company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end,
        contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end
    where x.workspace_id = p_source
      and (
        x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity')
        or x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );

    update crm.email_messages x
    set activity_id = case when x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity') then null else x.activity_id end,
        company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end,
        contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end
    where x.workspace_id = p_source
      and (
        x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity')
        or x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );

    update crm.conversation_imports x
    set activity_id = case when x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity') then null else x.activity_id end,
        company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end,
        contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end
    where x.workspace_id = p_source
      and (
        x.activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity')
        or x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );

    update crm.follow_up_suggestions x
    set company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end,
        contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end
    where x.workspace_id = p_source
      and (
        x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );

    update crm.call_insights x
    set company_id = case when x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company') then null else x.company_id end,
        contact_id = case when x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact') then null else x.contact_id end
    where x.workspace_id = p_source
      and (
        x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or x.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );

    update crm.documents d
    set workspace_id = p_target,
        company_id = (
          select mc.new_id from pg_temp.orbit_move_map mc
          where mc.kind in ('company', 'company_link') and mc.old_id = d.company_id
        ),
        contact_id = (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = d.contact_id),
        opportunity_id = (select md.new_id from pg_temp.orbit_move_map md where md.kind = 'deal' and md.old_id = d.opportunity_id),
        template_id = case
          when exists (select 1 from crm.document_templates t where t.id = d.template_id and t.workspace_id = p_target) then d.template_id
          else null
        end,
        owner_id = private.move_owner(d.owner_id, p_target, p_user)
    from pg_temp.orbit_move_map m
    where m.kind = 'document' and m.old_id = d.id;
    update crm.document_versions x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.document_events x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.document_files x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.document_links x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.document_signatures x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.document_steps x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'document' and m.old_id = x.document_id;
    update crm.knowledge_items k
    set workspace_id = p_target,
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = k.company_id),
        source_ref = case
          when k.source_ref is not null and exists (
            select 1 from crm.knowledge_items y
            where y.workspace_id = p_target and y.source_ref = k.source_ref and y.archived_at is null
          ) then null
          else k.source_ref
        end
    from pg_temp.orbit_move_map m
    where m.kind = 'knowledge' and m.old_id = k.id;
    update crm.knowledge_chunks x set workspace_id = p_target
    from pg_temp.orbit_move_map m where m.kind = 'knowledge' and m.old_id = x.item_id;
    update crm.readwise_documents x set knowledge_item_id = null
    where x.workspace_id = p_source
      and x.knowledge_item_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'knowledge');

    update crm.memories x
    set workspace_id = p_target,
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = x.company_id)
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');

    update crm.market_notes x
    set workspace_id = p_target,
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = x.company_id)
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
      and (x.url is null or not exists (select 1 from crm.market_notes y where y.workspace_id = p_target and y.url = x.url));
    update crm.market_notes x set company_id = null
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');

    update crm.watchlist x
    set workspace_id = p_target,
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = x.company_id)
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
      and not exists (
        select 1 from crm.watchlist y where y.workspace_id = p_target and y.kind = x.kind and lower(y.label) = lower(x.label)
      );
    update crm.watchlist x set company_id = null
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');

    update crm.enrichment_lookups x
    set workspace_id = p_target,
        record_id = m.new_id
    from pg_temp.orbit_move_map m
    where x.workspace_id = p_source
      and ((x.record_type = 'company' and m.kind = 'company') or (x.record_type = 'contact' and m.kind = 'contact'))
      and m.old_id = x.record_id;

    delete from crm.company_web_state x
    where x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');
    delete from crm.company_signals x
    where x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');
    delete from crm.ai_field_answers x
    where x.workspace_id = p_source
      and x.company_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company');

    update crm.opportunities o
    set primary_contact_id = null
    where o.workspace_id = p_source
      and o.primary_contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact');

    update crm.documents d set opportunity_id = null
    where d.opportunity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'board_card');
    delete from crm.opportunities o
    where o.id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'board_card');

    update crm.mail_thread_routes x
    set contact_id = m.new_id
    from pg_temp.orbit_move_map m
    where m.kind = 'contact' and m.merged and x.contact_id = m.old_id;
  else
    insert into crm.activities (
      id, workspace_id, type, title, body, occurred_at, company_id, contact_id, opportunity_id,
      actor_user_id, actor_agent_id, metadata
    )
    select
      m.new_id, p_target, a.type, a.title, a.body, a.occurred_at,
      coalesce(
        (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind in ('company', 'company_link') and mc.old_id = a.company_id),
        (select mc.new_id from crm.opportunities o join pg_temp.orbit_move_map mc on mc.kind = 'company' and mc.old_id = o.company_id
         where o.id = a.opportunity_id),
        (select mc.new_id from crm.contacts p join pg_temp.orbit_move_map mc on mc.kind in ('company', 'company_link') and mc.old_id = p.company_id
         where p.id = a.contact_id and a.company_id is not null)
      ),
      (select mp.new_id from pg_temp.orbit_move_map mp where mp.kind = 'contact' and mp.old_id = a.contact_id),
      (select md.new_id from pg_temp.orbit_move_map md where md.kind = 'deal' and md.old_id = a.opportunity_id),
      a.actor_user_id, a.actor_agent_id, a.metadata
    from pg_temp.orbit_move_map m
    join crm.activities a on a.id = m.old_id
    where m.kind = 'activity';

    insert into crm.call_insights (
      workspace_id, activity_id, contact_id, company_id, source, transcript, summary, key_points,
      action_items, model, status, error, sentiment, sentiment_reason, sentiment_checked_at
    )
    select
      p_target, m.new_id, a.contact_id, a.company_id, x.source, x.transcript, x.summary, x.key_points,
      x.action_items, x.model, x.status, x.error, x.sentiment, x.sentiment_reason, x.sentiment_checked_at
    from pg_temp.orbit_move_map m
    join crm.call_insights x on x.activity_id = m.old_id
    join crm.activities a on a.id = m.new_id
    where m.kind = 'activity';
  end if;

  if not v_copy then
    update crm.calendar_events e
    set company_ids = array(
          select x from unnest(e.company_ids) as x
          where not exists (select 1 from pg_temp.orbit_move_map m where m.kind = 'company' and m.old_id = x)
        ),
        contact_ids = array(
          select x from unnest(e.contact_ids) as x
          where not exists (select 1 from pg_temp.orbit_move_map m where m.kind = 'contact' and m.old_id = x)
        )
    where e.workspace_id = p_source
      and (
        e.company_ids && array(select m.old_id from pg_temp.orbit_move_map m where m.kind = 'company')
        or e.contact_ids && array(select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact')
      );
  end if;

  update crm.calendar_events e
  set company_ids = array_replace(e.company_ids, m.old_id, m.new_id)
  from pg_temp.orbit_move_map m
  where m.kind = 'company' and m.merged and not v_copy
    and m.old_id = any(e.company_ids) and not (m.new_id = any(e.company_ids));
  update crm.calendar_events e
  set company_ids = array_remove(e.company_ids, m.old_id)
  from pg_temp.orbit_move_map m
  where m.kind = 'company' and m.merged and not v_copy and m.old_id = any(e.company_ids);
  update crm.calendar_events e
  set contact_ids = array_replace(e.contact_ids, m.old_id, m.new_id)
  from pg_temp.orbit_move_map m
  where m.kind = 'contact' and m.merged and not v_copy
    and m.old_id = any(e.contact_ids) and not (m.new_id = any(e.contact_ids));
  update crm.calendar_events e
  set contact_ids = array_remove(e.contact_ids, m.old_id)
  from pg_temp.orbit_move_map m
  where m.kind = 'contact' and m.merged and not v_copy and m.old_id = any(e.contact_ids);

  perform set_config('orbit.merging', 'off', true);

  return v_result || jsonb_build_object(
    'activityIds', coalesce((select jsonb_agg(m.new_id) from pg_temp.orbit_move_map m where m.kind = 'activity'), '[]'::jsonb)
  );
end;
$$;

revoke all on function private.move_records_to_workspace(uuid, uuid, uuid, jsonb, boolean) from public;
grant execute on function private.move_records_to_workspace(uuid, uuid, uuid, jsonb, boolean) to crm_app;
