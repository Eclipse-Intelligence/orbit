create table if not exists crm.mail_attachment_texts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  message_id uuid not null references crm.mail_messages (id) on delete cascade,
  attachment_id text not null,
  name text not null,
  content_type text,
  size integer not null default 0,
  state text not null,
  text text,
  created_at timestamptz not null default now(),
  constraint mail_attachment_texts_state check (state in ('read', 'unreadable', 'too_large', 'failed')),
  constraint mail_attachment_texts_text check (text is null or char_length(text) <= 30000),
  constraint mail_attachment_texts_name check (char_length(name) between 1 and 300),
  constraint mail_attachment_texts_attachment check (char_length(attachment_id) between 1 and 1000),
  constraint mail_attachment_texts_unique unique (message_id, attachment_id)
);

create index if not exists mail_attachment_texts_user_idx on crm.mail_attachment_texts (user_id, created_at desc);
create index if not exists mail_attachment_texts_search_idx on crm.mail_attachment_texts using gin (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(text, '')));

alter table crm.mail_attachment_texts enable row level security;
alter table crm.mail_attachment_texts force row level security;

drop policy if exists mail_attachment_texts_owner on crm.mail_attachment_texts;
create policy mail_attachment_texts_owner on crm.mail_attachment_texts
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_attachment_texts from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.mail_attachment_texts to authenticated;
