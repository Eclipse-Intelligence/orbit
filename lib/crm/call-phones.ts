import { foldName, type ContactSuggestion } from "@/lib/crm/call-names";
import type { PartyMatch } from "@/lib/crm/inbox";
import type { Db } from "@/lib/db/pool";
import { normalizePhone } from "@/lib/phone";

const PHONE_LIKE = /(?:\+|\b0)\d[\d\s().-]{6,18}\d/g;
const MIN_DIGITS = 9;
const TAIL_DIGITS = 9;
const MAX_SUGGESTIONS = 3;

export type PhoneMatch = { workspaceId: string; match: PartyMatch | null; suggestions: ContactSuggestion[] };

type ContactRow = {
  id: string;
  workspace_id: string;
  first_name: string | null;
  name: string;
  normalized_email: string | null;
  company_id: string | null;
  company_name: string | null;
  phone: string | null;
};

type CompanyRow = { id: string; workspace_id: string; name: string; phone: string };

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

function asMatch(row: ContactRow): PartyMatch {
  return { contactId: row.id, contactName: row.name, companyId: row.company_id, companyName: row.company_name };
}

function asSuggestion(row: ContactRow): ContactSuggestion {
  return { contactId: row.id, name: row.name, companyName: row.company_name, email: row.normalized_email };
}

function namedIn(rows: ContactRow[], text: string, ownFirstName: string | null) {
  const words = new Set(foldName(text).split(" ").filter(Boolean));
  return rows.filter((row) => {
    const first = foldName(row.first_name);
    return Boolean(first) && !first.includes(" ") && first !== ownFirstName && words.has(first);
  });
}

function pick(rows: ContactRow[], text: string, ownFirstName: string | null) {
  if (rows.length === 1) return { match: asMatch(rows[0]), suggestions: [] };
  const named = namedIn(rows, text, ownFirstName);
  if (named.length === 1) return { match: asMatch(named[0]), suggestions: [] };
  return { match: null, suggestions: (named.length > 0 ? named : rows).slice(0, MAX_SUGGESTIONS).map(asSuggestion) };
}

export async function matchPhonesInDb(
  db: Db,
  workspaceIds: string[],
  input: { title: string | null | undefined; text: string | null | undefined; ownName?: string | null },
): Promise<PhoneMatch[]> {
  const numbers = phoneNumbersIn(input.title);
  if (numbers.length === 0 || workspaceIds.length === 0) return [];
  const tails = numbers.map(tail);
  const wanted = new Set(numbers);
  const text = [input.title, input.text].filter(Boolean).join("\n");
  const ownFirstName = foldName(input.ownName).split(" ")[0] || null;
  const contacts = await db.query<ContactRow>(
    `select c.id, c.workspace_id, c.first_name, c.normalized_email, c.company_id, co.name as company_name, c.phone,
            coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, c.phone) as name
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
  const direct = contacts.rows.filter((row) => wanted.has(normalizePhone(row.phone) ?? ""));
  const switchboards = companies.rows.filter((row) => wanted.has(normalizePhone(row.phone) ?? ""));
  const staff = switchboards.length === 0
    ? []
    : (
        await db.query<ContactRow>(
          `select c.id, c.workspace_id, c.first_name, c.normalized_email, c.company_id, co.name as company_name, c.phone,
                  coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, c.phone) as name
           from crm.contacts c
           join crm.companies co on co.id = c.company_id
           where c.company_id = any($1::uuid[]) and c.archived_at is null
           order by c.created_at, c.id`,
          [switchboards.map((row) => row.id)],
        )
      ).rows;
  const results: PhoneMatch[] = [];
  for (const workspaceId of workspaceIds) {
    const here = direct.filter((row) => row.workspace_id === workspaceId);
    if (here.length > 0) {
      results.push({ workspaceId, ...pick(here, text, ownFirstName) });
      continue;
    }
    const boards = switchboards.filter((row) => row.workspace_id === workspaceId);
    if (boards.length !== 1) continue;
    const company = boards[0];
    const people = staff.filter((row) => row.company_id === company.id);
    const named = namedIn(people, text, ownFirstName);
    if (named.length === 1) results.push({ workspaceId, match: asMatch(named[0]), suggestions: [] });
    else if (named.length > 1) results.push({ workspaceId, match: null, suggestions: named.slice(0, MAX_SUGGESTIONS).map(asSuggestion) });
    else results.push({ workspaceId, match: { contactId: null, contactName: null, companyId: company.id, companyName: company.name }, suggestions: [] });
  }
  return results;
}
