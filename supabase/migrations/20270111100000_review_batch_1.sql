create or replace function private.member_known_address(p_user uuid, p_address text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from (
      select p.email from crm.profiles p where p.id = p_user
      union all
      select other from crm.profiles p cross join lateral unnest(coalesce(p.other_emails, '{}'::text[])) as other where p.id = p_user
      union all
      select c.email from crm.mailbox_connections c where c.user_id = p_user
      union all
      select a.email from crm.calendar_accounts a where a.user_id = p_user
      union all
      select s.email from crm.mail_sources s where s.user_id = p_user
      union all
      select i.email from crm.send_identities i where i.user_id = p_user
    ) known (email)
    where known.email is not null and lower(btrim(known.email)) = lower(btrim(p_address))
  );
$$;

revoke all on function private.member_known_address(uuid, text) from public;
grant execute on function private.member_known_address(uuid, text) to crm_app;

create or replace function private.agent_sender_refusal(p_user uuid, p_address text, p_saved boolean default false)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if private.member_known_address(p_user, p_address) then
    return null;
  end if;
  select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), '')) into v_name from crm.profiles p where p.id = p_user;
  v_name := coalesce(v_name, 'That member');
  if p_saved then
    return format('%s is no longer one of %s''s addresses. Remove it from the list, or %s can add it again in Settings › Email.', lower(btrim(p_address)), v_name, v_name);
  end if;
  return format('%s isn''t one of %s''s addresses. %s can add it in Settings › Email.', lower(btrim(p_address)), v_name, v_name);
end;
$$;

revoke all on function private.agent_sender_refusal(uuid, text, boolean) from public;
grant execute on function private.agent_sender_refusal(uuid, text, boolean) to crm_app;

create or replace function private.agent_mailbox_sender_owned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refusal text;
begin
  v_refusal := private.agent_sender_refusal(new.user_id, new.address, false);
  if v_refusal is null then
    return new;
  end if;
  raise exception '%', v_refusal using errcode = '23514', constraint = 'agent_mailbox_senders_owned';
end;
$$;

revoke all on function private.agent_mailbox_sender_owned() from public;

drop trigger if exists agent_mailbox_senders_owned on crm.agent_mailbox_senders;
create trigger agent_mailbox_senders_owned
  before insert or update of address, user_id on crm.agent_mailbox_senders
  for each row execute function private.agent_mailbox_sender_owned();

alter table crm.mail_messages add column if not exists arrival_pending boolean not null default false;

create index if not exists mail_messages_arrival_pending_idx on crm.mail_messages (user_id) where arrival_pending;
