import { foldName, type ContactSuggestion } from "@/lib/crm/call-names";
import type { PartyMatch } from "@/lib/crm/inbox";
import type { Db } from "@/lib/db/pool";
import { normalizePhone } from "@/lib/phone";

const PHONE_LIKE = /(?:\+|\b0)\d[\d\s()-]{6,18}\d/g;
const MIN_DIGITS = 9;
const TAIL_DIGITS = 9;
const MAX_SUGGESTIONS = 3;
const WORD = /\p{L}[\p{L}'’-]*/gu;
const COMMON_WORD_NAMES = new Set([
  "will", "may", "june", "april", "august", "mark", "grant", "rob", "bill", "sue", "pat", "rich", "frank", "hope",
  "joy", "faith", "grace", "art", "dawn", "rose", "summer", "chase", "drew", "jack", "ray", "glen", "dean", "chip",
  "sunny", "max", "guy", "gene", "lee", "reed", "chuck", "carol", "rocky", "crystal", "ruby", "amber", "holly",
]);

export type PhoneLookup = { title: string | null | undefined; text: string | null | undefined };
export type PhoneMatch = { workspaceId: string; match: PartyMatch | null; suggestions: ContactSuggestion[] };

type ContactRow = {
  id: string;
  workspace_id: string;
  first_name: string | null;
  last_name: string | null;
  name: string;
  normalized_email: string | null;
  company_id: string | null;
  company_name: string | null;
  phone: string | null;
};

type CompanyRow = { id: string; workspace_id: string; name: string; phone: string };

const CONTACT_COLUMNS = `c.id, c.workspace_id, c.first_name, c.last_name, c.normalized_email, c.company_id, co.name as company_name, c.phone,
  coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, c.phone) as name`;

export function phoneNumbersIn(text: string | null | undefined) {
  if (!text) return [];
  const found = new Set<string>();
  for (const raw of text.match(PHONE_LIKE) ?? []) {
    if (raw.replace(/\D/g, "").length < MIN_DIGITS) continue;
    const number = normalizePhone(raw);
    if (number) found.add(number);
  }
  return [...found];
}

function tail(number: string) {
  return number.replace(/\D/g, "").slice(-TAIL_DIGITS);
}

function capitalisedWords(text: string) {
  const words = new Set<string>();
  for (const word of text.match(WORD) ?? []) {
    if (word[0] !== word[0].toLowerCase()) words.add(foldName(word));
  }
  return words;
}

function hasPhrase(folded: string, phrase: string) {
  return ` ${folded} `.includes(` ${phrase} `);
}

export function namedIn<T extends { first_name: string | null; last_name: string | null }>(rows: T[], text: string, excluded: Set<string>) {
  const capitalised = capitalisedWords(text);
  const folded = foldName(text);
  return rows.filter((row) => {
    const first = foldName(row.first_name);
    if (!first || first.includes(" ") || excluded.has(first) || !capitalised.has(first)) return false;
    if (!COMMON_WORD_NAMES.has(first)) return true;
    const full = foldName(`${row.first_name ?? ""} ${row.last_name ?? ""}`);
    return full !== first && hasPhrase(folded, full);
  });
}

function asMatch(row: ContactRow): PartyMatch {
  return { contactId: row.id, contactName: row.name, companyId: row.company_id, companyName: row.company_name };
}

function asSuggestion(row: ContactRow): ContactSuggestion {
  return { contactId: row.id, name: row.name, companyName: row.company_name, email: row.normalized_email };
}

function chosen(row: ContactRow) {
  return { match: asMatch(row), suggestions: [asSuggestion(row)] };
}

function offered(rows: ContactRow[]) {
  return { match: null, suggestions: rows.slice(0, MAX_SUGGESTIONS).map(asSuggestion) };
}

function decide(direct: ContactRow[], boards: CompanyRow[], staff: ContactRow[], text: string, excluded: Set<string>) {
  const pool = [...direct, ...staff.filter((row) => !direct.some((other) => other.id === row.id))];
  const named = namedIn(pool, text, excluded);
  if (named.length === 1) return chosen(named[0]);
  if (named.length > 1) return offered(named);
  if (direct.length === 1) return chosen(direct[0]);
  if (direct.length > 1) return offered(direct);
  if (boards.length === 1) {
    return { match: { contactId: null, contactName: null, companyId: boards[0].id, companyName: boards[0].name }, suggestions: [] };
  }
  return null;
}

export async function firstNamesToIgnore(db: Db, userId: string, extra: (string | null | undefined)[] = []) {
  const result = await db.query<{ full_name: string }>(
    `select distinct p.full_name from crm.workspace_members m join crm.profiles p on p.id = m.user_id
     where m.workspace_id in (select own.workspace_id from crm.workspace_members own where own.user_id = $1)
       and p.full_name is not null`,
    [userId],
  );
  const names = new Set<string>();
  for (const value of [...result.rows.map((row) => row.full_name), ...extra]) {
    const first = foldName(value).split(" ")[0];
    if (first) names.add(first);
  }
  return names;
}

export async function matchPhonesInDb(
  db: Db,
  workspaceIds: string[],
  lookups: PhoneLookup[],
  excluded: Set<string>,
): Promise<PhoneMatch[][]> {
  const numbers = lookups.map((lookup) => phoneNumbersIn(lookup.title));
  const tails = [...new Set(numbers.flat().map(tail))];
  if (tails.length === 0 || workspaceIds.length === 0) return lookups.map(() => []);
  const contacts = await db.query<ContactRow>(
    `select ${CONTACT_COLUMNS}
     from crm.contacts c
     left join crm.companies co on co.id = c.company_id
     where c.workspace_id = any($1::uuid[]) and c.archived_at is null and c.phone is not null
       and right(regexp_replace(c.phone, '\\D', '', 'g'), ${TAIL_DIGITS}) = any($2::text[])
     order by c.created_at, c.id`,
    [workspaceIds, tails],
  );
  const companies = await db.query<CompanyRow>(
    `select id, workspace_id, name, phone from crm.companies
     where workspace_id = any($1::uuid[]) and archived_at is null and phone is not null
       and right(regexp_replace(phone, '\\D', '', 'g'), ${TAIL_DIGITS}) = any($2::text[])
     order by created_at, id`,
    [workspaceIds, tails],
  );
  const staff = companies.rows.length === 0
    ? []
    : (
        await db.query<ContactRow>(
          `select ${CONTACT_COLUMNS}
           from crm.contacts c
           join crm.companies co on co.id = c.company_id
           where c.company_id = any($1::uuid[]) and c.archived_at is null
           order by c.created_at, c.id`,
          [companies.rows.map((row) => row.id)],
        )
      ).rows;
  return lookups.map((lookup, index) => {
    const wanted = new Set(numbers[index]);
    if (wanted.size === 0) return [];
    const text = [lookup.title, lookup.text].filter(Boolean).join("\n");
    const results: PhoneMatch[] = [];
    for (const workspaceId of workspaceIds) {
      const direct = contacts.rows.filter((row) => row.workspace_id === workspaceId && wanted.has(normalizePhone(row.phone) ?? ""));
      const boards = companies.rows.filter((row) => row.workspace_id === workspaceId && wanted.has(normalizePhone(row.phone) ?? ""));
      const people = staff.filter((row) => boards.some((board) => board.id === row.company_id));
      const decision = decide(direct, boards, people, text, excluded);
      if (decision) results.push({ workspaceId, ...decision });
    }
    return results;
  });
}
