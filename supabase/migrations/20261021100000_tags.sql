alter table crm.contacts
  add column if not exists tags text[] not null default '{}';

alter table crm.companies
  add column if not exists tags text[] not null default '{}';

alter table crm.contacts drop constraint if exists contacts_tags_count;
alter table crm.contacts
  add constraint contacts_tags_count check (cardinality(tags) <= 20);

alter table crm.companies drop constraint if exists companies_tags_count;
alter table crm.companies
  add constraint companies_tags_count check (cardinality(tags) <= 20);

create index if not exists contacts_tags_idx on crm.contacts using gin (tags);
create index if not exists companies_tags_idx on crm.companies using gin (tags);
