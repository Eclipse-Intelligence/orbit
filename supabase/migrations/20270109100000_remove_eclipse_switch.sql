update crm.workspace_brands
set playbook = replace(
  playbook,
  'Find an article with eclipse_articles and read it in full.',
  'Find a published article in the Eclipse client named Eclipse with eclipse_tools and eclipse_read, and read it in full.'
)
where eclipse_tools
  and strpos(playbook, 'Find an article with eclipse_articles and read it in full.') > 0
  and char_length(playbook) + 80 <= 60000;

with eclipse as (
  select workspace_id, case when strpos(playbook, chr(13) || chr(10)) > 0 then chr(13) || chr(10) else chr(10) end as newline
  from crm.workspace_brands
  where eclipse_tools
),
addition as (
  select e.workspace_id,
    '## Eclipse checks' || e.newline ||
    '- Cntent is Eclipse''s former name. A client result tied to Cntent, such as "when Eclipse was still called Cntent", is client proof, so it must come from the proof list.' as text,
    e.newline
  from eclipse e
)
update crm.workspace_brands b
set playbook = case when btrim(b.playbook) = '' then a.text else rtrim(b.playbook, chr(13) || chr(10) || ' ') || a.newline || a.newline || a.text end
from addition a
where b.workspace_id = a.workspace_id
  and strpos(b.playbook, 'Cntent is Eclipse''s former name.') = 0
  and char_length(b.playbook) + char_length(a.text) + 4 <= 60000;

update crm.workspace_brands b
set tone = case when btrim(b.tone) = '' then 'Never call an article a "piece". Say "article".' else rtrim(b.tone) || ' Never call an article a "piece". Say "article".' end
where b.eclipse_tools
  and strpos(b.tone, 'Never call an article a "piece".') = 0
  and char_length(b.tone) + 48 <= 3000;

insert into crm.watchlist (workspace_id, kind, label)
select b.workspace_id, 'topic', topic.label
from crm.workspace_brands b
cross join (values ('AI visibility'), ('Generative engine optimisation (GEO)'), ('AI search'), ('Content operations'), ('Content agencies')) as topic (label)
where b.eclipse_tools
on conflict (workspace_id, kind, lower(label)) do nothing;
