set lock_timeout = '5s';

create table if not exists crm.chat_saved (
  user_id uuid not null references crm.profiles (id) on delete cascade,
  message_id uuid not null references crm.chat_messages (id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, message_id)
);

create index if not exists chat_saved_list_idx on crm.chat_saved (user_id, created_at desc, message_id desc);
create index if not exists chat_saved_message_idx on crm.chat_saved (message_id);

alter table crm.chat_saved enable row level security;
alter table crm.chat_saved force row level security;

drop policy if exists chat_saved_select on crm.chat_saved;
create policy chat_saved_select on crm.chat_saved
  for select to authenticated
  using (
    user_id = (select private.session_user_id())
    and exists (select 1 from crm.chat_messages m where m.id = chat_saved.message_id)
  );

drop policy if exists chat_saved_insert on crm.chat_saved;
create policy chat_saved_insert on crm.chat_saved
  for insert to authenticated
  with check (
    user_id = (select private.session_user_id())
    and exists (
      select 1 from crm.chat_messages m
      where m.id = chat_saved.message_id and m.kind = 'message' and m.deleted_at is null
    )
  );

drop policy if exists chat_saved_delete on crm.chat_saved;
create policy chat_saved_delete on crm.chat_saved
  for delete to authenticated
  using (user_id = (select private.session_user_id()));

revoke all on crm.chat_saved from anon, authenticated, crm_agent;
grant select, insert, delete on crm.chat_saved to authenticated;

alter table crm.reminders add column if not exists link text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reminders_link_check' and conrelid = 'crm.reminders'::regclass
  ) then
    alter table crm.reminders add constraint reminders_link_check check (
      link is null or (char_length(link) <= 500 and link ~ '^/[A-Za-z0-9][^[:cntrl:][:space:]\\]*$')
    ) not valid;
  end if;
end;
$$;

alter table crm.reminders validate constraint reminders_link_check;

reset lock_timeout;
