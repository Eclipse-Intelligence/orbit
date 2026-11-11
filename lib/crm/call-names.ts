import type { Db } from "@/lib/db/pool";
import type { PartyMatch } from "@/lib/crm/inbox";
import { canonicalEmail } from "@/lib/crm/normalize";

const NAME_NOISE = /[\s'’‘`´.,-]+/g;
const NAME_NOISE_SQL = "[[:space:]'’‘`´.,-]+";
const TITLE_JOINER = /\s+(?:and|x|\+|&)\s+/i;
const NAME_WORD = /^\p{L}[\p{L}'’.-]*$/u;
const MAX_CANDIDATES = 100;

export type NameCandidate = PartyMatch & {
  contactId: string;
  contactName: string;
  workspaceId: string;
  email: string | null;
  key: string;
};

export type ContactSuggestion = { contactId: string; name: string; companyName: string | null };

function squash(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

export function looseNameKey(value: string | null | undefined) {
  const name = squash(value);
  if (!name || canonicalEmail(name)) return null;
  return name.toLowerCase().replace(NAME_NOISE, "") || null;
}

export function nameKey(value: string | null | undefined) {
  const name = squash(value);
  if (!name || name.length > 160 || name.split(" ").length < 2) return null;
  const key = looseNameKey(name);
  return key && key.length >= 4 ? key : null;
}

export function titleNames(title: string | null | undefined) {
  const text = squash(title);
  if (!text || text.length > 200) return [];
  const parts = text.split(TITLE_JOINER).map(squash);
  if (parts.length < 2) return [];
  const words = parts.map((part) => part.split(" "));
  if (!words.every((list) => list.length <= 4 && list.every((word) => NAME_WORD.test(word)))) return [];
  return parts.filter((part, index) => words[index].length >= 2);
}

export async function excludedNameKeys(db: Db, workspaceIds: string[], extra: (string | null | undefined)[] = []) {
  const result = workspaceIds.length
    ? await db.query<{ full_name: string }>(
        `select distinct p.full_name from crm.workspace_members m join crm.profiles p on p.id = m.user_id
         where m.workspace_id = any($1::uuid[]) and p.full_name is not null`,
        [workspaceIds],
      )
    : { rows: [] };
  const keys = new Set<string>();
  for (const value of [...result.rows.map((row) => row.full_name), ...extra]) {
    const key = looseNameKey(value);
    if (key) keys.add(key);
  }
  return keys;
}

export function usableNameKeys(names: (string | null | undefined)[], excluded: Set<string>) {
  const keys: string[] = [];
  for (const name of names) {
    const key = nameKey(name);
    if (key && !excluded.has(key) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export async function contactsByName(db: Db, workspaceIds: string[], keys: string[]): Promise<NameCandidate[]> {
  if (workspaceIds.length === 0 || keys.length === 0) return [];
  const result = await db.query<{
    id: string;
    workspace_id: string;
    company_id: string | null;
    company_name: string | null;
    normalized_email: string | null;
    name: string;
    key: string;
  }>(
    `select c.id, c.workspace_id, c.company_id, co.name as company_name, c.normalized_email,
            coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email) as name,
            regexp_replace(lower(concat_ws(' ', c.first_name, c.last_name)), $3, '', 'g') as key
     from crm.contacts c
     left join crm.companies co on co.id = c.company_id
     where c.workspace_id = any($1::uuid[]) and c.archived_at is null
       and regexp_replace(lower(concat_ws(' ', c.first_name, c.last_name)), $3, '', 'g') = any($2::text[])
     order by c.updated_at desc
     limit ${MAX_CANDIDATES}`,
    [workspaceIds, keys, NAME_NOISE_SQL],
  );
  return result.rows.map((row) => ({
    contactId: row.id,
    contactName: row.name,
    companyId: row.company_id,
    companyName: row.company_name,
    workspaceId: row.workspace_id,
    email: row.normalized_email,
    key: row.key,
  }));
}

export function onePerson(candidates: NameCandidate[]) {
  if (candidates.length === 0) return false;
  const perWorkspace = new Set<string>();
  for (const candidate of candidates) {
    if (perWorkspace.has(candidate.workspaceId)) return false;
    perWorkspace.add(candidate.workspaceId);
  }
  if (perWorkspace.size === 1) return true;
  const emails = new Set(candidates.map((candidate) => candidate.email));
  return emails.size === 1 && !emails.has(null);
}

export function inKeyOrder(candidates: NameCandidate[], keys: string[]) {
  return keys.flatMap((key) => candidates.filter((candidate) => candidate.key === key));
}

export function asSuggestion(candidate: NameCandidate): ContactSuggestion {
  return { contactId: candidate.contactId, name: candidate.contactName, companyName: candidate.companyName };
}
