set lock_timeout = '3s';

alter table crm.pages add column if not exists live_key text;

alter table crm.pages alter column live_key set default replace(gen_random_uuid()::text, '-', '');

grant update (live_key) on crm.pages to authenticated, crm_agent;

create or replace function private.page_live_kick(p_page uuid, p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;
  begin
    execute 'select realtime.send($1, $2, $3, true)' using '{}'::jsonb, 'kick', 'doc:' || p_page::text || ':' || p_key;
  exception when others then
    null;
  end;
end;
$$;

revoke all on function private.page_live_kick(uuid, text) from public;

create or replace function private.pages_rotate_live_key()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.page_live_kick(old.id, old.live_key);
  new.live_key := replace(gen_random_uuid()::text, '-', '');
  return new;
end;
$$;

revoke all on function private.pages_rotate_live_key() from public;

drop trigger if exists pages_rotate_live_key on crm.pages;
create trigger pages_rotate_live_key
  before update on crm.pages
  for each row
  when (
    (new.archived_at is not null and old.archived_at is null)
    or (old.effective_shared and not new.effective_shared)
    or (not new.effective_shared and old.user_id is distinct from new.user_id)
    or old.workspace_id is distinct from new.workspace_id
  )
  execute function private.pages_rotate_live_key();

create or replace function private.workspace_member_live_revoke()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rotated record;
begin
  for rotated in
    with watched as (
      select p.id, p.live_key as old_key
      from crm.pages p
      where p.workspace_id = old.workspace_id
        and p.live_key is not null
        and exists (select 1 from crm.page_watchers w where w.page_id = p.id and w.user_id = old.user_id)
    ),
    moved as (
      update crm.pages p set live_key = replace(gen_random_uuid()::text, '-', '')
      from watched where p.id = watched.id
      returning p.id
    )
    select watched.id, watched.old_key from watched join moved on moved.id = watched.id
  loop
    perform private.page_live_kick(rotated.id, rotated.old_key);
  end loop;
  delete from crm.page_watchers w where w.user_id = old.user_id and w.workspace_id = old.workspace_id;
  return null;
end;
$$;

revoke all on function private.workspace_member_live_revoke() from public;

drop trigger if exists workspace_members_live_revoke on crm.workspace_members;
create trigger workspace_members_live_revoke
  after delete on crm.workspace_members
  for each row execute function private.workspace_member_live_revoke();

create or replace function private.page_live_state(p_page uuid, p_within_seconds integer)
returns table (live_key text, watched boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select p.live_key,
    exists (
      select 1 from crm.page_watchers w
      where w.page_id = p.id and w.seen_at > now() - make_interval(secs => greatest(1, least(p_within_seconds, 3600)))
    )
  from crm.pages p
  where p.id = p_page
$$;

revoke all on function private.page_live_state(uuid, integer) from public;
grant execute on function private.page_live_state(uuid, integer) to crm_app;

do $$
begin
  if to_regclass('realtime.messages') is null then
    return;
  end if;

  execute 'drop policy if exists docs_live_receive on realtime.messages';
  execute $policy$
    create policy docs_live_receive on realtime.messages
      for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and (
          exists (
            select 1 from crm.pages p
            where p.id = (
              case when (select realtime.topic()) ~ '^doc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}$'
                then substr((select realtime.topic()), 5, 36)::uuid
              end
            )
              and p.live_key = substr((select realtime.topic()), 42)
          )
          or (select realtime.topic()) = 'docs-person:' || (select private.session_user_id())::text
          or (select realtime.topic()) in (select 'docs-workspace:' || w.id::text from private.user_workspace_ids() as w (id))
        )
      )
  $policy$;

  execute 'drop policy if exists docs_live_send on realtime.messages';
  execute $policy$
    create policy docs_live_send on realtime.messages
      for insert to authenticated
      with check (
        realtime.messages.extension = 'broadcast'
        and exists (
          select 1 from crm.pages p
          where p.id = (
            case when (select realtime.topic()) ~ '^doc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}$'
              then substr((select realtime.topic()), 5, 36)::uuid
            end
          )
            and p.live_key = substr((select realtime.topic()), 42)
            and p.archived_at is null
        )
      )
  $policy$;
end;
$$;
