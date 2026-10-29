create table if not exists crm.page_watchers (
  page_id uuid not null references crm.pages (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (page_id, user_id)
);

create index if not exists page_watchers_seen_idx on crm.page_watchers (page_id, seen_at desc);
create index if not exists page_watchers_user_idx on crm.page_watchers (user_id);

alter table crm.page_watchers enable row level security;
alter table crm.page_watchers force row level security;

drop policy if exists page_watchers_own on crm.page_watchers;
create policy page_watchers_own on crm.page_watchers
  for all to authenticated
  using (user_id = (select private.session_user_id()))
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
    and exists (select 1 from crm.pages p where p.id = page_watchers.page_id and p.workspace_id = page_watchers.workspace_id)
  );

revoke all on crm.page_watchers from anon, authenticated, crm_agent;
grant select, insert, update, delete on crm.page_watchers to authenticated;

create or replace function private.page_watched(p_page uuid, p_within_seconds integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from crm.page_watchers w
    where w.page_id = p_page and w.seen_at > now() - make_interval(secs => greatest(1, least(p_within_seconds, 3600)))
  )
$$;

revoke all on function private.page_watched(uuid, integer) from public;
grant execute on function private.page_watched(uuid, integer) to crm_app;

alter table crm.pages add column if not exists ydoc_generation integer not null default 0;

grant update (ydoc_generation) on crm.pages to authenticated, crm_agent;

create or replace function private.pages_revoke_watchers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.archived_at is not null then
    delete from crm.page_watchers w where w.page_id = new.id;
  elsif not new.effective_shared then
    delete from crm.page_watchers w where w.page_id = new.id and w.user_id is distinct from new.user_id;
  end if;
  return null;
end;
$$;

revoke all on function private.pages_revoke_watchers() from public;

drop trigger if exists pages_revoke_watchers on crm.pages;
create trigger pages_revoke_watchers
  after update on crm.pages
  for each row
  when (
    (new.archived_at is not null and old.archived_at is null)
    or (old.effective_shared and not new.effective_shared)
    or (not new.effective_shared and old.user_id is distinct from new.user_id)
  )
  execute function private.pages_revoke_watchers();

do $$
begin
  execute 'drop policy if exists page_watchers_definer on crm.page_watchers';
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    execute format('create policy page_watchers_definer on crm.page_watchers for all to %I using (true) with check (true)', current_user);
  end if;
end;
$$;

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
              case when (select realtime.topic()) ~ '^doc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then substr((select realtime.topic()), 5)::uuid
              end
            )
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
            case when (select realtime.topic()) ~ '^doc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then substr((select realtime.topic()), 5)::uuid
            end
          )
            and p.archived_at is null
        )
      )
  $policy$;
end;
$$;
