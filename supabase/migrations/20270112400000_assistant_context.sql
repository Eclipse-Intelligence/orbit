alter table crm.assistant_messages add column if not exists page_context text;
alter table crm.assistant_messages add column if not exists turn_context text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assistant_messages_page_context_length') then
    alter table crm.assistant_messages
      add constraint assistant_messages_page_context_length check (page_context is null or char_length(page_context) <= 300000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'assistant_messages_turn_context_length') then
    alter table crm.assistant_messages
      add constraint assistant_messages_turn_context_length check (turn_context is null or (role = 'user' and char_length(turn_context) <= 200000));
  end if;
end;
$$;

create or replace function private.keep_turn_context()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.turn_context is not null and new.turn_context is distinct from old.turn_context then
    raise exception 'The Orbit context of a message is saved once.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists assistant_messages_keep_turn_context on crm.assistant_messages;
create trigger assistant_messages_keep_turn_context
  before update of turn_context on crm.assistant_messages
  for each row execute function private.keep_turn_context();

grant update (turn_context) on crm.assistant_messages to authenticated;
