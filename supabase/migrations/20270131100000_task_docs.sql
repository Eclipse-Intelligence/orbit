set lock_timeout = '5s';

create table if not exists crm.task_docs (
  task_id uuid not null references crm.tasks (id) on delete cascade,
  page_id uuid not null references crm.pages (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  created_by uuid references crm.profiles (id) on delete set null,
  created_by_agent_id uuid references crm.agents (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (task_id, page_id)
);

create index if not exists task_docs_page_idx on crm.task_docs (page_id);
create index if not exists task_docs_workspace_idx on crm.task_docs (workspace_id);
create index if not exists task_docs_created_by_idx on crm.task_docs (created_by);
create index if not exists task_docs_created_by_agent_idx on crm.task_docs (created_by_agent_id);

alter table crm.task_docs enable row level security;
alter table crm.task_docs force row level security;

create or replace function private.task_docs_same_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from crm.tasks t where t.id = new.task_id and t.workspace_id = new.workspace_id) then
    raise exception 'task belongs to another workspace' using errcode = '23514';
  end if;
  if not exists (select 1 from crm.pages p where p.id = new.page_id and p.workspace_id = new.workspace_id and p.kind = 'note') then
    raise exception 'doc belongs to another workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.task_docs_same_workspace() from public;

drop trigger if exists task_docs_same_workspace on crm.task_docs;
create trigger task_docs_same_workspace
  before insert or update on crm.task_docs
  for each row execute function private.task_docs_same_workspace();

create or replace function private.task_docs_task_moved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from crm.task_docs d where d.task_id = new.id and d.workspace_id is distinct from new.workspace_id;
  return new;
end;
$$;

revoke all on function private.task_docs_task_moved() from public;

drop trigger if exists tasks_docs_move on crm.tasks;
create trigger tasks_docs_move
  after update of workspace_id on crm.tasks
  for each row
  when (old.workspace_id is distinct from new.workspace_id)
  execute function private.task_docs_task_moved();

create or replace function private.task_docs_page_moved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from crm.task_docs d where d.page_id = new.id and d.workspace_id is distinct from new.workspace_id;
  return new;
end;
$$;

revoke all on function private.task_docs_page_moved() from public;

drop trigger if exists pages_task_docs_move on crm.pages;
create trigger pages_task_docs_move
  after update of workspace_id on crm.pages
  for each row
  when (old.workspace_id is distinct from new.workspace_id)
  execute function private.task_docs_page_moved();

drop policy if exists task_docs_select on crm.task_docs;
create policy task_docs_select on crm.task_docs
  for select to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and task_id in (select t.id from crm.tasks t)
  );

drop policy if exists task_docs_insert on crm.task_docs;
create policy task_docs_insert on crm.task_docs
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and created_by = (select private.session_user_id())
    and created_by_agent_id is null
    and exists (
      select 1 from crm.tasks t
      where t.id = task_docs.task_id
        and t.workspace_id = task_docs.workspace_id
        and (
          t.owner_id = (select private.session_user_id())
          or t.created_by_user_id = (select private.session_user_id())
          or private.is_workspace_admin(t.workspace_id)
        )
    )
    and exists (
      select 1 from crm.pages p
      where p.id = task_docs.page_id and p.workspace_id = task_docs.workspace_id and p.kind = 'note' and p.archived_at is null
    )
  );

drop policy if exists task_docs_delete on crm.task_docs;
create policy task_docs_delete on crm.task_docs
  for delete to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and exists (
      select 1 from crm.tasks t
      where t.id = task_docs.task_id
        and (
          t.owner_id = (select private.session_user_id())
          or t.created_by_user_id = (select private.session_user_id())
          or private.is_workspace_admin(t.workspace_id)
        )
    )
  );

drop policy if exists task_docs_agent_select on crm.task_docs;
create policy task_docs_agent_select on crm.task_docs
  for select to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and task_id in (select t.id from crm.tasks t)
  );

drop policy if exists task_docs_agent_insert on crm.task_docs;
create policy task_docs_agent_insert on crm.task_docs
  for insert to crm_agent
  with check (
    workspace_id = (select private.request_workspace_id())
    and created_by is null
    and exists (select 1 from crm.tasks t where t.id = task_docs.task_id and t.workspace_id = task_docs.workspace_id)
    and exists (
      select 1 from crm.pages p
      where p.id = task_docs.page_id and p.workspace_id = task_docs.workspace_id and p.kind = 'note' and p.archived_at is null
    )
  );

drop policy if exists task_docs_agent_delete on crm.task_docs;
create policy task_docs_agent_delete on crm.task_docs
  for delete to crm_agent
  using (
    workspace_id = (select private.request_workspace_id())
    and task_id in (select t.id from crm.tasks t)
  );

revoke all on crm.task_docs from public, anon, authenticated, crm_agent;
grant select, insert, delete on crm.task_docs to authenticated, crm_agent;

reset lock_timeout;
