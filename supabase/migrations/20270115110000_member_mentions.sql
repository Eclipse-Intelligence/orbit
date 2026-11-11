set lock_timeout = '5s';

alter table crm.page_links drop constraint if exists page_links_kind;
alter table crm.page_links add constraint page_links_kind
  check (target_kind in ('page', 'contact', 'company', 'task', 'opportunity', 'proposal', 'member')) not valid;
alter table crm.page_links validate constraint page_links_kind;

reset lock_timeout;
