alter table crm.tasks add column if not exists clickup_task_id text;
alter table crm.tasks add column if not exists clickup_list_id text;
alter table crm.tasks add column if not exists clickup_url text;
alter table crm.tasks add column if not exists clickup_synced_at timestamptz;
alter table crm.tasks add column if not exists clickup_error text;
alter table crm.tasks add column if not exists clickup_sync jsonb not null default '{}'::jsonb;

alter table crm.tasks drop constraint if exists tasks_clickup_task_id_length;
alter table crm.tasks
  add constraint tasks_clickup_task_id_length
  check (clickup_task_id is null or char_length(clickup_task_id) between 1 and 100);
alter table crm.tasks drop constraint if exists tasks_clickup_list_id_length;
alter table crm.tasks
  add constraint tasks_clickup_list_id_length
  check (clickup_list_id is null or char_length(clickup_list_id) between 1 and 100);
alter table crm.tasks drop constraint if exists tasks_clickup_url_length;
alter table crm.tasks
  add constraint tasks_clickup_url_length
  check (clickup_url is null or char_length(clickup_url) <= 500);
alter table crm.tasks drop constraint if exists tasks_clickup_error_length;
alter table crm.tasks
  add constraint tasks_clickup_error_length
  check (clickup_error is null or char_length(clickup_error) <= 500);
alter table crm.tasks drop constraint if exists tasks_clickup_sync_object;
alter table crm.tasks
  add constraint tasks_clickup_sync_object
  check (jsonb_typeof(clickup_sync) = 'object');

create unique index if not exists tasks_clickup_task_key
  on crm.tasks (workspace_id, clickup_task_id)
  where clickup_task_id is not null;
create index if not exists tasks_clickup_pending_idx
  on crm.tasks (workspace_id)
  where clickup_list_id is not null and archived_at is null;

grant update (
  clickup_task_id, clickup_list_id, clickup_url, clickup_synced_at, clickup_error, clickup_sync
) on crm.tasks to authenticated;

alter table crm.integration_state add column if not exists team_id text;
alter table crm.integration_state add column if not exists external_user_id text;
alter table crm.integration_state add column if not exists default_list_id text;
alter table crm.integration_state add column if not exists watched_list_ids text[] not null default '{}';
alter table crm.integration_state add column if not exists last_used_list_id text;
alter table crm.integration_state add column if not exists list_choices jsonb not null default '[]'::jsonb;
alter table crm.integration_state add column if not exists webhook_scope text;

alter table crm.integration_state drop constraint if exists integration_state_source;
alter table crm.integration_state
  add constraint integration_state_source
  check (source in ('granola', 'teams_transcripts', 'clickup'));
alter table crm.integration_state drop constraint if exists integration_state_clickup_ids;
alter table crm.integration_state
  add constraint integration_state_clickup_ids
  check (
    (team_id is null or char_length(team_id) between 1 and 100)
    and (external_user_id is null or char_length(external_user_id) between 1 and 100)
    and (default_list_id is null or char_length(default_list_id) between 1 and 100)
    and (last_used_list_id is null or char_length(last_used_list_id) between 1 and 100)
    and (webhook_scope is null or char_length(webhook_scope) <= 200)
    and coalesce(array_length(watched_list_ids, 1), 0) <= 100
  );
alter table crm.integration_state drop constraint if exists integration_state_list_choices_array;
alter table crm.integration_state
  add constraint integration_state_list_choices_array
  check (jsonb_typeof(list_choices) = 'array' and pg_column_size(list_choices) <= 200000);

grant update (
  team_id, external_user_id, default_list_id, watched_list_ids, last_used_list_id,
  list_choices, webhook_scope
) on crm.integration_state to authenticated;

alter table crm.webhook_receipts drop constraint if exists webhook_receipts_source;
alter table crm.webhook_receipts
  add constraint webhook_receipts_source check (source in ('granola', 'clickup'));

create or replace function private.clickup_webhook_targets()
returns table (
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text,
  webhook_id text,
  webhook_secret text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select s.workspace_id, w.name, m.user_id, m.role, p.email, p.full_name, s.webhook_id, s.webhook_secret
  from crm.integration_state s
  join crm.workspaces w on w.id = s.workspace_id
  join crm.workspace_members m on m.workspace_id = s.workspace_id and m.user_id = s.user_id
  join crm.profiles p on p.id = m.user_id
  where s.source = 'clickup'
    and s.connection_id is null
    and s.webhook_secret is not null
  limit 20;
end;
$$;

revoke all on function private.clickup_webhook_targets() from public;
grant execute on function private.clickup_webhook_targets() to crm_app;
