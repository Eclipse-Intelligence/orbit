import type { Db } from "@/lib/db/pool";
import type { PartyMatch } from "@/lib/crm/inbox";
import { canonicalEmail } from "@/lib/crm/normalize";

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const SKELETON_DROP_SQL = `[^${UPPER}${LOWER}0123456789]`;
const TITLE_JOINER = /\s+(?:and|x|\+|&)\s+/i;
const NAME_WORD = /^\p{L}[\p{L}'’.-]*$/u;
const MAX_CANDIDATES = 500;

export type ContactSuggestion = { contactId: string; name: string; companyName: string | null; email: string | null };

export type NameCandidate = PartyMatch & {
  contactId: string;
  contactName: string;
  workspaceId: string;
  email: string | null;
  key: string;
  words: string;
};

export type NameQuery = { key: string; words: string; skeleton: string; latin: boolean };

export type NameLookup = { candidates: NameCandidate[]; complete: boolean };

function squash(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

export function foldName(value: string | null | undefined) {
  return squash(value)
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/['’‘`´.]+/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

export function looseNameKey(value: string | null | undefined) {
  const name = squash(value);
  if (!name || canonicalEmail(name)) return null;
  return foldName(name).replace(/ /g, "") || null;
}

export function nameKey(value: string | null | undefined) {
  const name = squash(value);
  if (!name || name.length > 160 || name.split(" ").length < 2) return null;
  const key = looseNameKey(name);
  return key && key.length >= 4 ? key : null;
}

function skeleton(value: string) {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export function latinName(value: string | null | undefined) {
  return [...squash(value).normalize("NFC")].every((char) => !/\p{L}/u.test(char) || /\p{Script=Latin}/u.test(char));
}

export function nameQueries(names: (string | null | undefined)[], excluded: Set<string>) {
  const queries: NameQuery[] = [];
  for (const name of names) {
    const key = nameKey(name);
    if (!key || excluded.has(key) || queries.some((query) => query.key === key)) continue;
    queries.push({ key, words: foldName(name), skeleton: skeleton(squash(name)), latin: latinName(name) });
  }
  return queries;
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

export async function excludedNameKeys(db: Db, userId: string, extra: (string | null | undefined)[] = []) {
  const result = await db.query<{ full_name: string }>(
    `select distinct p.full_name from crm.workspace_members m join crm.profiles p on p.id = m.user_id
     where m.workspace_id in (select own.workspace_id from crm.workspace_members own where own.user_id = $1)
       and p.full_name is not null`,
    [userId],
  );
  const keys = new Set<string>();
  for (const value of [...result.rows.map((row) => row.full_name), ...extra]) {
    const key = looseNameKey(value);
    if (key) keys.add(key);
  }
  return keys;
}

export async function contactsByName(db: Db, workspaceIds: string[], queries: NameQuery[]): Promise<NameLookup> {
  const skeletons = [...new Set(queries.map((query) => query.skeleton).filter(Boolean))];
  const bare = queries.some((query) => !query.skeleton);
  if (workspaceIds.length === 0 || (skeletons.length === 0 && !bare)) return { candidates: [], complete: true };
  const result = await db.query<{
    id: string;
    workspace_id: string;
    company_id: string | null;
    company_name: string | null;
    normalized_email: string | null;
    full_name: string;
    name: string;
  }>(
    `select c.id, c.workspace_id, c.company_id, co.name as company_name, c.normalized_email,
            concat_ws(' ', c.first_name, c.last_name) as full_name,
            coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email) as name
     from crm.contacts c
     left join crm.companies co on co.id = c.company_id
     cross join lateral (
       select translate(regexp_replace(normalize(concat_ws(' ', c.first_name, c.last_name), NFKD), $4, '', 'g'), $5, $6) as skeleton
     ) k
     where c.workspace_id = any($1::uuid[]) and c.archived_at is null
       and nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '') is not null
       and (k.skeleton = any($2::text[]) or ($3::boolean and k.skeleton = ''))
     order by (k.skeleton = any($2::text[])) desc, c.updated_at desc
     limit ${MAX_CANDIDATES}`,
    [workspaceIds, skeletons, bare, SKELETON_DROP_SQL, UPPER, LOWER],
  );
  const keys = new Set(queries.map((query) => query.key));
  const candidates: NameCandidate[] = [];
  for (const row of result.rows) {
    const key = looseNameKey(row.full_name);
    if (!key || !keys.has(key)) continue;
    candidates.push({
      contactId: row.id,
      contactName: row.name,
      companyId: row.company_id,
      companyName: row.company_name,
      workspaceId: row.workspace_id,
      email: row.normalized_email,
      key,
      words: foldName(row.full_name),
    });
  }
  return { candidates, complete: result.rows.length < MAX_CANDIDATES };
}

function onePerson(candidates: NameCandidate[]) {
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

export function confidentFor(query: NameQuery, lookup: NameLookup) {
  if (!lookup.complete || !query.latin || query.words.split(" ").length < 2) return false;
  const exact = lookup.candidates.filter((candidate) => candidate.key === query.key && candidate.words === query.words);
  return onePerson(exact);
}

export function exactFor(query: NameQuery, candidates: NameCandidate[]) {
  return candidates.filter((candidate) => candidate.key === query.key && candidate.words === query.words);
}

export function inQueryOrder(candidates: NameCandidate[], queries: NameQuery[]) {
  return queries.flatMap((query) => candidates.filter((candidate) => candidate.key === query.key));
}

export function asSuggestion(candidate: NameCandidate): ContactSuggestion {
  return { contactId: candidate.contactId, name: candidate.contactName, companyName: candidate.companyName, email: candidate.email };
}
