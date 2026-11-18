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

function keysOf(row: PersonKeys) {
  const keys = [`p:${row.id}`];
  if (row.contact_id) keys.push(`c:${row.contact_id}`);
  for (const email of [row.email, row.normalized_email]) if (email) keys.push(`e:${email}`);
  for (const linkedin of [row.linkedin, row.normalized_linkedin]) if (linkedin) keys.push(`l:${linkedin}`);
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
    groups.set(root, [...(groups.get(root) ?? []), row]);
  }
  return [...groups.values()];
}

export async function workspacePeople(db: Db, workspaceId: string) {
  return groupPeople((await db.query<PersonKeys>(KEYS_SQL, [workspaceId])).rows);
}

export async function personProspectIds(db: Db, workspaceId: string, prospectId: string) {
  if (!isUuid(prospectId)) throw notFound("prospect");
  const person = (await workspacePeople(db, workspaceId)).find((group) => group.some((row) => row.id === prospectId));
  if (!person) throw notFound("prospect");
  return person.map((row) => row.id);
}
