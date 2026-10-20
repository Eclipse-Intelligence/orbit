create table if not exists crm.personal_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  name text not null,
  prefix text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint personal_tokens_name check (char_length(name) between 1 and 80),
  constraint personal_tokens_prefix check (char_length(prefix) between 6 and 40),
  constraint personal_tokens_hash check (char_length(token_hash) = 64)
);

create index if not exists personal_tokens_user_idx on crm.personal_tokens (user_id, created_at desc);

alter table crm.personal_tokens enable row level security;
alter table crm.personal_tokens force row level security;

drop policy if exists personal_tokens_owner on crm.personal_tokens;
create policy personal_tokens_owner on crm.personal_tokens
  for all to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()))
  with check (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.personal_tokens from anon, authenticated, crm_agent;
grant select, insert, update on crm.personal_tokens to authenticated;

create or replace function private.authenticate_personal_token(p_token_hash text)
returns table (
  token_id uuid,
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update crm.personal_tokens t set last_used_at = now()
  where t.token_hash = p_token_hash and t.revoked_at is null
    and (t.last_used_at is null or t.last_used_at < now() - interval '1 minute');
  return query
  select t.id, w.id, w.name, m.user_id, m.role, p.email, p.full_name
  from crm.personal_tokens t
  join crm.workspace_members m on m.user_id = t.user_id and m.workspace_id = t.workspace_id
  join crm.workspaces w on w.id = t.workspace_id
  join crm.profiles p on p.id = t.user_id
  where t.token_hash = p_token_hash and t.revoked_at is null;
end;
$$;

revoke all on function private.authenticate_personal_token(text) from public;
grant execute on function private.authenticate_personal_token(text) to crm_app;
