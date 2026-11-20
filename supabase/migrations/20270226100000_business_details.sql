set lock_timeout = '5s';

alter table crm.workspace_brands add column if not exists business_name text not null default '';
alter table crm.workspace_brands add column if not exists business_address text not null default '';
alter table crm.workspace_brands add column if not exists business_phone text not null default '';
alter table crm.workspace_brands add column if not exists business_email text not null default '';
alter table crm.workspace_brands add column if not exists business_website text not null default '';

alter table crm.workspace_brands drop constraint if exists workspace_brands_business_name_length;
alter table crm.workspace_brands add constraint workspace_brands_business_name_length check (char_length(business_name) <= 200);
alter table crm.workspace_brands drop constraint if exists workspace_brands_business_address_length;
alter table crm.workspace_brands add constraint workspace_brands_business_address_length check (char_length(business_address) <= 500);
alter table crm.workspace_brands drop constraint if exists workspace_brands_business_phone_length;
alter table crm.workspace_brands add constraint workspace_brands_business_phone_length check (char_length(business_phone) <= 50);
alter table crm.workspace_brands drop constraint if exists workspace_brands_business_email_length;
alter table crm.workspace_brands add constraint workspace_brands_business_email_length check (char_length(business_email) <= 254);
alter table crm.workspace_brands drop constraint if exists workspace_brands_business_website_length;
alter table crm.workspace_brands add constraint workspace_brands_business_website_length check (char_length(business_website) <= 300);

grant insert (business_name, business_address, business_phone, business_email, business_website) on crm.workspace_brands to authenticated;
grant update (business_name, business_address, business_phone, business_email, business_website) on crm.workspace_brands to authenticated;

grant select (workspace_id, business_name, business_address, business_phone, business_email, business_website) on crm.workspace_brands to crm_agent;

drop policy if exists workspace_brands_select_agent on crm.workspace_brands;
create policy workspace_brands_select_agent on crm.workspace_brands
  for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));

update crm.document_templates t
set blocks = (
  select jsonb_agg(
    case
      when block->>'type' = 'cover' and block->>'subtitle' = 'Prepared for {{contact.name}} at {{company.name}} by {{sender.name}}, {{workspace.name}}.'
        then jsonb_set(block, '{subtitle}', to_jsonb('Prepared for {{contact.name}} at {{company.name}} by {{sender.name}}.'::text))
      else block
    end
    order by position
  )
  from jsonb_array_elements(t.blocks) with ordinality as item(block, position)
)
where jsonb_typeof(t.blocks) = 'array'
  and t.blocks @> '[{"type": "cover", "subtitle": "Prepared for {{contact.name}} at {{company.name}} by {{sender.name}}, {{workspace.name}}."}]'::jsonb;

update crm.documents d
set blocks = (
  select jsonb_agg(
    case
      when block->>'type' = 'cover' and block->>'subtitle' = 'Prepared for {{contact.name}} at {{company.name}} by {{sender.name}}, {{workspace.name}}.'
        then jsonb_set(block, '{subtitle}', to_jsonb('Prepared for {{contact.name}} at {{company.name}} by {{sender.name}}.'::text))
      else block
    end
    order by position
  )
  from jsonb_array_elements(d.blocks) with ordinality as item(block, position)
)
where d.status = 'draft'
  and jsonb_typeof(d.blocks) = 'array'
  and d.blocks @> '[{"type": "cover", "subtitle": "Prepared for {{contact.name}} at {{company.name}} by {{sender.name}}, {{workspace.name}}."}]'::jsonb;

reset lock_timeout;
