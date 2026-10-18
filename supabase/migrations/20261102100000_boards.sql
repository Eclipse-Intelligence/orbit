alter table crm.pipelines add column if not exists kind text not null default 'sales';
alter table crm.pipelines add column if not exists position integer not null default 0;
alter table crm.pipelines add column if not exists add_on_won boolean not null default false;

alter table crm.pipelines drop constraint if exists pipelines_kind;
alter table crm.pipelines
  add constraint pipelines_kind check (kind in ('sales', 'board'));

alter table crm.pipelines drop constraint if exists pipelines_default_sales;
alter table crm.pipelines
  add constraint pipelines_default_sales check (not is_default or kind = 'sales');

alter table crm.pipelines drop constraint if exists pipelines_position;
alter table crm.pipelines
  add constraint pipelines_position check (position >= 0);

create index if not exists opportunities_pipeline_idx
  on crm.opportunities (pipeline_id, company_id)
  where archived_at is null;
