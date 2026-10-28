alter table crm.enrichment_lookups drop constraint if exists enrichment_lookups_field;
alter table crm.enrichment_lookups add constraint enrichment_lookups_field
  check (field in ('email', 'linkedin', 'phone', 'company', 'email_check'));

alter table crm.enrichment_lookups drop constraint if exists enrichment_lookups_status;
alter table crm.enrichment_lookups add constraint enrichment_lookups_status
  check (status in ('found', 'not_found', 'failed', 'valid', 'invalid', 'unknown'));

alter table crm.enrichment_lookups drop constraint if exists enrichment_lookups_check_status;
alter table crm.enrichment_lookups add constraint enrichment_lookups_check_status
  check ((field = 'email_check') = (status in ('valid', 'invalid', 'unknown')));

create index if not exists enrichment_lookups_address_idx
  on crm.enrichment_lookups (workspace_id, value, created_at desc)
  where field in ('email', 'email_check');

grant select, insert on crm.enrichment_lookups to authenticated, crm_agent;
