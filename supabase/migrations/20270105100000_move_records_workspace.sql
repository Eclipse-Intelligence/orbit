create or replace function private.move_owner(p_owner uuid, p_workspace uuid, p_user uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when p_owner is null then null
    when exists (select 1 from crm.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_owner) then p_owner
    else p_user
  end;
$$;

create or replace function private.move_company_match(p_company uuid, p_target uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select t.id
  from crm.companies s
  join crm.companies t
    on t.workspace_id = p_target
   and t.archived_at is null
   and (
     (s.domain is not null and t.domain = s.domain)
     or (s.linkedin_url is not null and t.linkedin_url = s.linkedin_url)
     or (s.domain is null and t.domain is null and t.normalized_name = s.normalized_name)
   )
  where s.id = p_company
  order by
    case
      when s.domain is not null and t.domain = s.domain then 0
      when s.linkedin_url is not null and t.linkedin_url = s.linkedin_url then 1
      else 2
    end,
    t.updated_at desc
  limit 1;
$$;

create or replace function private.move_contact_match(p_contact uuid, p_target uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select t.id
  from crm.contacts s
  join crm.contacts t
    on t.workspace_id = p_target
   and t.archived_at is null
   and (
     (s.normalized_email is not null and t.normalized_email = s.normalized_email)
     or (s.normalized_linkedin is not null and t.normalized_linkedin = s.normalized_linkedin)
     or (s.sales_navigator_url is not null and t.sales_navigator_url = s.sales_navigator_url)
   )
  where s.id = p_contact
    and s.archived_at is null
  order by
    case
      when s.normalized_email is not null and t.normalized_email = s.normalized_email then 0
      when s.normalized_linkedin is not null and t.normalized_linkedin = s.normalized_linkedin then 1
      else 2
    end,
    t.updated_at desc
  limit 1;
$$;

create or replace function private.move_deal_stage(p_stage uuid, p_status text, p_pipeline uuid, p_chosen uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(
    p_chosen,
    (
      select t.id from crm.pipeline_stages t
      join crm.pipeline_stages s on s.id = p_stage
      where t.pipeline_id = p_pipeline and lower(btrim(t.name)) = lower(btrim(s.name))
      order by t.position
      limit 1
    ),
    (
      select t.id from crm.pipeline_stages t
      where t.pipeline_id = p_pipeline
        and ((p_status = 'won' and t.is_won) or (p_status = 'lost' and t.is_lost))
      order by t.position
      limit 1
    ),
    (
      select t.id from crm.pipeline_stages t
      where t.pipeline_id = p_pipeline
      order by t.position
      limit 1
    )
  );
$$;

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
  v_link record;
  v_match uuid;
  v_now timestamptz := now();
  v_result jsonb;
begin
  select coalesce(array_agg(distinct value::uuid), '{}') into v_company_ids
  from jsonb_array_elements_text(coalesce(p_input -> 'companyIds', '[]'::jsonb));
  select coalesce(array_agg(distinct value::uuid), '{}') into v_contact_ids
  from jsonb_array_elements_text(coalesce(p_input -> 'contactIds', '[]'::jsonb));

  if p_source = p_target then
    raise exception 'Pick another workspace.' using errcode = '22023';
  end if;
  select w.name into v_source_name
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
    v_match := private.move_company_match(v_link.company_id, p_target);
    if v_match is not null then
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
  on conflict do nothing;

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
      and (
        t.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company')
        or t.contact_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'contact')
        or t.opportunity_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind in ('deal', 'board_card'))
      );
    insert into pg_temp.orbit_move_map (kind, old_id, new_id)
    select 'document', d.id, d.id
    from crm.documents d
    where d.workspace_id = p_source
      and d.company_id in (select item.old_id from pg_temp.orbit_move_map item where item.kind = 'company');
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
        'targetName', t.name, 'selected', m.old_id = any(v_company_ids)
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
        'archived', c.archived_at is not null
      ) order by c.first_name, c.last_name)
      from pg_temp.orbit_move_map m
      join crm.contacts c on c.id = m.old_id
      left join crm.contacts t on t.id = m.new_id and m.merged
      where m.kind = 'contact'
    ), '[]'::jsonb),
    'deals', (select count(*) from pg_temp.orbit_move_map m where m.kind = 'deal'),
    'dealIds', coalesce((select jsonb_agg(m.new_id) from pg_temp.orbit_move_map m where m.kind = 'deal'), '[]'::jsonb),
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
    'boardConflict', v_conflict
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
  end if;

  insert into crm.companies (
    id, workspace_id, name, normalized_name, domain, website, description, industry, size_category,
    lifecycle, owner_id, source, source_reference, created_by_user_id, tags, linkedin_url, phone,
    address, logo_url, enriched_at, brand
  )
  select
    m.new_id, p_target, c.name, c.normalized_name, c.domain, c.website, c.description, c.industry, c.size_category,
    c.lifecycle, private.move_owner(c.owner_id, p_target, p_user), c.source, c.source_reference, p_user, c.tags,
    c.linkedin_url, c.phone, c.address, c.logo_url, c.enriched_at, c.brand
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

    update crm.companies c
    set health_activity_id = null
    where c.workspace_id = p_source
      and c.health_activity_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'activity');

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
        company_id = (select mc.new_id from pg_temp.orbit_move_map mc where mc.kind = 'company' and mc.old_id = d.company_id),
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
    update crm.documents d
    set contact_id = null
    where d.workspace_id = p_source
      and d.contact_id in (select m.old_id from pg_temp.orbit_move_map m where m.kind = 'contact');

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

revoke all on function private.move_owner(uuid, uuid, uuid) from public;
revoke all on function private.move_company_match(uuid, uuid) from public;
revoke all on function private.move_contact_match(uuid, uuid) from public;
revoke all on function private.move_deal_stage(uuid, text, uuid, uuid) from public;
revoke all on function private.move_records_to_workspace(uuid, uuid, uuid, jsonb, boolean) from public;

grant execute on function private.move_records_to_workspace(uuid, uuid, uuid, jsonb, boolean) to crm_app;
