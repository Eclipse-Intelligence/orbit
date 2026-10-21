create table if not exists crm.products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  name text not null,
  description text,
  price_gbp numeric(12, 2),
  price_usd numeric(12, 2),
  billing text not null default 'one_off',
  archived_at timestamptz,
  created_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_name check (char_length(name) between 1 and 120),
  constraint products_description check (description is null or char_length(description) <= 4000),
  constraint products_billing check (billing in ('one_off', 'monthly', 'yearly')),
  constraint products_prices check ((price_gbp is null or price_gbp >= 0) and (price_usd is null or price_usd >= 0))
);

create index if not exists products_workspace_idx on crm.products (workspace_id, archived_at);

create table if not exists crm.document_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  kind text not null,
  name text not null,
  status text not null default 'draft',
  blocks jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_templates_kind check (kind in ('proposal', 'nda')),
  constraint document_templates_status check (status in ('draft', 'active', 'archived')),
  constraint document_templates_name check (char_length(name) between 1 and 120),
  constraint document_templates_blocks check (jsonb_typeof(blocks) = 'array' and pg_column_size(blocks) <= 400000)
);

create index if not exists document_templates_workspace_idx on crm.document_templates (workspace_id, status);

create table if not exists crm.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  kind text not null,
  template_id uuid references crm.document_templates (id) on delete set null,
  title text not null,
  status text not null default 'draft',
  company_id uuid not null references crm.companies (id) on delete cascade,
  contact_id uuid not null references crm.contacts (id) on delete cascade,
  opportunity_id uuid references crm.opportunities (id) on delete set null,
  owner_id uuid not null references crm.profiles (id) on delete cascade,
  currency text not null default 'GBP',
  items jsonb not null default '[]'::jsonb,
  blocks jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  valid_until date,
  current_version_id uuid,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer not null default 0,
  client_signed_at timestamptz,
  completed_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  withdrawn_at timestamptz,
  archived_at timestamptz,
  created_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_kind check (kind in ('proposal', 'nda')),
  constraint documents_status check (status in ('draft', 'sent', 'viewed', 'client_signed', 'completed', 'declined', 'withdrawn')),
  constraint documents_currency check (currency in ('GBP', 'USD')),
  constraint documents_title check (char_length(title) between 1 and 200),
  constraint documents_decline check (decline_reason is null or char_length(decline_reason) <= 2000),
  constraint documents_size check (pg_column_size(blocks) <= 400000 and pg_column_size(items) <= 100000)
);

create index if not exists documents_workspace_idx on crm.documents (workspace_id, status, updated_at desc);
create index if not exists documents_company_idx on crm.documents (company_id);
create index if not exists documents_contact_idx on crm.documents (contact_id);
create index if not exists documents_opportunity_idx on crm.documents (opportunity_id);

create table if not exists crm.document_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  document_id uuid not null references crm.documents (id) on delete cascade,
  number integer not null,
  content jsonb not null,
  content_hash text not null,
  created_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint document_versions_unique unique (document_id, number),
  constraint document_versions_hash check (char_length(content_hash) = 64),
  constraint document_versions_size check (pg_column_size(content) <= 600000)
);

create table if not exists crm.document_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  document_id uuid not null references crm.documents (id) on delete cascade,
  version_id uuid not null references crm.document_versions (id) on delete cascade,
  email text not null,
  token_hash text not null unique,
  token_cipher text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint document_links_hash check (char_length(token_hash) = 64)
);

create index if not exists document_links_document_idx on crm.document_links (document_id);

create table if not exists crm.document_signatures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  document_id uuid not null references crm.documents (id) on delete cascade,
  version_id uuid not null references crm.document_versions (id) on delete cascade,
  role text not null,
  name text not null,
  email text not null,
  title text,
  company text,
  signature_text text not null,
  signature_image text,
  consent text not null,
  method text not null,
  user_id uuid references crm.profiles (id) on delete set null,
  ip text,
  user_agent text,
  signed_at timestamptz not null default now(),
  constraint document_signatures_role check (role in ('client', 'sender')),
  constraint document_signatures_unique unique (version_id, role),
  constraint document_signatures_lengths check (
    char_length(name) between 1 and 200 and char_length(signature_text) between 1 and 200
    and (title is null or char_length(title) <= 200) and (company is null or char_length(company) <= 200)
    and char_length(consent) <= 4000 and (signature_image is null or char_length(signature_image) <= 300000)
  )
);

create table if not exists crm.document_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  document_id uuid not null references crm.documents (id) on delete cascade,
  version_id uuid references crm.document_versions (id) on delete cascade,
  type text not null,
  actor text not null,
  actor_user_id uuid references crm.profiles (id) on delete set null,
  name text,
  email text,
  ip text,
  user_agent text,
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint document_events_actor check (actor in ('user', 'client', 'system', 'agent')),
  constraint document_events_type check (char_length(type) between 1 and 40)
);

create index if not exists document_events_document_idx on crm.document_events (document_id, occurred_at);

create table if not exists crm.document_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  document_id uuid not null references crm.documents (id) on delete cascade,
  version_id uuid not null references crm.document_versions (id) on delete cascade,
  kind text not null,
  data bytea not null,
  sha256 text not null,
  created_at timestamptz not null default now(),
  constraint document_files_kind check (kind in ('issued', 'executed')),
  constraint document_files_unique unique (version_id, kind),
  constraint document_files_size check (octet_length(data) <= 10485760)
);

alter table crm.products enable row level security;
alter table crm.products force row level security;
alter table crm.document_templates enable row level security;
alter table crm.document_templates force row level security;
alter table crm.documents enable row level security;
alter table crm.documents force row level security;
alter table crm.document_versions enable row level security;
alter table crm.document_versions force row level security;
alter table crm.document_links enable row level security;
alter table crm.document_links force row level security;
alter table crm.document_signatures enable row level security;
alter table crm.document_signatures force row level security;
alter table crm.document_events enable row level security;
alter table crm.document_events force row level security;
alter table crm.document_files enable row level security;
alter table crm.document_files force row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['products', 'document_templates', 'documents', 'document_versions', 'document_links', 'document_signatures', 'document_events', 'document_files'] loop
    execute format('drop policy if exists %I on crm.%I', table_name || '_member', table_name);
    execute format(
      'create policy %I on crm.%I for all to authenticated using (workspace_id in (select private.user_workspace_ids())) with check (workspace_id in (select private.user_workspace_ids()))',
      table_name || '_member', table_name
    );
    execute format('drop policy if exists %I on crm.%I', table_name || '_agent', table_name);
    execute format(
      'create policy %I on crm.%I for all to crm_agent using (workspace_id = (select private.request_workspace_id())) with check (workspace_id = (select private.request_workspace_id()))',
      table_name || '_agent', table_name
    );
    execute format('revoke all on crm.%I from anon, authenticated, crm_agent', table_name);
  end loop;
end;
$$;

drop policy if exists documents_delete_draft on crm.documents;
create policy documents_delete_draft on crm.documents as restrictive for delete to authenticated using (status = 'draft');

grant select, insert, update on crm.products, crm.document_templates, crm.documents to authenticated, crm_agent;
grant delete on crm.document_templates, crm.documents to authenticated;
grant select, insert on crm.document_versions, crm.document_signatures, crm.document_events, crm.document_files to authenticated, crm_agent;
grant select, insert on crm.document_links to authenticated, crm_agent;
grant update (revoked_at) on crm.document_links to authenticated, crm_agent;

create or replace function private.document_link_owner(p_token_hash text)
returns table (
  document_id uuid,
  link_id uuid,
  version_id uuid,
  revoked boolean,
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select d.id, l.id, l.version_id, l.revoked_at is not null, w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.document_links l
  join crm.documents d on d.id = l.document_id
  join crm.workspace_members m on m.workspace_id = d.workspace_id and m.user_id = d.owner_id
  join crm.workspaces w on w.id = d.workspace_id
  join crm.profiles p on p.id = d.owner_id
  where l.token_hash = p_token_hash;
end;
$$;

revoke all on function private.document_link_owner(text) from public;
grant execute on function private.document_link_owner(text) to crm_app;
