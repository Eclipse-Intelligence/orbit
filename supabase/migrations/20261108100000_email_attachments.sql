create table if not exists crm.email_attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  name text not null,
  content_type text not null default 'application/octet-stream',
  size integer not null,
  created_at timestamptz not null default now(),
  constraint email_attachments_name check (char_length(name) between 1 and 200),
  constraint email_attachments_content_type check (char_length(content_type) between 1 and 200),
  constraint email_attachments_size check (size between 1 and 26214400)
);

create index if not exists email_attachments_created_idx on crm.email_attachments (created_at);

alter table crm.email_attachments enable row level security;
alter table crm.email_attachments force row level security;

drop policy if exists email_attachments_owner on crm.email_attachments;
create policy email_attachments_owner on crm.email_attachments
  for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

revoke all on crm.email_attachments from anon, authenticated, crm_agent;
grant select, insert, delete on crm.email_attachments to authenticated;

create or replace function private.claim_stale_email_attachments(p_limit integer)
returns table (id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  delete from crm.email_attachments a
  where a.id in (
    select s.id from crm.email_attachments s
    where s.created_at < now() - interval '1 day'
    order by s.created_at
    limit greatest(1, least(p_limit, 200))
  )
  returning a.id;
end;
$$;

revoke all on function private.claim_stale_email_attachments(integer) from public;
grant execute on function private.claim_stale_email_attachments(integer) to crm_app;
