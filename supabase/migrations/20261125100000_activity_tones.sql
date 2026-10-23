create table if not exists crm.activity_tones (
  activity_id uuid primary key references crm.activities (id) on delete cascade,
  workspace_id uuid not null references crm.workspaces (id) on delete cascade,
  tone text not null,
  automatic boolean not null default false,
  reason text,
  model text,
  created_at timestamptz not null default now(),
  constraint activity_tones_tone check (tone in ('positive', 'neutral', 'negative')),
  constraint activity_tones_reason check (reason is null or char_length(reason) <= 300)
);

create index if not exists activity_tones_workspace_idx on crm.activity_tones (workspace_id);

alter table crm.activity_tones enable row level security;
alter table crm.activity_tones force row level security;

drop policy if exists activity_tones_member on crm.activity_tones;
create policy activity_tones_member on crm.activity_tones for all to authenticated
  using (workspace_id in (select private.user_workspace_ids()))
  with check (workspace_id in (select private.user_workspace_ids()));

drop policy if exists activity_tones_agent on crm.activity_tones;
create policy activity_tones_agent on crm.activity_tones for select to crm_agent
  using (workspace_id = (select private.request_workspace_id()));

revoke all on crm.activity_tones from anon, authenticated, crm_agent;
grant select, insert, update on crm.activity_tones to authenticated;
grant select on crm.activity_tones to crm_agent;
