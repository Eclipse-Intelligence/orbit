create table if not exists crm.chat_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  conversation_id uuid references crm.assistant_conversations (id) on delete set null,
  message_id uuid references crm.assistant_messages (id) on delete set null,
  name text not null,
  content_type text not null default 'application/octet-stream',
  size integer not null,
  content text,
  created_at timestamptz not null default now(),
  constraint chat_files_name check (char_length(name) between 1 and 200),
  constraint chat_files_content_type check (char_length(content_type) between 1 and 200),
  constraint chat_files_size check (size between 1 and 26214400),
  constraint chat_files_content_length check (content is null or char_length(content) <= 2000000)
);

create index if not exists chat_files_user_idx on crm.chat_files (user_id);
create index if not exists chat_files_conversation_idx on crm.chat_files (conversation_id);
create index if not exists chat_files_message_idx on crm.chat_files (message_id);
create index if not exists chat_files_unsent_idx on crm.chat_files (created_at) where message_id is null;

alter table crm.chat_files enable row level security;
alter table crm.chat_files force row level security;

drop policy if exists chat_files_owner on crm.chat_files;
create policy chat_files_owner on crm.chat_files
  for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and (
      conversation_id is null
      or conversation_id in (
        select c.id from crm.assistant_conversations c
        where c.user_id = (select private.session_user_id())
      )
    )
  );

revoke all on crm.chat_files from anon, authenticated, crm_agent;
grant select, insert, delete on crm.chat_files to authenticated;
grant update (conversation_id, message_id, content) on crm.chat_files to authenticated;

alter table crm.assistant_messages add column if not exists files jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assistant_messages_files_array') then
    alter table crm.assistant_messages
      add constraint assistant_messages_files_array check (files is null or jsonb_typeof(files) = 'array');
  end if;
end;
$$;

create or replace function private.claim_stale_chat_files(p_limit integer)
returns table (id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  delete from crm.chat_files f
  where f.id in (
    select s.id from crm.chat_files s
    where s.message_id is null
      and s.created_at < now() - interval '1 day'
    order by s.created_at
    limit greatest(1, least(p_limit, 200))
  )
  returning f.id;
end;
$$;

revoke all on function private.claim_stale_chat_files(integer) from public;
grant execute on function private.claim_stale_chat_files(integer) to crm_app;
