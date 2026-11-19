set lock_timeout = '5s';

alter table crm.chat_messages add column if not exists format text not null default 'plain';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_format_check' and conrelid = 'crm.chat_messages'::regclass) then
    alter table crm.chat_messages add constraint chat_messages_format_check check (format in ('plain', 'markdown')) not valid;
  end if;
end;
$$;

alter table crm.chat_messages validate constraint chat_messages_format_check;

grant insert (format) on crm.chat_messages to authenticated;
grant update (format) on crm.chat_messages to authenticated;

reset lock_timeout;
