alter table crm.profiles add column if not exists job_title text;

alter table crm.profiles drop constraint if exists profiles_job_title_length;
alter table crm.profiles
  add constraint profiles_job_title_length check (job_title is null or char_length(job_title) <= 120);

create table if not exists crm.personal_context (
  user_id uuid primary key references crm.profiles (id) on delete cascade,
  about text,
  interests text,
  writing text,
  linkedin_url text,
  website_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint personal_context_about_length check (about is null or char_length(about) <= 3000),
  constraint personal_context_interests_length check (interests is null or char_length(interests) <= 3000),
  constraint personal_context_writing_length check (writing is null or char_length(writing) <= 1500),
  constraint personal_context_linkedin_url check (linkedin_url is null or (char_length(linkedin_url) <= 300 and linkedin_url ~ '^https://')),
  constraint personal_context_website_url check (website_url is null or (char_length(website_url) <= 300 and website_url ~ '^https?://'))
);

drop trigger if exists personal_context_set_updated_at on crm.personal_context;
create trigger personal_context_set_updated_at
  before update on crm.personal_context
  for each row execute function private.set_updated_at();

alter table crm.personal_context enable row level security;
alter table crm.personal_context force row level security;

drop policy if exists personal_context_self on crm.personal_context;
create policy personal_context_self on crm.personal_context for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on crm.personal_context from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.personal_context to authenticated;
