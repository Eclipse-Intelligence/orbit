const SESSION_USER_SQL = "(nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid";

export function directTaskSql(alias = "t") {
  return `(
    ${SESSION_USER_SQL} is null
    or ${alias}.owner_id = ${SESSION_USER_SQL}
    or ${alias}.created_by_user_id = ${SESSION_USER_SQL}
    or exists (
      select 1 from crm.workspace_members direct_member
      where direct_member.workspace_id = ${alias}.workspace_id
        and direct_member.user_id = ${SESSION_USER_SQL}
        and direct_member.role in ('owner', 'admin')
    )
  )`;
}
