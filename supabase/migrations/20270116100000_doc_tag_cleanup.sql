create or replace function private.private_tagged_pages(p_folder_ids uuid[])
returns table (page_id uuid, user_id uuid, workspace_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.user_id, p.workspace_id
  from crm.pages p
  where p.folder_id = any(p_folder_ids)
    and p.user_id is not null
    and not p.effective_shared
    and exists (select 1 from crm.page_links l where l.page_id = p.id and l.target_kind = 'member')
  order by p.user_id, p.id;
$$;

revoke all on function private.private_tagged_pages(uuid[]) from public;
grant execute on function private.private_tagged_pages(uuid[]) to crm_app;
