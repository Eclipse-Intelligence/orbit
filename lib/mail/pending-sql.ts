const LEAVES: Record<string, string> = {
  archive: "('inbox', 'other')",
  snooze: "('inbox', 'other')",
  trash: "('inbox', 'other', 'sent', 'archive', 'drafts', 'junk')",
  inbox: "('archive', 'trash', 'snoozed', 'junk')",
};

export function hiddenByPending(message: string, folder: string) {
  const cases = Object.entries(LEAVES)
    .map(([action, roles]) => `when '${action}' then ${folder}.role in ${roles}`)
    .join(" ");
  return `not exists (
    select 1 from crm.mail_pending_actions pa
    where pa.user_id = ${message}.user_id and pa.source_id = ${message}.source_id and pa.thread_key = ${message}.thread_key
      and pa.refused_at is null
      and not exists (
        select 1 from crm.mail_pending_actions nx
        where nx.user_id = pa.user_id and nx.source_id = pa.source_id and nx.thread_key = pa.thread_key
          and nx.refused_at is null and (nx.created_at, nx.id) > (pa.created_at, pa.id)
      )
      and case pa.action ${cases} else false end
  )`;
}
