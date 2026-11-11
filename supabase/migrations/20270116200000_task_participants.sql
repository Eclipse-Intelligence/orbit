set lock_timeout = '5s';

create table if not exists crm.task_participants (
  task_id uuid not null references crm.tasks (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  added_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

create index if not exists task_participants_user_idx on crm.task_participants (user_id);

alter table crm.task_participants enable row level security;
alter table crm.task_participants force row level security;

create or replace function private.my_task_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.task_id from crm.task_participants p where p.user_id = (select private.session_user_id());
$$;

revoke all on function private.my_task_ids() from public;
grant execute on function private.my_task_ids() to authenticated;

drop policy if exists task_participants_select on crm.task_participants;
create policy task_participants_select on crm.task_participants
  for select to authenticated
  using (task_id in (select t.id from crm.tasks t));

drop policy if exists task_participants_insert on crm.task_participants;
create policy task_participants_insert on crm.task_participants
  for insert to authenticated
  with check (
    added_by = (select private.session_user_id())
    and exists (
      select 1
      from crm.tasks t
      join crm.workspace_members m on m.workspace_id = t.workspace_id and m.user_id = task_participants.user_id
      where t.id = task_participants.task_id
    )
  );

drop policy if exists task_participants_delete on crm.task_participants;
create policy task_participants_delete on crm.task_participants
  for delete to authenticated
  using (
    task_id in (select t.id from crm.tasks t)
    and (
      user_id = (select private.session_user_id())
      or exists (
        select 1 from crm.tasks t
        where t.id = task_participants.task_id
          and (
            t.owner_id = (select private.session_user_id())
            or t.created_by_user_id = (select private.session_user_id())
            or private.is_workspace_admin(t.workspace_id)
          )
      )
    )
  );

revoke all on crm.task_participants from anon, authenticated, crm_agent;
grant select, insert, delete on crm.task_participants to authenticated;

drop policy if exists tasks_select_member on crm.tasks;
create policy tasks_select_member on crm.tasks
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and (
      owner_id = (select private.session_user_id())
      or created_by_user_id = (select private.session_user_id())
      or private.is_workspace_admin(workspace_id)
      or id in (select private.my_task_ids())
    )
  );

reset lock_timeout;
