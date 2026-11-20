reset lock_timeout;

create index concurrently if not exists mail_messages_unread_cover_idx on crm.mail_messages (folder_id, thread_key) include (user_id, workspace_id) where not is_read;

set lock_timeout = '5s';

drop index if exists crm.mail_messages_unread_idx;

reset lock_timeout;
