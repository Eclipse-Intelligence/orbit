set lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'Run this as a role that bypasses row-level security: the trigger functions write to crm.activity_contacts.';
  end if;
end;
$$;

create table if not exists crm.activity_contacts (
  activity_id uuid not null references crm.activities (id) on delete cascade,
  contact_id uuid not null references crm.contacts (id) on delete cascade,
  implicit boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (activity_id, contact_id)
);

create index if not exists activity_contacts_contact_idx on crm.activity_contacts (contact_id, activity_id);

alter table crm.activity_contacts enable row level security;
alter table crm.activity_contacts force row level security;

drop policy if exists activity_contacts_select_member on crm.activity_contacts;
create policy activity_contacts_select_member on crm.activity_contacts
  for select to authenticated
  using (activity_id in (select a.id from crm.activities a));

drop policy if exists activity_contacts_select_agent on crm.activity_contacts;
create policy activity_contacts_select_agent on crm.activity_contacts
  for select to crm_agent
  using (activity_id in (select a.id from crm.activities a));

drop policy if exists activity_contacts_insert_member on crm.activity_contacts;
create policy activity_contacts_insert_member on crm.activity_contacts
  for insert to authenticated
  with check (
    exists (
      select 1
      from crm.activities a
      join crm.contacts c on c.workspace_id = a.workspace_id
      where a.id = activity_contacts.activity_id and c.id = activity_contacts.contact_id
    )
  );

drop policy if exists activity_contacts_insert_agent on crm.activity_contacts;
create policy activity_contacts_insert_agent on crm.activity_contacts
  for insert to crm_agent
  with check (
    exists (
      select 1
      from crm.activities a
      join crm.contacts c on c.workspace_id = a.workspace_id
      where a.id = activity_contacts.activity_id and c.id = activity_contacts.contact_id
    )
  );

drop policy if exists activity_contacts_update_member on crm.activity_contacts;
create policy activity_contacts_update_member on crm.activity_contacts
  for update to authenticated
  using (activity_id in (select a.id from crm.activities a))
  with check (activity_id in (select a.id from crm.activities a));

drop policy if exists activity_contacts_update_agent on crm.activity_contacts;
create policy activity_contacts_update_agent on crm.activity_contacts
  for update to crm_agent
  using (activity_id in (select a.id from crm.activities a))
  with check (activity_id in (select a.id from crm.activities a));

drop policy if exists activity_contacts_delete_member on crm.activity_contacts;
create policy activity_contacts_delete_member on crm.activity_contacts
  for delete to authenticated
  using (activity_id in (select a.id from crm.activities a));

drop policy if exists activity_contacts_delete_agent on crm.activity_contacts;
create policy activity_contacts_delete_agent on crm.activity_contacts
  for delete to crm_agent
  using (activity_id in (select a.id from crm.activities a));

revoke all on crm.activity_contacts from anon, authenticated, crm_agent;
grant select, insert, delete on crm.activity_contacts to authenticated, crm_agent;
grant update (implicit) on crm.activity_contacts to authenticated, crm_agent;

create or replace function private.assert_activity_contact_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from crm.activities a
    join crm.contacts c on c.workspace_id = a.workspace_id
    where a.id = new.activity_id and c.id = new.contact_id
  ) then
    raise exception 'contact belongs to another workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.assert_activity_contact_workspace() from public;

drop trigger if exists activity_contacts_same_workspace on crm.activity_contacts;
create trigger activity_contacts_same_workspace
  before insert on crm.activity_contacts
  for each row execute function private.assert_activity_contact_workspace();

create or replace function private.sync_activity_main_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.contact_id is not distinct from new.contact_id then
      return null;
    end if;
    if old.contact_id is not null then
      delete from crm.activity_contacts l
      where l.activity_id = new.id and l.contact_id = old.contact_id and l.implicit;
    end if;
  end if;
  if new.contact_id is not null then
    insert into crm.activity_contacts (activity_id, contact_id, implicit)
    values (new.id, new.contact_id, true)
    on conflict (activity_id, contact_id) do nothing;
  end if;
  return null;
end;
$$;

revoke all on function private.sync_activity_main_contact() from public;

drop trigger if exists activities_main_contact on crm.activities;
create trigger activities_main_contact
  after insert or update of contact_id on crm.activities
  for each row execute function private.sync_activity_main_contact();

create or replace function private.drop_crossing_activity_contacts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'contacts' then
    delete from crm.activity_contacts l
    using crm.activities a
    where l.contact_id = new.id and a.id = l.activity_id and a.workspace_id <> new.workspace_id;
  else
    delete from crm.activity_contacts l
    using crm.contacts c
    where l.activity_id = new.id and c.id = l.contact_id and c.workspace_id <> new.workspace_id;
  end if;
  return null;
end;
$$;

revoke all on function private.drop_crossing_activity_contacts() from public;

drop trigger if exists contacts_drop_crossing_activity_contacts on crm.contacts;
create constraint trigger contacts_drop_crossing_activity_contacts
  after update of workspace_id on crm.contacts
  deferrable initially deferred
  for each row
  when (old.workspace_id is distinct from new.workspace_id)
  execute function private.drop_crossing_activity_contacts();

drop trigger if exists activities_drop_crossing_activity_contacts on crm.activities;
create constraint trigger activities_drop_crossing_activity_contacts
  after update of workspace_id on crm.activities
  deferrable initially deferred
  for each row
  when (old.workspace_id is distinct from new.workspace_id)
  execute function private.drop_crossing_activity_contacts();

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
  suppressions_moved integer;
  prospects_stopped integer;
  merged_emails text[];
  merged_linkedins text[];
  stop_reason_for_duplicate text;
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

  merged_emails := array_remove(array[keep_row.normalized_email, merge_row.normalized_email], null);
  merged_linkedins := array_remove(array[keep_row.normalized_linkedin, merge_row.normalized_linkedin], null);
  if exists (
    select 1 from crm.suppressions s
    where s.workspace_id = p_workspace and s.reason <> 'bounced'
      and (s.contact_id in (p_keep, p_merge) or (s.kind = 'email' and s.value = any(merged_emails)) or (s.kind = 'linkedin' and s.value = any(merged_linkedins)))
  ) then
    stop_reason_for_duplicate := 'suppressed';
  elsif exists (
    select 1 from crm.campaign_prospects p
    where p.workspace_id = p_workspace and p.replied_at is not null
      and (p.contact_id in (p_keep, p_merge) or p.email = any(merged_emails) or p.linkedin = any(merged_linkedins))
  ) then
    stop_reason_for_duplicate := 'replied';
  end if;

  for prospect in
    select dup.id as merge_id, kept.id as keep_id, dup.replied_at, dup.last_event_at, dup.external_lead_id, dup.email, dup.linkedin,
      dup.stop_requested_at, dup.stopped_at, dup.stop_reason,
      dup.state in ('pushing', 'pushed') and private.campaign_prospect_active(dup.state, dup.stopped_at, dup.lead_status, k.status) as live
    from crm.campaign_prospects dup
    join crm.campaigns k on k.id = dup.campaign_id
    join crm.campaign_prospects kept
      on kept.campaign_id = dup.campaign_id and kept.contact_id = p_keep and kept.workspace_id = p_workspace
    where dup.workspace_id = p_workspace and dup.contact_id = p_merge
    order by dup.id
    for update of dup, kept
  loop
    if stop_reason_for_duplicate is not null and prospect.live and prospect.replied_at is null then
      update crm.campaign_messages m set prospect_id = prospect.keep_id where m.prospect_id = prospect.merge_id;
      update crm.campaign_prospects d
      set contact_id = null,
          stop_requested_at = coalesce(d.stop_requested_at, now()),
          stop_reason = coalesce(d.stop_reason, stop_reason_for_duplicate)
      where d.id = prospect.merge_id;
      update crm.campaign_prospects k
      set replied_at = case
            when k.replied_at is null then prospect.replied_at
            when prospect.replied_at is null then k.replied_at
            else least(k.replied_at, prospect.replied_at)
          end,
          email = coalesce(k.email, prospect.email),
          linkedin = coalesce(k.linkedin, prospect.linkedin)
      where k.id = prospect.keep_id;
      prospects_combined := prospects_combined + 1;
      continue;
    end if;
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

  update crm.suppressions s set contact_id = p_keep
  where s.workspace_id = p_workspace
    and (
      s.contact_id = p_merge
      or (
        s.contact_id is null and s.reason <> 'bounced'
        and ((s.kind = 'email' and s.value = merge_row.normalized_email) or (s.kind = 'linkedin' and s.value = merge_row.normalized_linkedin))
      )
    );
  get diagnostics suppressions_moved = row_count;

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

  prospects_stopped := private.campaign_stop_merged_person(
    p_workspace, p_keep,
    array_remove(array[keep_row.normalized_email, merge_row.normalized_email], null),
    array_remove(array[keep_row.normalized_linkedin, merge_row.normalized_linkedin], null)
  );

  update crm.meta_leads l set contact_id = p_keep where l.contact_id = p_merge;

  insert into crm.activity_contacts (activity_id, contact_id, implicit)
  select l.activity_id, p_keep, l.implicit
  from crm.activity_contacts l
  where l.contact_id = p_merge
  on conflict (activity_id, contact_id) do update
    set implicit = crm.activity_contacts.implicit and excluded.implicit;
  delete from crm.activity_contacts l where l.contact_id = p_merge;

  perform set_config('orbit.merging', 'off', true);

  return moved || jsonb_build_object(
    'calendar_events', calendar_replaced,
    'calendar_events_shared', calendar_shared,
    'workflow_record_marks', marks,
    'follow_up_suggestions', follow_ups,
    'mail_thread_routes', routes,
    'page_links', links_dropped + links_moved,
    'campaign_prospects_combined', prospects_combined,
    'suppressions', suppressions_moved,
    'campaign_prospects_stopped', prospects_stopped
  );
end;
$$;

reset lock_timeout;

insert into crm.activity_contacts (activity_id, contact_id, implicit)
select distinct a.id, c.id, false
from crm.conversation_imports i
join crm.activities a on a.id = i.activity_id
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(i.participants) = 'array' then i.participants else '[]'::jsonb end
) p
join crm.contacts c
  on c.workspace_id = a.workspace_id
 and c.archived_at is null
 and c.normalized_email = lower(btrim(p ->> 'email'))
where i.status = 'filed'
  and i.activity_id is not null
  and jsonb_typeof(p) = 'object'
  and nullif(btrim(p ->> 'email'), '') is not null
  and not exists (
    select 1
    from crm.workspace_members m
    join crm.profiles pr on pr.id = m.user_id
    where m.workspace_id = a.workspace_id
      and (
        lower(pr.email) = lower(btrim(p ->> 'email'))
        or lower(btrim(p ->> 'email')) = any (select lower(o) from unnest(pr.other_emails) o)
      )
  )
on conflict (activity_id, contact_id) do nothing;

insert into crm.activity_contacts (activity_id, contact_id, implicit)
select a.id, a.contact_id, true
from crm.activities a
where a.contact_id is not null
on conflict (activity_id, contact_id) do nothing;
