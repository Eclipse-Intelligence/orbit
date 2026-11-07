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
  ai_winners uuid[];
  ai_moved integer;
  follow_ups integer;
  links_dropped integer;
  links_moved integer;
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

  update crm.follow_up_suggestions f set company_id = p_keep where f.company_id = p_merge;
  get diagnostics follow_ups = row_count;

  select coalesce(array_agg(m.field_id), '{}'::uuid[])
  into ai_winners
  from crm.ai_field_answers m
  left join crm.ai_field_answers k on k.field_id = m.field_id and k.company_id = p_keep
  where m.company_id = p_merge
    and m.workspace_id = p_workspace
    and (case when m.manual then 3 when m.state = 'answered' then 2 else 1 end)
      > (case when k.field_id is null then 0 when k.manual then 3 when k.state = 'answered' then 2 else 1 end);
  delete from crm.ai_field_answers k
  where k.company_id = p_keep and k.field_id = any(ai_winners);
  update crm.ai_field_answers m
  set company_id = p_keep
  where m.company_id = p_merge and m.field_id = any(ai_winners);
  get diagnostics ai_moved = row_count;

  delete from crm.page_links l
  where l.target_kind = 'company' and l.target_record_id = p_merge
    and exists (
      select 1 from crm.page_links k
      where k.page_id = l.page_id and k.target_kind = 'company' and k.target_record_id = p_keep
    );
  get diagnostics links_dropped = row_count;
  update crm.page_links l
  set target_record_id = p_keep
  where l.target_kind = 'company' and l.target_record_id = p_merge;
  get diagnostics links_moved = row_count;

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
    'ai_field_answers', ai_moved,
    'follow_up_suggestions', follow_ups,
    'page_links', links_dropped + links_moved,
    'combined_cards', combined
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
  calendar_replaced integer;
  calendar_shared integer;
  marks integer;
  follow_ups integer;
  routes integer;
  links_dropped integer;
  links_moved integer;
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
    'page_links', links_dropped + links_moved
  );
end;
$$;

revoke all on function private.merge_company_references(uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) from public;

grant execute on function private.merge_company_references(uuid, uuid, uuid, uuid, uuid) to crm_app;
grant execute on function private.merge_contact_references(uuid, uuid, uuid, uuid, uuid) to crm_app;

create index if not exists audit_events_merged_into_idx on crm.audit_events (entity_id) where changes ? 'mergedInto';
create index if not exists mail_thread_routes_contact_idx on crm.mail_thread_routes (contact_id) where contact_id is not null;
create index if not exists follow_up_suggestions_company_idx on crm.follow_up_suggestions (company_id) where company_id is not null;
create index if not exists follow_up_suggestions_contact_idx on crm.follow_up_suggestions (contact_id) where contact_id is not null;
create index if not exists page_links_target_record_idx on crm.page_links (target_kind, target_record_id) where target_record_id is not null;

create or replace function private.consume_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer,
  p_cost integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  v_cost integer := greatest(1, coalesce(p_cost, 1));
  v_count integer;
begin
  insert into private.rate_limit_buckets as buckets (bucket_key, window_start, request_count)
  values (p_key, v_window, v_cost)
  on conflict (bucket_key) do update
    set request_count = case
          when buckets.window_start = excluded.window_start then buckets.request_count + v_cost
          else v_cost
        end,
        window_start = excluded.window_start
  returning request_count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke all on function private.consume_rate_limit(text, integer, integer, integer) from public;
grant execute on function private.consume_rate_limit(text, integer, integer, integer) to crm_app;
