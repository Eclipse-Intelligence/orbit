alter table crm.workspace_brands add column if not exists former_names text[] not null default '{}';

alter table crm.workspace_brands drop constraint if exists workspace_brands_former_names_count;
alter table crm.workspace_brands add constraint workspace_brands_former_names_count check (cardinality(former_names) <= 10);

grant insert (former_names) on crm.workspace_brands to authenticated;
grant update (former_names) on crm.workspace_brands to authenticated;

update crm.workspace_brands
set former_names = array_append(former_names, 'Cntent')
where eclipse_tools
  and not exists (select 1 from unnest(former_names) as name where lower(name) = 'cntent')
  and cardinality(former_names) < 10;

update crm.workspace_brands
set playbook = replace(
    playbook,
    'Find an article with eclipse_articles and read it in full.',
    'Find a published article in the Eclipse client named Eclipse with eclipse_tools and eclipse_read, and read it in full.'
  ),
  playbook_updated_at = now()
where eclipse_tools
  and strpos(playbook, 'Find an article with eclipse_articles and read it in full.') > 0
  and char_length(playbook) + 80 <= 60000;

update crm.workspace_brands
set tone = case
  when btrim(tone, ' ' || chr(13) || chr(10)) = '' then 'Never call an article a "piece". Say "article".'
  else rtrim(tone, ' ' || chr(13) || chr(10)) || ' Never call an article a "piece". Say "article".'
end
where eclipse_tools
  and strpos(tone, 'Never call an article a "piece".') = 0
  and char_length(rtrim(tone, ' ' || chr(13) || chr(10))) + 48 <= 3000;

insert into crm.watchlist (workspace_id, kind, label)
select b.workspace_id, 'topic', topic.label
from crm.workspace_brands b
cross join (values ('AI visibility'), ('Generative engine optimisation (GEO)'), ('AI search'), ('Content operations'), ('Content agencies')) as topic (label)
where b.eclipse_tools
on conflict (workspace_id, kind, lower(label)) do nothing;
