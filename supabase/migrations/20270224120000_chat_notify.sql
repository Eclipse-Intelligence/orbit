set lock_timeout = '5s';

alter table crm.chat_members add column if not exists notify text not null default 'default';
alter table crm.chat_members add column if not exists mute_mentions boolean not null default false;
alter table crm.chat_members add column if not exists starred boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_members_notify_check' and conrelid = 'crm.chat_members'::regclass) then
    alter table crm.chat_members add constraint chat_members_notify_check check (notify in ('default', 'all', 'mentions', 'mute')) not valid;
  end if;
end;
$$;

alter table crm.chat_members validate constraint chat_members_notify_check;

grant update (notify, mute_mentions, starred) on crm.chat_members to authenticated;

reset lock_timeout;
