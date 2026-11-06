create table if not exists crm.company_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  name text not null,
  params text not null default '',
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_views_name_length check (char_length(name) between 1 and 60),
  constraint company_views_params_length check (char_length(params) <= 4000)
);

create unique index if not exists company_views_name_uidx on crm.company_views (workspace_id, lower(name));
create index if not exists company_views_created_by_idx on crm.company_views (created_by_user_id);

drop trigger if exists company_views_set_updated_at on crm.company_views;
create trigger company_views_set_updated_at
  before update on crm.company_views
  for each row execute function private.set_updated_at();

create table if not exists crm.ai_fields (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  label text not null,
  question text not null,
  kind text not null,
  options text[] not null default '{}',
  multiple boolean not null default false,
  scope text not null default 'all',
  scope_view_id uuid references crm.company_views (id) on delete set null,
  refresh text not null default 'monthly',
  paused boolean not null default false,
  fills_size boolean not null default false,
  web_check_id uuid references crm.web_checks (id) on delete set null,
  position integer not null default 0,
  last_run_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  created_by_user_id uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_fields_label_length check (char_length(label) between 1 and 30),
  constraint ai_fields_question_length check (char_length(question) between 10 and 1000),
  constraint ai_fields_kind check (kind in ('yes_no', 'number', 'text', 'pick')),
  constraint ai_fields_options check (cardinality(options) <= 50),
  constraint ai_fields_scope check (scope in ('all', 'view', 'fit')),
  constraint ai_fields_refresh check (refresh in ('monthly', 'weekly', 'manual')),
  constraint ai_fields_last_error_length check (last_error is null or char_length(last_error) <= 500)
);

create unique index if not exists ai_fields_label_uidx on crm.ai_fields (workspace_id, lower(label));
create index if not exists ai_fields_workspace_idx on crm.ai_fields (workspace_id, position);
create index if not exists ai_fields_scope_view_idx on crm.ai_fields (scope_view_id);
create index if not exists ai_fields_web_check_idx on crm.ai_fields (web_check_id);
create index if not exists ai_fields_created_by_idx on crm.ai_fields (created_by_user_id);

drop trigger if exists ai_fields_set_updated_at on crm.ai_fields;
create trigger ai_fields_set_updated_at
  before update on crm.ai_fields
  for each row execute function private.set_updated_at();

create table if not exists crm.ai_field_answers (
  field_id uuid not null references crm.ai_fields (id) on delete cascade,
  company_id uuid not null references crm.companies (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  state text not null default 'pending',
  value_bool boolean,
  value_number numeric,
  value_text text,
  value_options text[],
  likelihood double precision,
  confidence text,
  reason text,
  sources jsonb not null default '[]'::jsonb,
  checked_at timestamptz,
  next_check_at timestamptz,
  claimed_at timestamptz,
  run_id text,
  run_started_at timestamptz,
  error text,
  manual boolean not null default false,
  manual_at timestamptz,
  manual_by uuid references crm.profiles (id) on delete set null,
  web_answer jsonb,
  primary key (field_id, company_id),
  constraint ai_field_answers_state check (state in ('pending', 'answered', 'unknown')),
  constraint ai_field_answers_confidence check (confidence is null or confidence in ('high', 'medium', 'low')),
  constraint ai_field_answers_text_length check (value_text is null or char_length(value_text) <= 300),
  constraint ai_field_answers_reason_length check (reason is null or char_length(reason) <= 600),
  constraint ai_field_answers_error_length check (error is null or char_length(error) <= 500),
  constraint ai_field_answers_run_id_length check (run_id is null or char_length(run_id) <= 200)
);

create index if not exists ai_field_answers_company_idx on crm.ai_field_answers (company_id);
create index if not exists ai_field_answers_workspace_idx on crm.ai_field_answers (workspace_id, field_id);
create index if not exists ai_field_answers_due_idx on crm.ai_field_answers (field_id, next_check_at) where not manual;
create index if not exists ai_field_answers_run_idx on crm.ai_field_answers (workspace_id, run_id) where run_id is not null;
create index if not exists ai_field_answers_manual_by_idx on crm.ai_field_answers (manual_by);

create table if not exists crm.ai_field_hidden (
  user_id uuid not null references crm.profiles (id) on delete cascade,
  field_id uuid not null references crm.ai_fields (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, field_id)
);

create index if not exists ai_field_hidden_field_idx on crm.ai_field_hidden (field_id);
create index if not exists ai_field_hidden_workspace_idx on crm.ai_field_hidden (workspace_id);

create table if not exists crm.ai_field_spend (
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  month date not null,
  decisions integer not null default 0,
  tasks integer not null default 0,
  primary key (workspace_id, month)
);

alter table crm.company_views enable row level security;
alter table crm.company_views force row level security;
alter table crm.ai_fields enable row level security;
alter table crm.ai_fields force row level security;
alter table crm.ai_field_answers enable row level security;
alter table crm.ai_field_answers force row level security;
alter table crm.ai_field_hidden enable row level security;
alter table crm.ai_field_hidden force row level security;
alter table crm.ai_field_spend enable row level security;
alter table crm.ai_field_spend force row level security;

drop policy if exists company_views_read on crm.company_views;
create policy company_views_read on crm.company_views for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists company_views_admin_insert on crm.company_views;
create policy company_views_admin_insert on crm.company_views for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists company_views_admin_update on crm.company_views;
create policy company_views_admin_update on crm.company_views for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id))
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists company_views_admin_delete on crm.company_views;
create policy company_views_admin_delete on crm.company_views for delete to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));

drop policy if exists ai_fields_read on crm.ai_fields;
create policy ai_fields_read on crm.ai_fields for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists ai_fields_admin_insert on crm.ai_fields;
create policy ai_fields_admin_insert on crm.ai_fields for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists ai_fields_admin_update on crm.ai_fields;
create policy ai_fields_admin_update on crm.ai_fields for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id))
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists ai_fields_admin_delete on crm.ai_fields;
create policy ai_fields_admin_delete on crm.ai_fields for delete to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists ai_fields_agent on crm.ai_fields;
create policy ai_fields_agent on crm.ai_fields for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));

drop policy if exists ai_field_answers_read on crm.ai_field_answers;
create policy ai_field_answers_read on crm.ai_field_answers for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));
drop policy if exists ai_field_answers_admin_insert on crm.ai_field_answers;
create policy ai_field_answers_admin_insert on crm.ai_field_answers for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists ai_field_answers_admin_update on crm.ai_field_answers;
create policy ai_field_answers_admin_update on crm.ai_field_answers for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id))
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));
drop policy if exists ai_field_answers_agent on crm.ai_field_answers;
create policy ai_field_answers_agent on crm.ai_field_answers for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));

drop policy if exists ai_field_hidden_owner on crm.ai_field_hidden;
create policy ai_field_hidden_owner on crm.ai_field_hidden for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

drop policy if exists ai_field_spend_read on crm.ai_field_spend;
create policy ai_field_spend_read on crm.ai_field_spend for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

revoke all on crm.company_views, crm.ai_fields, crm.ai_field_answers, crm.ai_field_hidden, crm.ai_field_spend from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.company_views to authenticated;
grant select, insert, update, delete on crm.ai_fields to authenticated;
grant select, insert, update on crm.ai_field_answers to authenticated;
grant select, insert, delete on crm.ai_field_hidden to authenticated;
grant select on crm.ai_field_spend to authenticated;
grant select on crm.ai_fields, crm.ai_field_answers to crm_agent;

create or replace function private.ai_field_claim(p_workspace uuid, p_field uuid, p_companies uuid[], p_claim_minutes integer)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from crm.ai_fields f where f.id = p_field and f.workspace_id = p_workspace) then
    return;
  end if;
  return query
    insert into crm.ai_field_answers as a (field_id, company_id, workspace_id, next_check_at, claimed_at)
    select p_field, c.id, p_workspace, now(), now()
    from crm.companies c
    where c.id = any(p_companies) and c.workspace_id = p_workspace and c.archived_at is null
    on conflict (field_id, company_id) do update set claimed_at = now()
      where not a.manual
        and a.next_check_at is not null and a.next_check_at <= now()
        and (a.claimed_at is null or a.claimed_at < now() - make_interval(mins => p_claim_minutes))
        and (a.run_id is null or a.run_started_at < now() - interval '3 hours')
    returning a.company_id;
end;
$$;

create or replace function private.ai_field_save(p_workspace uuid, p_field uuid, p_company uuid, p_answer jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before crm.ai_field_answers%rowtype;
  v_after crm.ai_field_answers%rowtype;
  v_options text[];
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from crm.ai_fields f where f.id = p_field and f.workspace_id = p_workspace)
     or not exists (select 1 from crm.companies c where c.id = p_company and c.workspace_id = p_workspace) then
    return null;
  end if;
  if jsonb_typeof(p_answer -> 'options') = 'array' then
    select array_agg(value) into v_options from jsonb_array_elements_text(p_answer -> 'options');
  end if;
  select * into v_before from crm.ai_field_answers a where a.field_id = p_field and a.company_id = p_company for update;
  if found and v_before.manual then
    update crm.ai_field_answers a set claimed_at = null, run_id = null, run_started_at = null
    where a.field_id = p_field and a.company_id = p_company;
    return null;
  end if;
  insert into crm.ai_field_answers as a (
    field_id, company_id, workspace_id, state, value_bool, value_number, value_text, value_options,
    likelihood, confidence, reason, sources, checked_at, next_check_at, claimed_at, run_id, run_started_at, error
  ) values (
    p_field, p_company, p_workspace,
    case when p_answer ->> 'state' = 'answered' then 'answered' else 'unknown' end,
    (p_answer ->> 'bool')::boolean,
    (p_answer ->> 'number')::numeric,
    left(p_answer ->> 'text', 300),
    v_options,
    (p_answer ->> 'likelihood')::double precision,
    p_answer ->> 'confidence',
    left(p_answer ->> 'reason', 600),
    coalesce(p_answer -> 'sources', '[]'::jsonb),
    now(),
    (p_answer ->> 'nextCheckAt')::timestamptz,
    null, null, null, null
  )
  on conflict (field_id, company_id) do update set
    state = excluded.state,
    value_bool = excluded.value_bool,
    value_number = excluded.value_number,
    value_text = excluded.value_text,
    value_options = excluded.value_options,
    likelihood = excluded.likelihood,
    confidence = excluded.confidence,
    reason = excluded.reason,
    sources = excluded.sources,
    checked_at = excluded.checked_at,
    next_check_at = excluded.next_check_at,
    claimed_at = null,
    run_id = null,
    run_started_at = null,
    error = null
  where not a.manual
  returning * into v_after;
  if v_after.field_id is null then
    return null;
  end if;
  return jsonb_build_object(
    'existed', v_before.field_id is not null,
    'before', case when v_before.field_id is null then null else jsonb_build_object(
      'state', v_before.state, 'bool', v_before.value_bool, 'number', v_before.value_number,
      'text', v_before.value_text, 'options', to_jsonb(v_before.value_options)) end,
    'after', jsonb_build_object(
      'state', v_after.state, 'bool', v_after.value_bool, 'number', v_after.value_number,
      'text', v_after.value_text, 'options', to_jsonb(v_after.value_options))
  );
end;
$$;

create or replace function private.ai_field_fail(p_workspace uuid, p_fields uuid[], p_company uuid, p_error text, p_retry_hours integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.ai_field_answers a set
    claimed_at = null,
    run_id = null,
    run_started_at = null,
    error = left(p_error, 500),
    next_check_at = now() + make_interval(hours => p_retry_hours)
  where a.workspace_id = p_workspace and a.company_id = p_company and a.field_id = any(p_fields) and not a.manual;
end;
$$;

create or replace function private.ai_field_run_start(p_workspace uuid, p_fields uuid[], p_company uuid, p_run_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.ai_field_answers a set run_id = left(p_run_id, 200), run_started_at = now(), claimed_at = now()
  where a.workspace_id = p_workspace and a.company_id = p_company and a.field_id = any(p_fields) and not a.manual;
end;
$$;

create or replace function private.ai_field_note(p_workspace uuid, p_fields uuid[], p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.ai_fields f set
    last_run_at = now(),
    last_error = left(p_error, 500),
    last_error_at = case when p_error is null then f.last_error_at else now() end
  where f.workspace_id = p_workspace and f.id = any(p_fields);
end;
$$;

create or replace function private.ai_field_spend(p_workspace uuid, p_decisions integer, p_tasks integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into crm.ai_field_spend as s (workspace_id, month, decisions, tasks)
  values (p_workspace, date_trunc('month', now())::date, greatest(p_decisions, 0), greatest(p_tasks, 0))
  on conflict (workspace_id, month) do update set
    decisions = s.decisions + excluded.decisions,
    tasks = s.tasks + excluded.tasks;
end;
$$;

revoke all on function private.ai_field_claim(uuid, uuid, uuid[], integer) from public;
revoke all on function private.ai_field_save(uuid, uuid, uuid, jsonb) from public;
revoke all on function private.ai_field_fail(uuid, uuid[], uuid, text, integer) from public;
revoke all on function private.ai_field_run_start(uuid, uuid[], uuid, text) from public;
revoke all on function private.ai_field_note(uuid, uuid[], text) from public;
revoke all on function private.ai_field_spend(uuid, integer, integer) from public;
grant execute on function private.ai_field_claim(uuid, uuid, uuid[], integer) to crm_app;
grant execute on function private.ai_field_save(uuid, uuid, uuid, jsonb) to crm_app;
grant execute on function private.ai_field_fail(uuid, uuid[], uuid, text, integer) to crm_app;
grant execute on function private.ai_field_run_start(uuid, uuid[], uuid, text) to crm_app;
grant execute on function private.ai_field_note(uuid, uuid[], text) to crm_app;
grant execute on function private.ai_field_spend(uuid, integer, integer) to crm_app;
