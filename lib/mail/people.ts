import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import type { MailAddress } from "@/lib/mail/types";

export async function suggestRecipients(actor: UserActor, text: string): Promise<MailAddress[]> {
  const term = text.trim().toLowerCase().slice(0, 100);
  if (!term) return [];
  const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
  return withActor(actor, async (db) => {
    const result = await db.query<{ name: string | null; address: string }>(
      `with found as (
         select coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), null) as name, c.normalized_email as address, 0 as rank,
           c.updated_at as seen
         from crm.contacts c
         where c.workspace_id = $1 and c.archived_at is null and c.normalized_email is not null
           and (c.normalized_email ilike $2 or concat_ws(' ', c.first_name, c.last_name) ilike $2)
         union all
         select max(m.from_name), m.from_email, 1, max(coalesce(m.received_at, m.created_at))
         from crm.mail_messages m
         where m.user_id = $3 and m.from_email is not null and (m.from_email ilike $2 or m.from_name ilike $2)
         group by m.from_email
       )
       select distinct on (address) name, address from found
       order by address, rank, seen desc nulls last`,
      [actor.workspaceId, like, actor.userId],
    );
    const starts = (item: { name: string | null; address: string }) =>
      item.address.startsWith(term) || (item.name ?? "").toLowerCase().startsWith(term) ? 0 : 1;
    return result.rows
      .sort((a, b) => starts(a) - starts(b) || (a.name ?? a.address).localeCompare(b.name ?? b.address))
      .slice(0, 8)
      .map((row) => ({ name: row.name, address: row.address }));
  });
}
