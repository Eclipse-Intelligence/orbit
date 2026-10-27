alter table crm.knowledge_items drop constraint if exists knowledge_items_content;
alter table crm.knowledge_items add constraint knowledge_items_content check (content is null or char_length(content) <= 2000000);
alter table crm.mail_attachment_texts drop constraint if exists mail_attachment_texts_text;
alter table crm.mail_attachment_texts add constraint mail_attachment_texts_text check (text is null or char_length(text) <= 200000);
