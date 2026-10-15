create or replace function private.session_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid()
$$;

revoke all on function private.session_user_id() from public;
grant execute on function private.session_user_id() to authenticated;

create table if not exists crm.email_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  created_by uuid references crm.profiles (id) on delete set null,
  name text not null,
  subject text not null default '',
  body text not null default '',
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint email_templates_name_length check (char_length(name) between 1 and 120),
  constraint email_templates_subject_length check (char_length(subject) <= 300),
  constraint email_templates_body_length check (char_length(body) <= 20000),
  constraint email_templates_tags_count check (cardinality(tags) <= 20)
);

create unique index if not exists email_templates_name_key
  on crm.email_templates (workspace_id, lower(name))
  where archived_at is null;
create index if not exists email_templates_workspace_updated_idx
  on crm.email_templates (workspace_id, updated_at desc)
  where archived_at is null;
create index if not exists email_templates_tags_idx on crm.email_templates using gin (tags);
create index if not exists email_templates_created_by_idx on crm.email_templates (created_by);

drop trigger if exists email_templates_set_updated_at on crm.email_templates;
create trigger email_templates_set_updated_at
  before update on crm.email_templates
  for each row execute function private.set_updated_at();

alter table crm.email_templates enable row level security;
alter table crm.email_templates force row level security;

drop policy if exists email_templates_select_member on crm.email_templates;
create policy email_templates_select_member on crm.email_templates
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

drop policy if exists email_templates_insert_member on crm.email_templates;
create policy email_templates_insert_member on crm.email_templates
  for insert to authenticated
  with check (
    workspace_id in (select private.user_workspace_ids())
    and (created_by is null or created_by = (select private.session_user_id()))
  );

drop policy if exists email_templates_update_member on crm.email_templates;
create policy email_templates_update_member on crm.email_templates
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists email_templates_delete_member on crm.email_templates;
create policy email_templates_delete_member on crm.email_templates
  for delete to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

revoke all on crm.email_templates from anon, authenticated, crm_agent;
grant select, insert, delete on crm.email_templates to authenticated;
grant update (name, subject, body, tags, archived_at) on crm.email_templates to authenticated;
