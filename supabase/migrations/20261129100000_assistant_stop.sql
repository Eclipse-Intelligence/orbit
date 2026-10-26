alter table crm.assistant_conversations add column if not exists stopped_at timestamptz;

grant update (stopped_at) on crm.assistant_conversations to authenticated;
grant delete on crm.ai_companion_jobs to authenticated;
