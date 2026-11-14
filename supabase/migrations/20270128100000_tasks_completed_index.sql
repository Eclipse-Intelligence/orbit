create index concurrently if not exists tasks_completed_idx on crm.tasks (workspace_id, completed_at) where archived_at is null;
