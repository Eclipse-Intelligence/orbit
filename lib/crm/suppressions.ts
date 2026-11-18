import { CrmError } from "@/lib/crm/errors";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { Db } from "@/lib/db/pool";

export type SuppressionReason = "unsubscribed" | "bounced" | "manual";

export type SuppressionPolicy = "refuse" | "warn" | { refuseSince: Date | string | null; workspaceId: string };

export type SuppressedAddress = { address: string; reason: SuppressionReason; name: string | null };

export type Recipient = { address: string; name?: string | null };

export const SUPPRESSED_SQL = `with wanted as (
    select distinct a as address from unnest($2::text[]) a where a <> ''
  ),
  people as materialized (
    select w.address, c.id, c.normalized_linkedin, c.created_at,
      nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '') as name
    from wanted w
    join crm.contacts c on c.normalized_email = w.address and c.workspace_id = $1 and c.archived_at is null
  )
  select w.address, hit.reason, (
    select p.name from people p where p.address = w.address order by p.created_at limit 1
  ) as name
  from wanted w
  cross join lateral (
    select s.reason from crm.suppressions s
    where s.workspace_id = $1 and s.kind = 'email' and s.value = w.address
      and ($3::timestamptz is null or s.created_at > $3::timestamptz)
    union all
    select s.reason from people p
    join crm.suppressions s on s.workspace_id = $1 and s.contact_id = p.id
    where p.address = w.address and s.reason <> 'bounced'
      and ($3::timestamptz is null or s.created_at > $3::timestamptz)
    union all
    select s.reason from people p
    join crm.suppressions s on s.workspace_id = $1 and s.kind = 'linkedin' and s.value = p.normalized_linkedin
    where p.address = w.address and s.reason <> 'bounced'
      and ($3::timestamptz is null or s.created_at > $3::timestamptz)
    limit 1
  ) hit`;

export async function suppressedAddresses(db: Db, workspaceId: string, addresses: string[], since: Date | string | null = null): Promise<SuppressedAddress[]> {
  const wanted = [...new Set(addresses.map((address) => canonicalEmail(address)).filter((address): address is string => Boolean(address)))];
  if (wanted.length === 0) return [];
  const result = await db.query<SuppressedAddress>(SUPPRESSED_SQL, [workspaceId, wanted, since ? new Date(since).toISOString() : null]);
  return result.rows;
}

export function suppressedNames(recipients: Recipient[], suppressed: SuppressedAddress[]) {
  const hit = new Map(suppressed.map((row) => [row.address, row]));
  const names: string[] = [];
  for (const recipient of recipients) {
    const address = canonicalEmail(recipient.address);
    const row = address ? hit.get(address) : undefined;
    if (!address || !row) continue;
    hit.delete(address);
    names.push(recipient.name?.trim() || row.name || address);
  }
  return names;
}

export function suppressedLine(names: string[]) {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is on the do not contact list.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are on the do not contact list.`;
  return `${names.length} recipients are on the do not contact list.`;
}

export function suppressedRefusal(names: string[]) {
  return new CrmError("suppressed", `Couldn't send. ${suppressedLine(names)}`, 409, { suppressed: true });
}

export function sentToSuppressed(names: string[]) {
  return `Sent. ${suppressedLine(names)}`;
}

export function isSuppressedRefusal(error: unknown): error is CrmError {
  return error instanceof CrmError && error.details?.suppressed === true;
}

export async function checkSuppressed(db: Db, workspaceId: string, recipients: Recipient[], policy: SuppressionPolicy) {
  const since = typeof policy === "object" ? policy.refuseSince : null;
  const workspace = typeof policy === "object" ? policy.workspaceId : workspaceId;
  const names = suppressedNames(recipients, await suppressedAddresses(db, workspace, recipients.map((item) => item.address), since));
  if (names.length > 0 && policy !== "warn") throw suppressedRefusal(names);
  return names;
}
