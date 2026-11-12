import type { Db } from "@/lib/db/pool";

export type LinkedRecord = { id: string; name: string };

export type DetectedTaskLinks = {
  company: LinkedRecord | null;
  contact: (LinkedRecord & { company: LinkedRecord | null }) | null;
  opportunity: (LinkedRecord & { companyId: string }) | null;
};

export type DetectedLinkIds = { companyId?: string; contactId?: string; opportunityId?: string };

export const MIN_NAME = 3;
export const TEXT_LIMIT = 500;
const SCAN_LIMIT = 50;

export const NO_DETECTION: DetectedTaskLinks = { company: null, contact: null, opportunity: null };

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionsName(text: string, name: string, options: { exact?: boolean } = {}) {
  return new RegExp(`(^|[^\\p{L}\\p{N}-])${escape(name)}($|[^\\p{L}\\p{N}-])`, options.exact ? "u" : "iu").test(text);
}

export function folded(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");
}

type Named = { name: string };

function mentioned<T extends Named>(rows: T[], text: string, skip: Set<string>) {
  return rows.filter((row) => {
    const name = row.name.trim();
    return name.length >= MIN_NAME && !skip.has(folded(name)) && mentionsName(text, name, { exact: true });
  });
}

function unique<T extends Named>(rows: T[], hits: T[], longest: Named[]) {
  const kept = hits.filter((row) => !longest.some((other) => other.name.trim().length > row.name.trim().length && mentionsName(other.name, row.name.trim())));
  const names = new Set(kept.map((row) => folded(row.name)));
  if (names.size !== 1) return null;
  const [name] = names;
  const owners = rows.filter((row) => folded(row.name) === name);
  return owners.length === 1 ? owners[0] : null;
}

export async function memberNames(db: Db, workspaceId: string) {
  const result = await db.query<{ name: string | null }>(
    `select trim(p.full_name) as name
     from crm.workspace_members m
     join crm.profiles p on p.id = m.user_id
     where m.workspace_id = $1`,
    [workspaceId],
  );
  return new Set(result.rows.flatMap((row) => (row.name ? [folded(row.name)] : [])));
}

export async function detectTaskRecordsInDb(db: Db, workspaceId: string, text: string): Promise<DetectedTaskLinks> {
  const clean = text.trim().slice(0, TEXT_LIMIT);
  if (clean.length < MIN_NAME) return NO_DETECTION;
  const members = await memberNames(db, workspaceId);
  const companies = await db.query<{ id: string; name: string }>(
    `select id, name from crm.companies
     where workspace_id = $1 and archived_at is null and char_length(name) >= $3
       and strpos(lower($2), lower(name)) > 0
     order by char_length(name) desc limit ${SCAN_LIMIT}`,
    [workspaceId, clean, MIN_NAME],
  );
  const contacts = await db.query<{ id: string; name: string; company_id: string | null; company_name: string | null }>(
    `select c.id, trim(c.first_name) || ' ' || trim(c.last_name) as name, c.company_id, co.name as company_name
     from crm.contacts c
     left join crm.companies co on co.id = c.company_id
     where c.workspace_id = $1 and c.archived_at is null
       and nullif(trim(c.first_name), '') is not null and nullif(trim(c.last_name), '') is not null
       and strpos(lower($2), lower(trim(c.first_name) || ' ' || trim(c.last_name))) > 0
     order by char_length(trim(c.first_name) || ' ' || trim(c.last_name)) desc limit ${SCAN_LIMIT}`,
    [workspaceId, clean],
  );
  const opportunities = await db.query<{ id: string; name: string; company_id: string; company_name: string }>(
    `select o.id, o.name, o.company_id, co.name as company_name
     from crm.opportunities o
     join crm.companies co on co.id = o.company_id
     where o.workspace_id = $1 and o.archived_at is null and char_length(o.name) >= $3
       and strpos(lower($2), lower(o.name)) > 0
     order by char_length(o.name) desc limit ${SCAN_LIMIT}`,
    [workspaceId, clean, MIN_NAME],
  );
  const contactHits = mentioned(contacts.rows, clean, members);
  const companyHits = mentioned(companies.rows, clean, members);
  const opportunityHits = mentioned(
    opportunities.rows.filter((row) => /\s/.test(row.name.trim())),
    clean,
    members,
  );
  const everything: Named[] = [...contactHits, ...companyHits, ...opportunityHits];
  let contactRow = unique(contacts.rows, contactHits, everything);
  const companyRow = unique(companies.rows, companyHits, everything);
  const opportunityRow = unique(opportunities.rows, opportunityHits, everything);
  if (contactRow && companyRow && contactRow.company_id && contactRow.company_id !== companyRow.id) contactRow = null;
  const company = companyRow
    ? { id: companyRow.id, name: companyRow.name }
    : contactRow?.company_id
      ? { id: contactRow.company_id, name: contactRow.company_name ?? "" }
      : opportunityRow
        ? { id: opportunityRow.company_id, name: opportunityRow.company_name }
        : null;
  const opportunity =
    opportunityRow && (!company || company.id === opportunityRow.company_id)
      ? { id: opportunityRow.id, name: opportunityRow.name, companyId: opportunityRow.company_id }
      : null;
  const contact = contactRow
    ? {
        id: contactRow.id,
        name: contactRow.name,
        company: contactRow.company_id ? { id: contactRow.company_id, name: contactRow.company_name ?? "" } : null,
      }
    : null;
  return { company, contact, opportunity };
}

export function detectedIds(found: DetectedTaskLinks): DetectedLinkIds {
  return {
    ...(found.contact ? { contactId: found.contact.id } : {}),
    ...(found.company ? { companyId: found.company.id } : {}),
    ...(found.opportunity ? { opportunityId: found.opportunity.id } : {}),
  };
}
