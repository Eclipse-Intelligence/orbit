set lock_timeout = '3s';

create or replace function private.docs_former_owners(p_workspace uuid, p_actor uuid)
returns table (user_id uuid, name text, docs integer, folders integer, examples text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(private.team_role(p_workspace, p_actor), '') not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can see a former member''s docs.' using errcode = '42501';
  end if;
  return query
  select
    o.uid,
    coalesce(nullif(pr.full_name, ''), pr.email, 'Former member'),
    (select count(*)::integer from crm.pages p where p.workspace_id = p_workspace and p.kind = 'note' and p.user_id = o.uid),
    (select count(*)::integer from crm.page_folders f where f.workspace_id = p_workspace and f.user_id = o.uid),
    (
      select coalesce(array_agg(x.label order by x.at desc), '{}'::text[])
      from (
        select p.title as label, p.edited_at as at
        from crm.pages p
        where p.workspace_id = p_workspace and p.kind = 'note' and p.user_id = o.uid and p.effective_shared and p.archived_at is null
        union all
        select f.name, f.updated_at
        from crm.page_folders f
        where f.workspace_id = p_workspace and f.user_id = o.uid and f.effective_shared and f.archived_at is null
        order by at desc
        limit 3
      ) x
    )
  from (
    select p.user_id as uid from crm.pages p where p.workspace_id = p_workspace and p.kind = 'note' and p.user_id is not null
    union
    select f.user_id from crm.page_folders f where f.workspace_id = p_workspace and f.user_id is not null
  ) o
  left join crm.profiles pr on pr.id = o.uid
  where private.team_role(p_workspace, o.uid) is null
  order by 2;
end;
$$;

revoke all on function private.docs_former_owners(uuid, uuid) from public;
grant execute on function private.docs_former_owners(uuid, uuid) to crm_app;
