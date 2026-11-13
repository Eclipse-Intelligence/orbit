set lock_timeout = '5s';

create table if not exists crm.task_preparations (
  task_id uuid not null references crm.tasks (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  kind text not null,
  state text not null default 'ready',
  content jsonb,
  basis jsonb,
  fingerprint text,
  automatic boolean not null default false,
  failures smallint not null default 0,
  error text,
  prepared_at timestamptz,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

alter table crm.task_preparations drop constraint if exists task_preparations_kind;
alter table crm.task_preparations
  add constraint task_preparations_kind check (kind in ('brief', 'draft'));

alter table crm.task_preparations drop constraint if exists task_preparations_state;
alter table crm.task_preparations
  add constraint task_preparations_state check (
    (state = 'ready' and content is not null and prepared_at is not null)
    or state = 'failed'
  );

alter table crm.task_preparations drop constraint if exists task_preparations_size;
alter table crm.task_preparations
  add constraint task_preparations_size check (
    (content is null or (jsonb_typeof(content) = 'object' and pg_column_size(content) <= 131072))
    and (basis is null or (jsonb_typeof(basis) = 'object' and pg_column_size(basis) <= 65536))
    and (error is null or length(error) <= 500)
    and (fingerprint is null or length(fingerprint) <= 128)
  );

create index if not exists task_preparations_user_idx on crm.task_preparations (user_id, checked_at);
create index if not exists task_preparations_workspace_idx on crm.task_preparations (workspace_id);

drop trigger if exists task_preparations_set_updated_at on crm.task_preparations;
create trigger task_preparations_set_updated_at
  before update on crm.task_preparations
  for each row execute function private.set_updated_at();

alter table crm.task_preparations enable row level security;
alter table crm.task_preparations force row level security;

drop policy if exists task_preparations_own on crm.task_preparations;
create policy task_preparations_own on crm.task_preparations for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and task_id in (select t.id from crm.tasks t)
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and exists (
      select 1 from crm.tasks t
      where t.id = task_preparations.task_id and t.workspace_id = task_preparations.workspace_id
    )
  );

revoke all on crm.task_preparations from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.task_preparations to authenticated;

create table if not exists crm.task_preferences (
  user_id uuid primary key references crm.profiles (id) on delete cascade,
  prepare_each_morning boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists task_preferences_set_updated_at on crm.task_preferences;
create trigger task_preferences_set_updated_at
  before update on crm.task_preferences
  for each row execute function private.set_updated_at();

alter table crm.task_preferences enable row level security;
alter table crm.task_preferences force row level security;

drop policy if exists task_preferences_self on crm.task_preferences;
create policy task_preferences_self on crm.task_preferences for all to authenticated
  using (user_id = (select private.session_user_id()))
  with check (user_id = (select private.session_user_id()));

revoke all on crm.task_preferences from anon, authenticated, crm_agent;
grant select, insert, update on crm.task_preferences to authenticated;

reset lock_timeout;
