set lock_timeout = '5s';

alter table crm.tasks add column if not exists mail_thread_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_mail_thread_key_check' and conrelid = 'crm.tasks'::regclass
  ) then
    alter table crm.tasks
      add constraint tasks_mail_thread_key_check
      check (
        mail_thread_key is null
        or (char_length(mail_thread_key) between 38 and 487 and mail_thread_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|')
      );
  end if;
end;
$$;

create or replace function private.task_mail_link_decode(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_bytes bytea := ''::bytea;
  v_part text[];
begin
  for v_part in select regexp_matches(p_value, '(%[0-9a-fA-F]{2})|([^%]+)|(%)', 'g') loop
    if v_part[1] is not null then
      v_bytes := v_bytes || decode(substr(v_part[1], 2), 'hex');
    else
      v_bytes := v_bytes || convert_to(coalesce(v_part[2], v_part[3]), 'UTF8');
    end if;
  end loop;
  return convert_from(v_bytes, 'UTF8');
exception when others then
  return null;
end;
$$;

revoke all on function private.task_mail_link_decode(text) from public;

create or replace function private.task_mail_link_key(p_line text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_match text[];
  v_value text;
begin
  v_match := regexp_match(
    btrim(p_line, E' \t\r\n\f\v   ﻿'),
    '^\[([^]\n]+)\]\(/mail\?thread=([^)\s]+)\)$'
  );
  if v_match is null then
    return null;
  end if;
  v_value := private.task_mail_link_decode(split_part(v_match[2], '&', 1));
  if v_value is null or strpos(v_value, '|') <> 37 then
    return null;
  end if;
  v_value := lower(left(v_value, 36)) || substr(v_value, 37);
  if char_length(v_value) > 487 or v_value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|.' then
    return null;
  end if;
  return v_value;
end;
$$;

revoke all on function private.task_mail_link_key(text) from public;

create or replace function private.task_mail_link_move(p_description text)
returns table (thread_key text, description text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_line text;
  v_key text;
  v_kept text[] := '{}';
begin
  if p_description is null then
    return;
  end if;
  foreach v_line in array string_to_array(p_description, E'\n') loop
    v_key := private.task_mail_link_key(v_line);
    if v_key is null then
      v_kept := v_kept || v_line;
    elsif thread_key is null then
      thread_key := v_key;
    end if;
  end loop;
  if thread_key is null then
    return;
  end if;
  description := nullif(btrim(array_to_string(v_kept, E'\n'), E' \t\r\n\f\v   ﻿'), '');
  return next;
end;
$$;

revoke all on function private.task_mail_link_move(text) from public;

do $$
begin
  if exists (
    select 1 from crm.tasks
    where mail_thread_key is null and description like '%](/mail?thread=%'
  ) then
    alter table crm.tasks disable trigger tasks_set_updated_at;
    update crm.tasks t
    set mail_thread_key = moved.thread_key, description = moved.description
    from (
      select s.id, m.thread_key, m.description
      from crm.tasks s
      cross join lateral private.task_mail_link_move(s.description) m
      where s.mail_thread_key is null and s.description like '%](/mail?thread=%'
    ) moved
    where t.id = moved.id;
    alter table crm.tasks enable trigger tasks_set_updated_at;
  end if;
end;
$$;

reset lock_timeout;
