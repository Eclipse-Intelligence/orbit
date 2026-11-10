alter table crm.assistant_messages add column if not exists steering text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assistant_messages_steering') then
    alter table crm.assistant_messages
      add constraint assistant_messages_steering check (steering is null or (role = 'user' and steering in ('waiting', 'folded')));
  end if;
end;
$$;

create index if not exists assistant_messages_waiting_idx
  on crm.assistant_messages (conversation_id, seq)
  where steering = 'waiting';

alter table crm.assistant_conversations add column if not exists turn_runner uuid;
alter table crm.assistant_conversations add column if not exists turn_until timestamptz;

alter table crm.assistant_conversations enable row level security;
alter table crm.assistant_conversations force row level security;
alter table crm.assistant_messages enable row level security;
alter table crm.assistant_messages force row level security;

grant update (steering, seq) on crm.assistant_messages to authenticated;
grant update (turn_runner, turn_until) on crm.assistant_conversations to authenticated;

drop trigger if exists assistant_conversations_set_updated_at on crm.assistant_conversations;
create trigger assistant_conversations_set_updated_at
  before update on crm.assistant_conversations
  for each row
  when (new.turn_runner is not distinct from old.turn_runner and new.turn_until is not distinct from old.turn_until)
  execute function private.set_updated_at();

create or replace function private.assistant_waiting_conversations(p_limit integer)
returns table (conversation_id uuid, workspace_id uuid, user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select c.id, c.workspace_id, c.user_id
  from crm.assistant_conversations c
  where c.id in (
      select m.conversation_id from crm.assistant_messages m
      where m.steering = 'waiting' and m.role = 'user' and m.created_at < now() - interval '1 minute'
    )
    and c.archived_at is null
    and (c.turn_until is null or c.turn_until < now())
    and not exists (
      select 1 from crm.ai_companion_jobs j where j.conversation_id = c.id and j.status in ('queued', 'running')
    )
    and not exists (
      select 1 from crm.assistant_messages m
      where m.conversation_id = c.id and (m.actions @> '[{"status":"pending"}]'::jsonb or m.actions @> '[{"status":"running"}]'::jsonb)
    )
  order by c.updated_at
  limit greatest(1, least(p_limit, 20));
end;
$$;

revoke all on function private.assistant_waiting_conversations(integer) from public;
grant execute on function private.assistant_waiting_conversations(integer) to crm_app;
