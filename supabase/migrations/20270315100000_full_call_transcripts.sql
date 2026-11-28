set lock_timeout = '5s';

alter table crm.call_insights add column if not exists part_notes jsonb;
grant update (part_notes) on crm.call_insights to authenticated, crm_agent;

alter table crm.conversation_imports drop constraint if exists conversation_imports_transcript_length;
alter table crm.call_insights drop constraint if exists call_insights_transcript_length;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'call_insights_transcript_present' and conrelid = 'crm.call_insights'::regclass
  ) then
    alter table crm.call_insights add constraint call_insights_transcript_present
      check (char_length(transcript) >= 1);
  end if;
end;
$$;

update crm.call_insights ci
set transcript = longer.transcript
from (
  select distinct on (c.id) c.id, imp.transcript
  from crm.call_insights c
  join crm.conversation_imports imp
    on imp.activity_id = c.activity_id and imp.workspace_id = c.workspace_id
  where imp.transcript is not null
    and char_length(imp.transcript) > char_length(c.transcript)
    and starts_with(imp.transcript, c.transcript)
  order by c.id, char_length(imp.transcript) desc
) longer
where ci.id = longer.id;
