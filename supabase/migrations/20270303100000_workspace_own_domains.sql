alter table crm.workspace_brands add column if not exists own_domains text[] not null default '{}';

alter table crm.workspace_brands drop constraint if exists workspace_brands_own_domains_count;
alter table crm.workspace_brands add constraint workspace_brands_own_domains_count check (cardinality(own_domains) <= 20);

grant insert (own_domains) on crm.workspace_brands to authenticated;
grant update (own_domains) on crm.workspace_brands to authenticated;
grant select (own_domains) on crm.workspace_brands to crm_agent;
