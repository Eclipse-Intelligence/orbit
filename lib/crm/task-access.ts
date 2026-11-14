const SESSION_USER_SQL = "(nullif(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')::uuid";

export function directTaskSql(alias = "t") {
  return `(
    ${SESSION_USER_SQL} is null
    or ${alias}.owner_id = ${SESSION_USER_SQL}
    or ${alias}.created_by_user_id = ${SESSION_USER_SQL}
  )`;
}
