alter table crm.assistant_messages add column if not exists page_context text;

alter table crm.assistant_messages drop constraint if exists assistant_messages_page_context_length;
alter table crm.assistant_messages add constraint assistant_messages_page_context_length
  check (page_context is null or char_length(page_context) <= 20000);

alter table crm.assistant_conversations add column if not exists summary text;
alter table crm.assistant_conversations add column if not exists summary_through bigint;

alter table crm.assistant_conversations drop constraint if exists assistant_conversations_summary_length;
alter table crm.assistant_conversations add constraint assistant_conversations_summary_length
  check (summary is null or char_length(summary) <= 60000);

grant update (summary, summary_through) on crm.assistant_conversations to authenticated;
