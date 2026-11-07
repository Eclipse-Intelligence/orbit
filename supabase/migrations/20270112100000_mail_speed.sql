create or replace function private.mail_message_thread_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.thread_key is null
    or (tg_op = 'UPDATE'
      and new.thread_key ~ '^m:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and new.thread_key <> 'm:' || new.id::text) then
    new.thread_key := 'm:' || new.id::text;
  end if;
  return new;
end;
$$;

revoke all on function private.mail_message_thread_key() from public;

drop trigger if exists mail_messages_thread_key on crm.mail_messages;
create trigger mail_messages_thread_key
  before insert or update of thread_key on crm.mail_messages
  for each row execute function private.mail_message_thread_key();

update crm.mail_messages set thread_key = 'm:' || id::text where thread_key is null;

create table if not exists crm.mail_sent_threads (
  source_id uuid not null references crm.mail_sources (id) on delete cascade,
  thread_key text not null,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  user_id uuid not null references crm.profiles (id) on delete cascade,
  primary key (source_id, thread_key)
);

create index if not exists mail_sent_threads_user_idx on crm.mail_sent_threads (user_id);

alter table crm.mail_sent_threads enable row level security;
alter table crm.mail_sent_threads force row level security;

drop policy if exists mail_sent_threads_owner on crm.mail_sent_threads;
create policy mail_sent_threads_owner on crm.mail_sent_threads
  for select to authenticated
  using (user_id = (select private.session_user_id()) and workspace_id in (select private.user_workspace_ids()));

revoke all on crm.mail_sent_threads from anon, authenticated, crm_agent;
grant select on crm.mail_sent_threads to authenticated;

create or replace function private.mail_sent_threads_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and (old.folder_id is distinct from new.folder_id or old.thread_key is distinct from new.thread_key)) then
    if exists (select 1 from crm.mail_sent_threads t where t.source_id = old.source_id and t.thread_key = old.thread_key)
      and not exists (
        select 1 from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
        where m.source_id = old.source_id and m.thread_key = old.thread_key and f.role = 'sent'
      ) then
      delete from crm.mail_sent_threads t where t.source_id = old.source_id and t.thread_key = old.thread_key;
    end if;
  end if;
  if (tg_op = 'INSERT' or (tg_op = 'UPDATE' and (old.folder_id is distinct from new.folder_id or old.thread_key is distinct from new.thread_key)))
    and new.thread_key is not null
    and exists (select 1 from crm.mail_folders f where f.id = new.folder_id and f.role = 'sent') then
    insert into crm.mail_sent_threads (source_id, thread_key, workspace_id, user_id)
    values (new.source_id, new.thread_key, new.workspace_id, new.user_id)
    on conflict (source_id, thread_key) do nothing;
  end if;
  return null;
end;
$$;

revoke all on function private.mail_sent_threads_sync() from public;

drop trigger if exists mail_messages_sent_threads on crm.mail_messages;
create trigger mail_messages_sent_threads
  after insert or update of folder_id, thread_key or delete on crm.mail_messages
  for each row execute function private.mail_sent_threads_sync();

create or replace function private.mail_folder_sent_threads()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role = 'sent' then
    insert into crm.mail_sent_threads (source_id, thread_key, workspace_id, user_id)
    select distinct m.source_id, m.thread_key, m.workspace_id, m.user_id
    from crm.mail_messages m where m.folder_id = new.id and m.thread_key is not null
    on conflict (source_id, thread_key) do nothing;
  else
    delete from crm.mail_sent_threads t
    where t.source_id = new.source_id
      and t.thread_key in (select m.thread_key from crm.mail_messages m where m.folder_id = new.id)
      and not exists (
        select 1 from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
        where m.source_id = t.source_id and m.thread_key = t.thread_key and f.role = 'sent'
      );
  end if;
  return null;
end;
$$;

revoke all on function private.mail_folder_sent_threads() from public;

drop trigger if exists mail_folders_sent_threads on crm.mail_folders;
create trigger mail_folders_sent_threads
  after update of role on crm.mail_folders
  for each row when (old.role is distinct from new.role and (old.role = 'sent' or new.role = 'sent'))
  execute function private.mail_folder_sent_threads();

insert into crm.mail_sent_threads (source_id, thread_key, workspace_id, user_id)
select distinct m.source_id, m.thread_key, m.workspace_id, m.user_id
from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
where f.role = 'sent' and m.thread_key is not null
on conflict (source_id, thread_key) do nothing;

create table if not exists crm.mail_versions (
  user_id uuid primary key references crm.profiles (id) on delete cascade,
  version bigint not null default 0,
  changed_at timestamptz not null default now()
);

alter table crm.mail_versions enable row level security;
alter table crm.mail_versions force row level security;

drop policy if exists mail_versions_owner on crm.mail_versions;
create policy mail_versions_owner on crm.mail_versions
  for select to authenticated
  using (user_id = (select private.session_user_id()));

revoke all on crm.mail_versions from anon, authenticated, crm_agent;
grant select on crm.mail_versions to authenticated;

create or replace function private.mail_version_bump()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  v_flag text;
begin
  if v_user is null then
    return null;
  end if;
  v_flag := 'orbit.mail_version_' || replace(v_user::text, '-', '');
  if current_setting(v_flag, true) = '1' then
    return null;
  end if;
  perform set_config(v_flag, '1', true);
  insert into crm.mail_versions as v (user_id, version, changed_at) values (v_user, 1, now())
  on conflict (user_id) do update set version = v.version + 1, changed_at = now();
  return null;
end;
$$;

revoke all on function private.mail_version_bump() from public;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['mail_messages', 'mail_folders', 'mail_sources', 'mail_reminders', 'mail_drafts', 'mail_sender_rules', 'mail_prepared', 'mail_opens'] loop
    execute format('drop trigger if exists %I on crm.%I', v_table || '_version', v_table);
    execute format(
      'create constraint trigger %I after insert or update or delete on crm.%I deferrable initially deferred for each row execute function private.mail_version_bump()',
      v_table || '_version', v_table
    );
  end loop;
end;
$$;

create index if not exists mail_messages_unread_idx on crm.mail_messages (folder_id, thread_key) where not is_read;
create index if not exists mail_messages_user_at_idx on crm.mail_messages (user_id, (coalesce(sent_at, received_at, created_at)));

alter table crm.mail_messages drop constraint if exists mail_messages_thread_key_present;
alter table crm.mail_messages add constraint mail_messages_thread_key_present check (thread_key is not null) not valid;
alter table crm.mail_messages validate constraint mail_messages_thread_key_present;
alter table crm.mail_messages alter column thread_key set not null;
alter table crm.mail_messages drop constraint if exists mail_messages_thread_key_present;
