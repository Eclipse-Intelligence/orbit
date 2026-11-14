set lock_timeout = '5s';

do $$
begin
  if exists (
    select 1 from crm.tasks
    where mail_thread_key is null and description like '%](/mail?thread=%'
  ) then
    alter table crm.tasks disable trigger tasks_set_updated_at;
    update crm.tasks t
    set mail_thread_key = moved.thread_key, description = moved.description
    from (
      select s.id, m.thread_key, m.description
      from crm.tasks s
      cross join lateral private.task_mail_link_move(s.description) m
      where s.mail_thread_key is null and s.description like '%](/mail?thread=%'
    ) moved
    where t.id = moved.id;
    alter table crm.tasks enable trigger tasks_set_updated_at;
  end if;
end;
$$;

reset lock_timeout;
