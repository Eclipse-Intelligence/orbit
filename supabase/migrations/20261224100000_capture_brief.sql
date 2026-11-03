create table if not exists crm.capture_seen (
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists capture_seen_user_idx on crm.capture_seen (user_id);

alter table crm.capture_seen enable row level security;
alter table crm.capture_seen force row level security;

drop policy if exists capture_seen_owner on crm.capture_seen;
create policy capture_seen_owner on crm.capture_seen
  for all to authenticated
  using (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  )
  with check (
    user_id = (select private.session_user_id())
    and workspace_id in (select private.user_workspace_ids())
  );

revoke all on crm.capture_seen from anon, authenticated, crm_agent;
grant select, insert, update on crm.capture_seen to authenticated;

insert into crm.capture_seen (workspace_id, user_id, seen_at)
select m.workspace_id, m.user_id, now()
from crm.workspace_members m
on conflict (workspace_id, user_id) do nothing;

alter table crm.conversation_imports add column if not exists unfiled_at timestamptz;

update crm.conversation_imports
set unfiled_at = updated_at
where status = 'unfiled' and unfiled_at is null;

create or replace function private.stamp_unfiled_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'unfiled' and (tg_op = 'INSERT' or old.status is distinct from 'unfiled') then
    new.unfiled_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists conversation_imports_stamp_unfiled on crm.conversation_imports;
create trigger conversation_imports_stamp_unfiled
  before insert or update of status on crm.conversation_imports
  for each row execute function private.stamp_unfiled_at();

alter table crm.daily_briefs add column if not exists read_at timestamptz;
alter table crm.daily_briefs add column if not exists conversation_id uuid references crm.assistant_conversations (id) on delete set null;

create index if not exists daily_briefs_conversation_idx on crm.daily_briefs (conversation_id) where conversation_id is not null;

create index if not exists activities_actor_user_idx
  on crm.activities (workspace_id, actor_user_id, occurred_at desc)
  where archived_at is null;
