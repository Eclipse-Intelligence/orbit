alter table crm.workspace_members add column if not exists job_title text;

alter table crm.workspace_members drop constraint if exists workspace_members_job_title_length;
alter table crm.workspace_members
  add constraint workspace_members_job_title_length check (job_title is null or char_length(job_title) <= 120);

drop policy if exists members_update_own_job_title on crm.workspace_members;
create policy members_update_own_job_title on crm.workspace_members
  for update to authenticated
  using (user_id = (select private.session_user_id()))
  with check (user_id = (select private.session_user_id()));

grant update (job_title) on crm.workspace_members to authenticated;

do $$
declare
  v_applied boolean := false;
begin
  if to_regclass('private.schema_migrations') is not null then
    execute 'select exists (select 1 from private.schema_migrations where filename = $1)'
      into v_applied using '20270107100000_about_you_per_workspace.sql';
  end if;
  if v_applied then
    return;
  end if;

  update crm.workspace_members m set job_title = btrim(o.job_title)
  from crm.personal_context_workspaces o
  where o.user_id = m.user_id
    and o.workspace_id = m.workspace_id
    and nullif(btrim(m.job_title), '') is null
    and nullif(btrim(o.job_title), '') is not null;

  update crm.workspace_members m set job_title = btrim(p.job_title)
  from crm.profiles p
  where p.id = m.user_id
    and m.workspace_id = private.home_workspace_id(m.user_id)
    and nullif(btrim(m.job_title), '') is null
    and nullif(btrim(p.job_title), '') is not null;

  insert into crm.personal_context_workspaces (user_id, workspace_id, about)
  select c.user_id, private.home_workspace_id(c.user_id), c.about
  from crm.personal_context c
  where nullif(btrim(c.about), '') is not null
    and private.home_workspace_id(c.user_id) is not null
  on conflict (user_id, workspace_id) do update set about = excluded.about
  where nullif(btrim(crm.personal_context_workspaces.about), '') is null;
end
$$;
