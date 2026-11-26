set lock_timeout = '5s';

alter table crm.pages add column if not exists public_expires_at timestamptz;

grant update (public_expires_at) on crm.pages to authenticated, crm_agent;

create or replace function private.pages_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  acting_agent uuid := nullif(current_setting('app.agent_id', true), '')::uuid;
  acting_user uuid := (select private.session_user_id());
begin
  if new.user_id is distinct from old.user_id then
    new.assistant_can_edit := false;
  elsif new.assistant_can_edit and not old.assistant_can_edit
    and (new.user_id is null or new.user_id is distinct from (select private.session_user_id())) then
    raise exception 'Only the doc''s owner can let the assistant edit it without asking.' using errcode = '42501';
  end if;
  if old.public_token_hash is not null and new.public_token_hash is distinct from old.public_token_hash then
    raise exception 'A doc''s public link never changes.' using errcode = '42501';
  end if;
  if (new.public_enabled, new.allow_download, new.public_token_hash, new.public_token_enc, new.public_expires_at)
    is distinct from (old.public_enabled, old.allow_download, old.public_token_hash, old.public_token_enc, old.public_expires_at) then
    if pg_trigger_depth() > 1
      and old.public_enabled and not new.public_enabled
      and new.allow_download is not distinct from old.allow_download
      and new.public_token_hash is not distinct from old.public_token_hash
      and new.public_token_enc is not distinct from old.public_token_enc
      and new.public_expires_at is not distinct from old.public_expires_at then
      null;
    elsif acting_agent is not null then
      if old.created_by_agent_id is distinct from acting_agent then
        raise exception 'Only the doc''s owner can change its public link.' using errcode = '42501';
      end if;
    elsif acting_user is not null then
      if old.user_id is distinct from acting_user
        and not (
          old.user_id is null
          and exists (
            select 1 from crm.workspace_members m
            where m.workspace_id = old.workspace_id and m.user_id = acting_user and m.role = 'owner'
          )
        ) then
        raise exception 'Only the doc''s owner can change its public link.' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists pages_guard on crm.pages;
create trigger pages_guard
  before update of assistant_can_edit, user_id, public_enabled, allow_download, public_token_hash, public_token_enc, public_expires_at on crm.pages
  for each row execute function private.pages_guard();

drop function if exists private.public_page(text);

create function private.public_page(p_token_hash text)
returns table (title text, content text, edited_at timestamptz, allow_download boolean, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.title, p.content, p.edited_at, p.allow_download, p.public_expires_at
  from crm.pages p
  where p.public_token_hash = p_token_hash
    and p.public_enabled
    and (p.public_expires_at is null or p.public_expires_at > now())
    and p.archived_at is null
    and p.kind = 'note';
$$;

revoke all on function private.public_page(text) from public;
grant execute on function private.public_page(text) to crm_app;

reset lock_timeout;
