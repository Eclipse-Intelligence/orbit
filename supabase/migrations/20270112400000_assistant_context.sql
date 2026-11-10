alter table crm.assistant_messages add column if not exists page_context text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assistant_messages_page_context_length') then
    alter table crm.assistant_messages
      add constraint assistant_messages_page_context_length check (page_context is null or char_length(page_context) <= 300000);
  end if;
end;
$$;
