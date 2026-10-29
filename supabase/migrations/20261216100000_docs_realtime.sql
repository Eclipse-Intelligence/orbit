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
