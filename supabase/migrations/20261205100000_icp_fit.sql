alter table crm.enrichment_settings add column if not exists web_icp boolean not null default false;
alter table crm.enrichment_settings add column if not exists icp_text text;
alter table crm.enrichment_settings drop constraint if exists enrichment_settings_icp_text_length;
alter table crm.enrichment_settings add constraint enrichment_settings_icp_text_length check (icp_text is null or char_length(icp_text) <= 20000);

alter table crm.company_web_state add column if not exists icp_score double precision;
alter table crm.company_web_state add column if not exists icp_checked_at timestamptz;
alter table crm.company_web_state add column if not exists icp_hash text;
alter table crm.company_web_state add column if not exists icp_sources jsonb not null default '[]'::jsonb;
alter table crm.company_web_state drop constraint if exists company_web_state_icp_score_range;
alter table crm.company_web_state add constraint company_web_state_icp_score_range check (icp_score is null or (icp_score >= 0 and icp_score <= 4));
alter table crm.company_web_state drop constraint if exists company_web_state_icp_sources_array;
alter table crm.company_web_state add constraint company_web_state_icp_sources_array check (jsonb_typeof(icp_sources) = 'array');

create index if not exists company_web_state_icp_idx on crm.company_web_state (workspace_id, icp_score desc nulls last);

drop policy if exists company_web_state_agent on crm.company_web_state;
create policy company_web_state_agent on crm.company_web_state for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));
grant select on crm.company_web_state to crm_agent;
