set lock_timeout = '5s';

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
  user_id uuid not null references crm.profiles (id) on delete cascade,
  primary key (source_id, thread_key)
);

drop policy if exists mail_sent_threads_owner on crm.mail_sent_threads;
alter table crm.mail_sent_threads drop column if exists workspace_id;

create index if not exists mail_sent_threads_user_idx on crm.mail_sent_threads (user_id);

alter table crm.mail_sent_threads enable row level security;
alter table crm.mail_sent_threads force row level security;

create policy mail_sent_threads_owner on crm.mail_sent_threads
  for select to authenticated
  using (user_id = (select private.session_user_id()));

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
    if exists (select 1 from crm.mail_sent_threads t where t.source_id = old.source_id and t.thread_key = old.thread_key) then
      perform pg_advisory_xact_lock(hashtextextended(old.source_id::text || '|' || old.thread_key, 0));
      if not exists (
        select 1 from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
        where m.source_id = old.source_id and m.thread_key = old.thread_key and f.role = 'sent'
      ) then
        delete from crm.mail_sent_threads t where t.source_id = old.source_id and t.thread_key = old.thread_key;
      end if;
    end if;
  end if;
  if (tg_op = 'INSERT' or (tg_op = 'UPDATE' and (old.folder_id is distinct from new.folder_id or old.thread_key is distinct from new.thread_key)))
    and new.thread_key is not null
    and exists (select 1 from crm.mail_folders f where f.id = new.folder_id and f.role = 'sent') then
    perform pg_advisory_xact_lock(hashtextextended(new.source_id::text || '|' || new.thread_key, 0));
    insert into crm.mail_sent_threads (source_id, thread_key, user_id)
    values (new.source_id, new.thread_key, new.user_id)
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
    insert into crm.mail_sent_threads (source_id, thread_key, user_id)
    select distinct m.source_id, m.thread_key, m.user_id
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

insert into crm.mail_sent_threads (source_id, thread_key, user_id)
select distinct m.source_id, m.thread_key, m.user_id
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

create or replace function private.bump_mail_version(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_flag text := 'orbit.mail_version_' || replace(p_user::text, '-', '');
begin
  if p_user is null or current_setting(v_flag, true) = '1' then
    return;
  end if;
  perform set_config(v_flag, '1', true);
  if not exists (select 1 from crm.profiles p where p.id = p_user) then
    return;
  end if;
  insert into crm.mail_versions as v (user_id, version, changed_at) values (p_user, 1, now())
  on conflict (user_id) do update set version = v.version + 1, changed_at = now();
end;
$$;

revoke all on function private.bump_mail_version(uuid) from public;

create or replace function private.mail_version_bump()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.bump_mail_version(case when tg_op = 'DELETE' then old.user_id else new.user_id end);
  return null;
end;
$$;

revoke all on function private.mail_version_bump() from public;

create or replace function private.contact_mail_version_bump()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace uuid;
  v_flag text;
  v_user uuid;
begin
  foreach v_workspace in array array_remove(array[
    case when tg_op in ('UPDATE', 'DELETE') then old.workspace_id end,
    case when tg_op in ('UPDATE', 'INSERT') then new.workspace_id end
  ], null) loop
    v_flag := 'orbit.mail_version_ws_' || replace(v_workspace::text, '-', '');
    continue when current_setting(v_flag, true) = '1';
    perform set_config(v_flag, '1', true);
    for v_user in
      select distinct wm.user_id from crm.workspace_members wm
      where wm.workspace_id = v_workspace and exists (select 1 from crm.mail_sources s where s.user_id = wm.user_id)
    loop
      perform private.bump_mail_version(v_user);
    end loop;
  end loop;
  return null;
end;
$$;

revoke all on function private.contact_mail_version_bump() from public;

do $$
declare
  v_spec text[];
begin
  foreach v_spec slice 1 in array array[
    ['mail_messages', '(old.folder_id, old.thread_key, old.is_read, old.is_flagged, old.is_draft, old.has_attachments, old.subject, old.snippet, old.from_email, old.from_name, old.received_at, old.sent_at, old.focused, old.tracking_id) is distinct from (new.folder_id, new.thread_key, new.is_read, new.is_flagged, new.is_draft, new.has_attachments, new.subject, new.snippet, new.from_email, new.from_name, new.received_at, new.sent_at, new.focused, new.tracking_id)'],
    ['mail_folders', '(old.name, old.role, old.parent_provider_id, old.sync_state = ''skipped'') is distinct from (new.name, new.role, new.parent_provider_id, new.sync_state = ''skipped'')'],
    ['mail_sources', '(old.email, old.connection_id, old.account_id) is distinct from (new.email, new.connection_id, new.account_id)'],
    ['mail_reminders', '(old.state, old.kind, old.action, old.due_at, old.surfaced_at, old.thread_key) is distinct from (new.state, new.kind, new.action, new.due_at, new.surfaced_at, new.thread_key)'],
    ['mail_drafts', '(old.send_at, old.send_error) is distinct from (new.send_at, new.send_error)'],
    ['mail_sender_rules', '(old.sender, old.split) is distinct from (new.sender, new.split)'],
    ['mail_prepared', '(old.state, old.kind, old.message_id) is distinct from (new.state, new.kind, new.message_id)'],
    ['mail_opens', 'false']
  ] loop
    execute format('drop trigger if exists %I on crm.%I', v_spec[1] || '_version', v_spec[1]);
    execute format('drop trigger if exists %I on crm.%I', v_spec[1] || '_version_change', v_spec[1]);
    execute format(
      'create constraint trigger %I after insert or delete on crm.%I deferrable initially deferred for each row execute function private.mail_version_bump()',
      v_spec[1] || '_version', v_spec[1]
    );
    if v_spec[2] <> 'false' then
      execute format(
        'create constraint trigger %I after update on crm.%I deferrable initially deferred for each row when (%s) execute function private.mail_version_bump()',
        v_spec[1] || '_version_change', v_spec[1], v_spec[2]
      );
    end if;
  end loop;
end;
$$;

drop trigger if exists contacts_mail_version on crm.contacts;
drop trigger if exists contacts_mail_version_insert on crm.contacts;
drop trigger if exists contacts_mail_version_delete on crm.contacts;
drop trigger if exists contacts_mail_version_change on crm.contacts;

create constraint trigger contacts_mail_version_insert
  after insert on crm.contacts
  deferrable initially deferred
  for each row when (new.normalized_email is not null and new.archived_at is null)
  execute function private.contact_mail_version_bump();

create constraint trigger contacts_mail_version_delete
  after delete on crm.contacts
  deferrable initially deferred
  for each row when (old.normalized_email is not null and old.archived_at is null)
  execute function private.contact_mail_version_bump();

create constraint trigger contacts_mail_version_change
  after update on crm.contacts
  deferrable initially deferred
  for each row when ((old.normalized_email, old.archived_at is null, old.workspace_id) is distinct from (new.normalized_email, new.archived_at is null, new.workspace_id))
  execute function private.contact_mail_version_bump();

create or replace function private.mail_open_owner(p_tracking uuid)
returns table (
  workspace_id uuid,
  workspace_name text,
  user_id uuid,
  role text,
  email text,
  full_name text,
  subject text,
  recipients jsonb,
  opens integer,
  notify_reads boolean,
  source_id uuid,
  thread_key text
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
  select w.id, w.name, t.user_id, m.role, p.email, p.full_name, t.subject, t.recipients,
    (select count(*)::integer from crm.mail_opens o where o.tracking_id = t.id),
    coalesce(pref.notify_reads, false),
    msg.source_id, msg.tk
  from crm.mail_tracking t
  join crm.workspace_members m on m.user_id = t.user_id and m.workspace_id = t.workspace_id
  join crm.workspaces w on w.id = t.workspace_id
  join crm.profiles p on p.id = t.user_id
  left join crm.mail_preferences pref on pref.user_id = t.user_id and pref.workspace_id = t.workspace_id
  left join lateral (
    select mm.source_id, mm.thread_key as tk
    from crm.mail_messages mm where mm.tracking_id = t.id limit 1
  ) msg on true
  where t.id = p_tracking;
end;
$$;

revoke all on function private.mail_open_owner(uuid) from public;
grant execute on function private.mail_open_owner(uuid) to crm_app;

create index if not exists mail_messages_unread_idx on crm.mail_messages (folder_id, thread_key) where not is_read;
create index if not exists mail_messages_user_at_idx on crm.mail_messages (user_id, (coalesce(sent_at, received_at, created_at)));

alter table crm.mail_messages drop constraint if exists mail_messages_thread_key_present;
alter table crm.mail_messages add constraint mail_messages_thread_key_present check (thread_key is not null) not valid;
alter table crm.mail_messages validate constraint mail_messages_thread_key_present;
alter table crm.mail_messages alter column thread_key set not null;
alter table crm.mail_messages drop constraint if exists mail_messages_thread_key_present;

reset lock_timeout;
