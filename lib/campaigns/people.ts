import { notFound } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Db } from "@/lib/db/pool";

export type PersonKeys = {
  id: string;
  contact_id: string | null;
  email: string | null;
  linkedin: string | null;
  normalized_email: string | null;
  normalized_linkedin: string | null;
};

const KEYS_SQL = `select p.id, p.contact_id, p.email, p.linkedin, c.normalized_email, c.normalized_linkedin
  from crm.campaign_prospects p
  left join crm.contacts c on c.id = p.contact_id
  where p.workspace_id = $1`;

const ROLE_MAILBOXES = new Set([
  "info", "hello", "hi", "mail", "sales", "contact", "office", "admin", "team", "enquiries", "enquiry", "support",
  "marketing", "accounts", "billing", "careers", "jobs", "press",
]);

export function roleMailbox(email: string) {
  return ROLE_MAILBOXES.has(email.split("@")[0]?.trim().toLowerCase() ?? "");
}

export function usableEmails(emails: string[], other: { linkedins: number; contacts: number }, options: { keepWhenAlone: boolean }) {
  const personal = emails.filter((email) => !roleMailbox(email));
  const excluded = personal.length > 0 || other.linkedins > 0 || other.contacts > 0;
  if (!excluded) return emails;
  if (options.keepWhenAlone && personal.length === 0 && other.linkedins === 0) return emails;
  return personal;
}

function keysOf(row: PersonKeys) {
  const keys = [`p:${row.id}`];
  if (row.contact_id) keys.push(`c:${row.contact_id}`);
  const linkedins = present([row.linkedin, row.normalized_linkedin]);
  for (const email of usableEmails(present([row.email, row.normalized_email]), { linkedins: linkedins.length, contacts: row.contact_id ? 1 : 0 }, { keepWhenAlone: false })) keys.push(`e:${email}`);
  for (const linkedin of linkedins) keys.push(`l:${linkedin}`);
  return keys;
}

export function groupPeople<T extends PersonKeys>(rows: T[]): T[][] {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let node = key;
    while (node !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const row of rows) {
    const keys = keysOf(row);
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (const key of keys.slice(1)) {
      const a = find(keys[0]);
      const b = find(key);
      if (a !== b) parent.set(b, a);
    }
  }
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const root = find(`p:${row.id}`);
    const group = groups.get(root);
    if (group) group.push(row);
    else groups.set(root, [row]);
  }
  return [...groups.values()];
}

export async function workspacePeople(db: Db, workspaceId: string) {
  return groupPeople((await db.query<PersonKeys>(KEYS_SQL, [workspaceId])).rows);
}

export async function personKeys(db: Db, workspaceId: string, prospectId: string) {
  if (!isUuid(prospectId)) throw notFound("prospect");
  const person = (await workspacePeople(db, workspaceId)).find((group) => group.some((row) => row.id === prospectId));
  if (!person) throw notFound("prospect");
  return person;
}

export async function personProspectIds(db: Db, workspaceId: string, prospectId: string) {
  return (await personKeys(db, workspaceId, prospectId)).map((row) => row.id);
}

export function present(values: (string | null | undefined)[]) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function doNotContactKeys(group: PersonKeys[]) {
  const contactIds = present(group.map((row) => row.contact_id));
  const linkedins = present(group.flatMap((row) => [row.linkedin, row.normalized_linkedin]));
  const emails = usableEmails(present(group.flatMap((row) => [row.email, row.normalized_email])), { linkedins: linkedins.length, contacts: contactIds.length }, { keepWhenAlone: true });
  return { contactIds, emails, linkedins };
}

export function doNotContactStatusKeys(group: PersonKeys[]) {
  const keys = doNotContactKeys(group);
  return {
    contactIds: keys.contactIds,
    emails: present([...keys.emails, ...group.map((row) => row.email)]),
    linkedins: present([...keys.linkedins, ...group.map((row) => row.linkedin)]),
  };
}

export type Suppressed = { contactIds: Set<string>; emails: Set<string>; linkedins: Set<string> };

export function suppressedPerson(group: PersonKeys[], suppressed: Suppressed) {
  const keys = doNotContactStatusKeys(group);
  return keys.contactIds.some((id) => suppressed.contactIds.has(id)) || keys.emails.some((email) => suppressed.emails.has(email)) || keys.linkedins.some((linkedin) => suppressed.linkedins.has(linkedin));
}
