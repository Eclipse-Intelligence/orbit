import { cleanLifecycle, companiesCsvRows } from "@/lib/companies";
import { listCompanies, bulkUpsertCompanies } from "@/lib/crm/companies";
import { upsertContact } from "@/lib/crm/contacts";
import { listActivities } from "@/lib/crm/activities";
import { listContacts } from "@/lib/crm/contacts";
import { listOpportunities } from "@/lib/crm/opportunities";
import { listTasks } from "@/lib/crm/tasks";
import { CrmError } from "@/lib/crm/errors";
import { canonicalDomain, parseTagList } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Activity, Company, CompanyWrite, Contact, Opportunity, Task } from "@/lib/crm/types";
import { withActor } from "@/lib/crm/context";
import { EXPORT_ROW_LIMIT, type CsvCell, type CsvExport } from "@/lib/csv";

export type ImportResult = {
  created: number;
  updated: number;
  matched: number;
  errors: { row: number; message: string }[];
};

export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  row.push(cell.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function headerIndex(headers: string[]) {
  const map = new Map<string, number>();
  headers.forEach((header, index) => map.set(header.trim().toLowerCase(), index));
  return (names: string[]) => {
    for (const name of names) {
      const index = map.get(name);
      if (index !== undefined) return index;
    }
    return -1;
  };
}

function cell(row: string[], index: number) {
  if (index < 0) return "";
  return row[index]?.trim() ?? "";
}

function columnValue(row: string[], index: number): string | undefined {
  if (index < 0) return undefined;
  const value = cell(row, index).replace(/^'(?=[=+\-@])/, "");
  return value || undefined;
}

export async function importCompaniesCsv(actor: Actor, csv: string): Promise<ImportResult> {
  assertScope(actor.scopes, "companies:write");
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new CrmError("invalid_input", "The CSV needs a header and one row.", 400);
  const pick = headerIndex(rows[0]);
  const nameAt = pick(["company", "name", "company name"]);
  const domainAt = pick(["domain"]);
  const items: CompanyWrite[] = [];
  const itemRows: number[] = [];
  const errors: ImportResult["errors"] = [];
  if (rows.length > 51) errors.push({ row: 52, message: "Only the first 50 rows are imported at a time." });
  for (let index = 1; index < rows.length && index <= 50; index += 1) {
    const row = rows[index];
    const name = columnValue(row, nameAt);
    const domain = columnValue(row, domainAt);
    if (!name && !domain) {
      errors.push({ row: index + 1, message: "A company needs a name or a domain." });
      continue;
    }
    const item: CompanyWrite = {};
    if (name) item.name = name;
    if (domain !== undefined) item.domain = domain;
    const website = columnValue(row, pick(["website"]));
    const industry = columnValue(row, pick(["industry"]));
    const sizeCategory = columnValue(row, pick(["size", "size category"]));
    const source = columnValue(row, pick(["source"]));
    const description = columnValue(row, pick(["description"]));
    const lifecycle = columnValue(row, pick(["lifecycle"]));
    const tags = columnValue(row, pick(["tags", "tag"]));
    if (website !== undefined) item.website = website;
    if (industry !== undefined) item.industry = industry;
    if (sizeCategory !== undefined) item.sizeCategory = sizeCategory;
    if (source !== undefined) item.source = source;
    if (description !== undefined) item.description = description;
    if (tags !== undefined) item.tags = parseTagList(tags);
    if (typeof lifecycle === "string") {
      const parsed = lifecycleOf(lifecycle);
      if (parsed) item.lifecycle = parsed;
    }
    items.push(item);
    itemRows.push(index + 1);
  }
  if (items.length === 0) return { created: 0, updated: 0, matched: 0, errors };
  const result = await bulkUpsertCompanies(actor, items, {
    provenance: { operation: "import_companies", source: "csv" },
  });
  return countBulk(result.body.results, itemRows, errors);
}

export async function importContactsCsv(actor: Actor, csv: string): Promise<ImportResult> {
  assertScope(actor.scopes, "contacts:write");
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new CrmError("invalid_input", "The CSV needs a header and one row.", 400);
  const pick = headerIndex(rows[0]);
  const summary: ImportResult = { created: 0, updated: 0, matched: 0, errors: [] };
  if (rows.length > 51) {
    summary.errors.push({ row: 52, message: "Only the first 50 rows are imported at a time." });
  }
  const slice = rows.slice(1, 51);
  for (let index = 0; index < slice.length; index += 1) {
    const row = slice[index];
    const firstName = columnValue(row, pick(["first name", "first", "firstname"]));
    const lastName = columnValue(row, pick(["last name", "last", "lastname"]));
    const email = columnValue(row, pick(["email"]));
    const phone = columnValue(row, pick(["phone"]));
    const linkedin = columnValue(row, pick(["linkedin", "linkedin url"]));
    if (![firstName, lastName, email, phone, linkedin].some((value) => value)) {
      summary.errors.push({ row: index + 2, message: "A contact needs a name, email, phone, or LinkedIn URL." });
      continue;
    }
    try {
      const input: Parameters<typeof upsertContact>[1] = {};
      if (firstName !== undefined) input.firstName = firstName;
      if (lastName !== undefined) input.lastName = lastName;
      if (email !== undefined) input.email = email;
      if (phone !== undefined) input.phone = phone;
      if (linkedin !== undefined) input.linkedinUrl = linkedin;
      const jobTitle = columnValue(row, pick(["title", "job title"]));
      const source = columnValue(row, pick(["source"]));
      const notes = columnValue(row, pick(["notes"]));
      const location = columnValue(row, pick(["location"]));
      const salesNavigator = columnValue(row, pick(["sales navigator", "sales navigator url", "sales navigator lead"]));
      const tags = columnValue(row, pick(["tags", "tag"]));
      if (jobTitle !== undefined) input.jobTitle = jobTitle;
      if (source !== undefined) input.source = source;
      if (notes !== undefined) input.notes = notes;
      if (location !== undefined) input.location = location;
      if (salesNavigator !== undefined) input.salesNavigatorUrl = salesNavigator;
      if (tags !== undefined) input.tags = parseTagList(tags);
      const companyDomain = columnValue(row, pick(["company domain", "domain"]));
      const companyName = columnValue(row, pick(["company", "company name"]));
      if (companyDomain || companyName) {
        const companyId = await findCompanyId(
          actor,
          companyDomain ? canonicalDomain(companyDomain) : null,
          companyName ?? "",
        );
        if (!companyId) {
          summary.errors.push({ row: index + 2, message: "No company matched that domain or name." });
          continue;
        }
        input.companyId = companyId;
      }
      const saved = await upsertContact(actor, input, {
        provenance: { operation: "import_contacts", source: "csv" },
      });
      if (saved.body.created) summary.created += 1;
      else if (saved.body.changed) summary.updated += 1;
      else summary.matched += 1;
    } catch (error) {
      summary.errors.push({
        row: index + 2,
        message: error instanceof CrmError ? error.message : "That row could not be imported.",
      });
    }
  }
  return summary;
}

async function findCompanyId(actor: Actor, domain: string | null, name: string) {
  if (!domain && !name) return null;
  return withActor(actor, async (db) => {
    if (domain) {
      const byDomain = await db.query<{ id: string }>(
        `select id from crm.companies
         where workspace_id = $1 and archived_at is null and domain = $2
         limit 1`,
        [actor.workspaceId, domain],
      );
      if (byDomain.rows[0]) return byDomain.rows[0].id;
    }
    if (!name) return null;
    const byName = await db.query<{ id: string }>(
      `select id from crm.companies
       where workspace_id = $1 and archived_at is null and lower(name) = lower($2)
       order by domain nulls first
       limit 1`,
      [actor.workspaceId, name],
    );
    return byName.rows[0]?.id ?? null;
  });
}

function lifecycleOf(value: string): CompanyWrite["lifecycle"] {
  return cleanLifecycle(value) ?? undefined;
}

function countBulk(
  results: { status: string; error?: { message: string } }[],
  rowNumbers: number[],
  errors: ImportResult["errors"],
): ImportResult {
  const summary: ImportResult = { created: 0, updated: 0, matched: 0, errors };
  results.forEach((result, index) => {
    if (result.status === "created") summary.created += 1;
    else if (result.status === "updated") summary.updated += 1;
    else if (result.status === "matched") summary.matched += 1;
    else summary.errors.push({ row: rowNumbers[index] ?? index + 2, message: result.error?.message ?? "That row failed." });
  });
  return summary;
}

export const EXPORT_PAGE_SIZE = 100;

export const EXPORT_BUDGET_MS = 50_000;

export type Collected<T> = { rows: T[]; total: number; truncated: boolean; outOfTime: boolean };

type CollectOptions = { budgetMs?: number; now?: () => number };

export async function collectForExport<T>(
  load: (offset: number, limit: number) => Promise<{ data: T[]; total: number }>,
  options: CollectOptions = {},
): Promise<Collected<T>> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? EXPORT_BUDGET_MS);
  const rows: T[] = [];
  let total = 0;
  let outOfTime = false;
  while (rows.length < EXPORT_ROW_LIMIT) {
    if (rows.length > 0 && now() >= deadline) {
      outOfTime = true;
      break;
    }
    const page = await load(rows.length, Math.min(EXPORT_PAGE_SIZE, EXPORT_ROW_LIMIT - rows.length));
    total = Math.max(page.total, rows.length + page.data.length);
    rows.push(...page.data);
    if (page.data.length === 0 || rows.length >= page.total) break;
  }
  const kept = rows.slice(0, EXPORT_ROW_LIMIT);
  const truncated = total > kept.length;
  return { rows: kept, total, truncated, outOfTime: truncated && outOfTime };
}

export function csvExport<T>(collected: Collected<T>, rows: CsvCell[][]): CsvExport {
  return { rows, total: collected.total, exported: collected.rows.length, truncated: collected.truncated, outOfTime: collected.outOfTime };
}

export async function exportCompaniesCsv(actor: Actor) {
  const collected = await collectForExport<Company>((offset, limit) =>
    listCompanies(actor, { limit, offset, sort: "name", order: "asc" }),
  );
  return csvExport(collected, companiesCsvRows(collected.rows));
}

export async function exportContactsCsv(actor: Actor) {
  const collected = await collectForExport<Contact>((offset, limit) => listContacts(actor, { limit, offset }));
  return csvExport(collected, contactsCsvRows(collected.rows));
}

export function contactsCsvRows(rows: Contact[]) {
  return [
    ["First name", "Last name", "Email", "Phone", "Title", "LinkedIn", "Company", "Location", "Sales Navigator", "Source", "Notes", "Tags"],
    ...rows.map((contact) => [
      contact.firstName ?? "",
      contact.lastName ?? "",
      contact.email ?? "",
      contact.phone ?? "",
      contact.jobTitle ?? "",
      contact.linkedinUrl ?? "",
      contact.companyName ?? "",
      contact.location ?? "",
      contact.salesNavigatorUrl ?? "",
      contact.source ?? "",
      contact.notes ?? "",
      contact.tags.join("; "),
    ]),
  ];
}

export async function exportOpportunitiesCsv(actor: Actor) {
  const collected = await collectForExport<Opportunity>((offset, limit) => listOpportunities(actor, { limit, offset }));
  const rows = collected.rows;
  return csvExport(collected, [
    ["Name", "Company", "Stage", "Status", "Value", "Currency", "Expected close", "Source"],
    ...rows.map((opportunity) => [
      opportunity.name,
      opportunity.companyName ?? "",
      opportunity.stageName ?? "",
      opportunity.status,
      opportunity.value ?? "",
      opportunity.currency,
      opportunity.expectedCloseDate ?? "",
      opportunity.source ?? "",
    ]),
  ]);
}

export async function exportActivitiesCsv(actor: Actor) {
  const collected = await collectForExport<Activity>((offset, limit) => listActivities(actor, { limit, offset }));
  const rows = collected.rows;
  return csvExport(collected, [
    ["Type", "Title", "Body", "Company", "Contact", "When"],
    ...rows.map((activity) => [
      activity.type,
      activity.title ?? "",
      activity.body ?? "",
      activity.companyName ?? "",
      activity.contactName ?? "",
      activity.occurredAt,
    ]),
  ]);
}

export async function exportTasksCsv(actor: Actor) {
  const collected = await collectForExport<Task>((offset, limit) =>
    listTasks(actor, { limit, offset, includeArchived: false, view: "none" }),
  );
  const rows = collected.rows;
  return csvExport(collected, [
    ["Title", "Company", "Due", "Priority", "Completed"],
    ...rows.map((task) => [
      task.title,
      task.companyName ?? "",
      task.dueAt ?? "",
      task.priority,
      task.completedAt ?? "",
    ]),
  ]);
}
