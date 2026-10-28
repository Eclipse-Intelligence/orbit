create or replace function private.claim_stale_email_attachments(p_limit integer)
returns table (id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  delete from crm.email_attachments a
  where a.id in (
    select s.id from crm.email_attachments s
    where s.created_at < now() - interval '1 day'
      and not exists (select 1 from crm.mail_drafts d where d.user_id = s.user_id and s.id = any (d.attachments))
    order by s.created_at
    limit greatest(1, least(p_limit, 200))
  )
  returning a.id;
end;
$$;

revoke all on function private.claim_stale_email_attachments(integer) from public;
grant execute on function private.claim_stale_email_attachments(integer) to crm_app;
