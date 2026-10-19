alter table crm.companies drop constraint if exists companies_lifecycle;
alter table crm.companies add constraint companies_lifecycle
  check (char_length(btrim(lifecycle)) between 1 and 40);

create index if not exists companies_lifecycle_idx
  on crm.companies (workspace_id, lower(lifecycle))
  where archived_at is null;
