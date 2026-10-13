drop policy if exists email_messages_update_owner on crm.email_messages;
create policy email_messages_update_owner on crm.email_messages
  for update to authenticated
  using (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select auth.uid())
    )
  )
  with check (
    workspace_id in (select private.user_workspace_ids())
    and connection_id in (
      select id from crm.mailbox_connections where user_id = (select auth.uid())
    )
  );

grant update (contact_id, company_id, activity_id) on crm.email_messages to authenticated;
