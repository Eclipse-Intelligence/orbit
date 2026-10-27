alter table crm.company_web_state add column if not exists check_claimed_at timestamptz;

alter table crm.enrichment_settings add column if not exists icp_hash text;
update crm.enrichment_settings
set icp_hash = left(encode(sha256(convert_to(icp_text, 'UTF8')), 'hex'), 32)
where icp_text is not null and icp_hash is distinct from left(encode(sha256(convert_to(icp_text, 'UTF8')), 'hex'), 32);

drop policy if exists company_web_state_agent on crm.company_web_state;
create policy company_web_state_agent on crm.company_web_state for all to crm_agent
  using (workspace_id = (select private.request_workspace_id()))
  with check (workspace_id = (select private.request_workspace_id()));
grant select, insert, update on crm.company_web_state to crm_agent;

with learned as (
  select s.workspace_id,
    left(string_agg(
      '- ' || case m.kind when 'icp' then 'Ideal customer' when 'audience' then 'Audience' when 'win_pattern' then 'Why we win' else 'Why we lose' end
        || ': ' || m.title || '. ' || m.body,
      E'\n' order by array_position(array['icp', 'audience', 'win_pattern', 'loss_pattern'], m.kind), m.pinned desc, m.updated_at desc
    ), 20000) as text
  from crm.enrichment_settings s
  join crm.memories m on m.workspace_id = s.workspace_id
  where s.web_icp and s.icp_text is null
    and m.scope = 'business' and m.archived_at is null and m.kind in ('icp', 'audience', 'win_pattern', 'loss_pattern')
  group by s.workspace_id
)
update crm.enrichment_settings s
set icp_text = learned.text, icp_hash = left(encode(sha256(convert_to(learned.text, 'UTF8')), 'hex'), 32)
from learned
where s.workspace_id = learned.workspace_id and s.icp_text is null;
