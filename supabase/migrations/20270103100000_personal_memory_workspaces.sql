alter table crm.memories add column if not exists all_workspaces boolean;

create index if not exists memories_personal_all_idx on crm.memories (user_id, updated_at desc)
  where archived_at is null and scope = 'personal' and all_workspaces;

create index if not exists memories_personal_unsorted_idx on crm.memories (user_id)
  where archived_at is null and scope = 'personal' and all_workspaces is null;

alter table crm.proof_entries drop constraint if exists proof_entries_product;
alter table crm.proof_entries drop constraint if exists proof_entries_product_length;
alter table crm.proof_entries alter column product set default '';

update crm.proof_entries set product = 'Eclipse' where product = 'eclipse';
update crm.proof_entries set product = 'Cntent' where product = 'cntent';

alter table crm.proof_entries
  add constraint proof_entries_product_length check (char_length(product) <= 80);
