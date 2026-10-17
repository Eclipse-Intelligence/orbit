alter table crm.companies add column if not exists brand jsonb;
alter table crm.companies drop constraint if exists companies_brand_object;
alter table crm.companies add constraint companies_brand_object check (brand is null or jsonb_typeof(brand) = 'object');

alter table crm.enrichment_lookups drop constraint if exists enrichment_lookups_field;
alter table crm.enrichment_lookups add constraint enrichment_lookups_field check (field in ('email', 'linkedin', 'phone', 'company'));
