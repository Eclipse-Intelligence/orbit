const LEAVES: Record<string, string> = {
  archive: "('inbox', 'other')",
  snooze: "('inbox', 'other')",
  trash: "('inbox', 'other', 'sent', 'archive', 'drafts', 'junk')",
  inbox: "('archive', 'trash', 'snoozed', 'junk')",
};

function leavesCase(action: string, folder: string) {
  const cases = Object.entries(LEAVES)
    .map(([name, roles]) => `when '${name}' then ${folder}.role in ${roles}`)
    .join(" ");
  return `case ${action} ${cases} else false end`;
}

export function latestPendingActions(user: string) {
  return `select distinct on (pa.source_id, pa.thread_key) pa.source_id, pa.thread_key, pa.action
    from crm.mail_pending_actions pa
    where pa.user_id = ${user} and pa.refused_at is null
    order by pa.source_id, pa.thread_key, pa.created_at desc, pa.id desc`;
}

export function leavesFolder(latest: string, folder: string) {
  return leavesCase(`${latest}.action`, folder);
}

export function hiddenByPending(message: string, folder: string) {
  return `not exists (
    select 1 from crm.mail_pending_actions pa
    where pa.user_id = ${message}.user_id and pa.source_id = ${message}.source_id and pa.thread_key = ${message}.thread_key
      and pa.refused_at is null
      and not exists (
        select 1 from crm.mail_pending_actions nx
        where nx.user_id = pa.user_id and nx.source_id = pa.source_id and nx.thread_key = pa.thread_key
          and nx.refused_at is null and (nx.created_at, nx.id) > (pa.created_at, pa.id)
      )
      and ${leavesCase("pa.action", folder)}
  )`;
}
