set lock_timeout = '5s';

create table if not exists crm.mail_share_live (
  share_id uuid primary key references crm.mail_shares (id) on delete cascade,
  ydoc bytea,
  generation integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint mail_share_live_ydoc_check check (ydoc is null or octet_length(ydoc) <= 2000000)
);

alter table crm.mail_share_live enable row level security;
alter table crm.mail_share_live force row level security;

revoke all on crm.mail_share_live from public, anon, authenticated, crm_agent;

do $$
begin
  execute 'drop policy if exists mail_share_live_definer on crm.mail_share_live';
  if not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    execute format('create policy mail_share_live_definer on crm.mail_share_live for all to %I using (true) with check (true)', current_user);
  end if;
end;
$$;

grant execute on function private.mail_share_open_to(uuid, uuid) to crm_app;

create or replace function private.shared_draft_refusal(p_user uuid, p_share crm.mail_shares, p_draft crm.mail_drafts)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner text := private.mail_share_owner_first_name(p_share.owner_user_id);
  v_teammate boolean := p_user is distinct from p_share.owner_user_id;
begin
  if v_teammate and p_draft.send_error is not null then
    return format('Couldn''t send. Read only until %s unschedules it.', v_owner);
  end if;
  if v_teammate and p_draft.send_at is not null then
    return format('Scheduled. Read only until %s unschedules it.', v_owner);
  end if;
  if coalesce(p_draft.sending_at > now() - interval '10 minutes', false) or p_draft.send_attempted_at is not null
    or (v_teammate and coalesce(p_share.draft_held_until > now(), false)) then
    return format('%s is sending. Read only.', v_owner);
  end if;
  return null;
end;
$$;

revoke all on function private.shared_draft_refusal(uuid, crm.mail_shares, crm.mail_drafts) from public;

create or replace function private.shared_draft_live_lock(p_user uuid, p_share uuid)
returns table (owner_user_id uuid, draft_id uuid, body text, ydoc bytea, generation integer, version integer, refusal text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_share crm.mail_shares;
  v_draft crm.mail_drafts;
  v_live crm.mail_share_live;
begin
  if p_user is null or p_share is null or not private.mail_share_open_to(p_share, p_user) then
    raise exception 'You no longer have access to this draft.' using errcode = 'P0002';
  end if;
  select s.* into v_share from crm.mail_shares s where s.id = p_share for update;
  select d.* into v_draft from crm.mail_drafts d where d.id = v_share.draft_id and d.user_id = v_share.owner_user_id for update;
  if v_draft.id is null then
    raise exception 'This draft was sent or discarded.' using errcode = 'P0002';
  end if;
  select l.* into v_live from crm.mail_share_live l where l.share_id = p_share;
  return query select v_share.owner_user_id, v_draft.id, v_draft.body, v_live.ydoc, coalesce(v_live.generation, 0), v_share.draft_version,
    private.shared_draft_refusal(p_user, v_share, v_draft);
end;
$$;

revoke all on function private.shared_draft_live_lock(uuid, uuid) from public;
grant execute on function private.shared_draft_live_lock(uuid, uuid) to crm_app;

create or replace function private.shared_draft_live_store(p_user uuid, p_share uuid, p_draft uuid, p_body text, p_ydoc bytea, p_generation integer)
returns table (version integer, owner_user_id uuid, members uuid[], changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_share crm.mail_shares;
  v_draft crm.mail_drafts;
  v_refusal text;
  v_changed boolean := false;
begin
  if p_user is null or p_share is null or not private.mail_share_open_to(p_share, p_user) then
    raise exception 'You no longer have access to this draft.' using errcode = 'P0002';
  end if;
  select s.* into v_share from crm.mail_shares s where s.id = p_share for update;
  select d.* into v_draft from crm.mail_drafts d where d.id = v_share.draft_id and d.user_id = v_share.owner_user_id for update;
  if v_draft.id is null or v_draft.id <> p_draft then
    raise exception 'This draft was sent or discarded.' using errcode = 'P0002';
  end if;
  if p_generation is null or p_generation < 0 then
    raise exception 'That change wasn''t saved. Reload the draft and try again.' using errcode = '22023';
  end if;
  if p_body is not null and p_body is distinct from v_draft.body then
    v_refusal := private.shared_draft_refusal(p_user, v_share, v_draft);
    if v_refusal is not null then
      raise exception '%', v_refusal using errcode = '55006';
    end if;
    if char_length(p_body) > 20000 then
      raise exception 'Keep the message under 20,000 characters.' using errcode = '22023';
    end if;
    update crm.mail_drafts d set body = p_body, updated_at = now() where d.id = v_draft.id;
    update crm.mail_shares s set draft_version = s.draft_version + 1 where s.id = v_share.id returning * into v_share;
    v_changed := true;
  end if;
  insert into crm.mail_share_live as l (share_id, ydoc, generation, updated_at)
    values (p_share, p_ydoc, p_generation, now())
    on conflict (share_id) do update set ydoc = excluded.ydoc, generation = excluded.generation, updated_at = excluded.updated_at;
  return query select v_share.draft_version, v_share.owner_user_id, array(select m.user_id from crm.mail_share_members m where m.share_id = v_share.id), v_changed;
end;
$$;

revoke all on function private.shared_draft_live_store(uuid, uuid, uuid, text, bytea, integer) from public;
grant execute on function private.shared_draft_live_store(uuid, uuid, uuid, text, bytea, integer) to crm_app;

create or replace function private.mail_share_live_reset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update crm.mail_share_live l set ydoc = null, generation = l.generation + 1, updated_at = now() where l.share_id = new.id;
  return null;
end;
$$;

revoke all on function private.mail_share_live_reset() from public;

drop trigger if exists mail_shares_live_reset on crm.mail_shares;
create trigger mail_shares_live_reset
  after update of draft_id on crm.mail_shares
  for each row
  when (old.draft_id is distinct from new.draft_id and (old.draft_id is null or new.draft_id is null))
  execute function private.mail_share_live_reset();

do $$
begin
  if to_regclass('realtime.messages') is null then
    return;
  end if;

  execute 'drop policy if exists draft_live_receive on realtime.messages';
  execute $policy$
    create policy draft_live_receive on realtime.messages
      for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and (
          case when (select realtime.topic()) ~ '^draft:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then substr((select realtime.topic()), 7)::uuid
          end
        ) in (select private.my_mail_share_ids())
      )
  $policy$;

  execute 'drop policy if exists draft_live_send on realtime.messages';
  execute $policy$
    create policy draft_live_send on realtime.messages
      for insert to authenticated
      with check (
        realtime.messages.extension = 'broadcast'
        and (
          case when (select realtime.topic()) ~ '^draft:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then substr((select realtime.topic()), 7)::uuid
          end
        ) in (select private.my_mail_share_ids())
      )
  $policy$;
end;
$$;

reset lock_timeout;
