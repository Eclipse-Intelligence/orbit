create or replace function private.company_has_open_task(p_workspace_id uuid, p_company_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_user not in ('crm_app', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return exists (
    select 1
    from crm.tasks t
    where t.workspace_id = p_workspace_id
      and t.company_id = p_company_id
      and t.archived_at is null
      and t.completed_at is null
  );
end;
$$;

revoke all on function private.company_has_open_task(uuid, uuid) from public;
grant execute on function private.company_has_open_task(uuid, uuid) to crm_app;
