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
