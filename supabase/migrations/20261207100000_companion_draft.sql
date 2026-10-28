alter table crm.ai_companion_jobs add column if not exists draft text;
alter table crm.ai_companion_jobs drop constraint if exists ai_companion_jobs_draft_length;
alter table crm.ai_companion_jobs add constraint ai_companion_jobs_draft_length check (draft is null or char_length(draft) <= 200000);
grant update (draft) on crm.ai_companion_jobs to authenticated;
