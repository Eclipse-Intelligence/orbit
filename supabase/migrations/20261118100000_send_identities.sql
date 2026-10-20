create table if not exists crm.send_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  email text not null,
  display_name text,
  smtp_host text not null,
  smtp_port integer not null,
  username text not null,
  password_cipher text not null,
  imap_host text,
  imap_port integer,
  last_error text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint send_identities_email check (char_length(email) between 3 and 320),
  constraint send_identities_name check (display_name is null or char_length(display_name) <= 200),
  constraint send_identities_hosts check (char_length(smtp_host) between 3 and 255 and (imap_host is null or char_length(imap_host) between 3 and 255)),
  constraint send_identities_ports check (smtp_port between 1 and 65535 and (imap_port is null or imap_port between 1 and 65535)),
  constraint send_identities_username check (char_length(username) between 1 and 320),
  constraint send_identities_error check (last_error is null or char_length(last_error) <= 500),
  constraint send_identities_unique unique (user_id, email)
);

alter table crm.send_identities enable row level security;
alter table crm.send_identities force row level security;

drop policy if exists send_identities_owner on crm.send_identities;
create policy send_identities_owner on crm.send_identities
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.send_identities from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.send_identities to authenticated;

alter table crm.mail_drafts add column if not exists identity_id uuid references crm.send_identities (id) on delete set null;
