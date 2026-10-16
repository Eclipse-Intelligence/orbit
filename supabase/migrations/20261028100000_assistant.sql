create table if not exists crm.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  title text not null default 'New chat',
  model text not null,
  reasoning text not null default 'medium',
  web_search boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint assistant_conversations_title_length check (char_length(title) between 1 and 200),
  constraint assistant_conversations_model_length check (char_length(model) between 1 and 120),
  constraint assistant_conversations_reasoning check (reasoning in ('low', 'medium', 'high', 'xhigh', 'max'))
);

create index if not exists assistant_conversations_user_idx
  on crm.assistant_conversations (workspace_id, user_id, updated_at desc)
  where archived_at is null;

drop trigger if exists assistant_conversations_set_updated_at on crm.assistant_conversations;
create trigger assistant_conversations_set_updated_at
  before update on crm.assistant_conversations
  for each row execute function private.set_updated_at();

create table if not exists crm.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  conversation_id uuid not null references crm.assistant_conversations (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  role text not null,
  content text not null default '',
  tool_calls jsonb,
  tool_call_id text,
  tool_name text,
  actions jsonb,
  sources jsonb,
  model text,
  usage jsonb,
  created_at timestamptz not null default now(),
  constraint assistant_messages_role check (role in ('user', 'assistant', 'tool')),
  constraint assistant_messages_content_length check (char_length(content) <= 4000000),
  constraint assistant_messages_tool_calls_array check (tool_calls is null or jsonb_typeof(tool_calls) = 'array'),
  constraint assistant_messages_actions_array check (actions is null or jsonb_typeof(actions) = 'array'),
  constraint assistant_messages_sources_array check (sources is null or jsonb_typeof(sources) = 'array')
);

create index if not exists assistant_messages_conversation_idx
  on crm.assistant_messages (conversation_id, seq);
create index if not exists assistant_messages_user_idx on crm.assistant_messages (user_id);
create index if not exists assistant_messages_workspace_idx on crm.assistant_messages (workspace_id);

alter table crm.assistant_conversations enable row level security;
alter table crm.assistant_conversations force row level security;
alter table crm.assistant_messages enable row level security;
alter table crm.assistant_messages force row level security;

drop policy if exists assistant_conversations_owner on crm.assistant_conversations;
create policy assistant_conversations_owner on crm.assistant_conversations
  for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

drop policy if exists assistant_messages_owner on crm.assistant_messages;
create policy assistant_messages_owner on crm.assistant_messages
  for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and conversation_id in (
      select c.id from crm.assistant_conversations c
      where c.user_id = (select private.session_user_id())
    )
  );

revoke all on crm.assistant_conversations from anon, authenticated, crm_agent;
revoke all on crm.assistant_messages from anon, authenticated, crm_agent;
grant select, insert, delete on crm.assistant_conversations to authenticated;
grant update (title, model, reasoning, web_search, archived_at, updated_at) on crm.assistant_conversations to authenticated;
grant select, insert, delete on crm.assistant_messages to authenticated;
grant update (content, actions) on crm.assistant_messages to authenticated;
