create table if not exists crm.email_signatures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  sender_email text not null,
  body text not null,
  updated_at timestamptz not null default now(),
  constraint email_signatures_body check (char_length(body) between 1 and 2000),
  constraint email_signatures_sender check (char_length(sender_email) between 3 and 320),
  constraint email_signatures_unique unique (workspace_id, user_id, sender_email)
);

alter table crm.email_signatures enable row level security;
alter table crm.email_signatures force row level security;

drop policy if exists email_signatures_owner on crm.email_signatures;
create policy email_signatures_owner on crm.email_signatures
  for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

revoke all on crm.email_signatures from anon, authenticated, crm_agent;
grant select, insert, delete on crm.email_signatures to authenticated;
grant update (body, updated_at) on crm.email_signatures to authenticated;
