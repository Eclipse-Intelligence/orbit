create schema if not exists realtime;

create table if not exists realtime.messages (
  id uuid not null default gen_random_uuid(),
  topic text not null,
  extension text not null,
  payload jsonb,
  event text,
  private boolean default false,
  updated_at timestamp not null default now(),
  inserted_at timestamp not null default now(),
  binary_payload bytea,
  skip_broadcast boolean default false,
  primary key (id)
);

create or replace function realtime.topic()
returns text
language sql
stable
as $$
  select nullif(current_setting('realtime.topic', true), '')::text;
$$;

alter table realtime.messages enable row level security;

grant usage on schema realtime to anon, authenticated;
grant select, insert on realtime.messages to anon, authenticated;
grant execute on function realtime.topic() to anon, authenticated;
