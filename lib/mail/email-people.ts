import { internalAddresses, ownCallAddresses } from "@/lib/crm/conversations";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";

export type EmailPerson = { id: string; companyId: string | null; email: string };

type Addressed = { from_email: string | null; to_recipients: unknown; cc_recipients: unknown };

function addressesIn(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const address = item && typeof item === "object" ? (item as { address?: unknown }).address : null;
    return typeof address === "string" ? [address] : [];
  });
}

export async function emailPeopleInDb(db: Db, actor: UserActor, messageId: string, direction: "inbound" | "outbound") {
  const found = await db.query<Addressed>(
    "select from_email, to_recipients, cc_recipients from crm.mail_messages where id = $1 and user_id = $2",
    [messageId, actor.userId],
  );
  const message = found.rows[0];
  if (!message) return [];
  const listed = [
    ...(direction === "inbound" && message.from_email ? [message.from_email] : []),
    ...addressesIn(message.to_recipients),
    ...addressesIn(message.cc_recipients),
  ];
  return externalContactIdsInDb(db, actor, listed);
}

export async function externalContactIdsInDb(db: Db, actor: UserActor, addresses: string[]) {
  const own = await ownCallAddresses(db, actor);
  const internal = await internalAddresses(db, actor.workspaceId, [...own], actor.userId);
  const wanted: string[] = [];
  for (const value of addresses) {
    const email = canonicalEmail(value);
    if (email && !own.has(email) && !internal.isInternal(email) && !wanted.includes(email)) wanted.push(email);
  }
  if (wanted.length === 0) return [];
  const contacts = await db.query<EmailPerson>(
    `select id, company_id as "companyId", normalized_email as email from crm.contacts
     where workspace_id = $1 and archived_at is null and normalized_email = any($2::text[])
     order by array_position($2::text[], normalized_email), created_at
     limit 100`,
    [actor.workspaceId, wanted],
  );
  return contacts.rows;
}
