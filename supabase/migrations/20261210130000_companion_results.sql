alter table crm.ai_companion_jobs add column if not exists results jsonb not null default '{}'::jsonb;

alter table crm.ai_companion_jobs drop constraint if exists ai_companion_jobs_results_object;
alter table crm.ai_companion_jobs add constraint ai_companion_jobs_results_object check (jsonb_typeof(results) = 'object');

grant update (results) on crm.ai_companion_jobs to authenticated;
