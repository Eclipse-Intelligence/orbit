alter table crm.assistant_messages add column if not exists page_context text;

alter table crm.assistant_messages drop constraint if exists assistant_messages_page_context_length;
alter table crm.assistant_messages add constraint assistant_messages_page_context_length
  check (page_context is null or char_length(page_context) <= 20000);
