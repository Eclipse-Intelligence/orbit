import { createHash } from "node:crypto";
import { createActivityInDb } from "@/lib/crm/activities";
import { readCompanyInDb, scheduleEnrichment, updateCompanyInDb, upsertCompanyInDb } from "@/lib/crm/companies";
import { readContactInDb, updateContactInDb, upsertContactInDb } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid, recordAudit } from "@/lib/crm/mutate";
import {
  canonicalCompanyLinkedin,
  canonicalDomain,
  canonicalLinkedin,
  canonicalSalesNavigator,
  normalizeCompanyName,
  normalizePersonName,
} from "@/lib/crm/normalize";
import { createOpportunityInDb } from "@/lib/crm/opportunities";
import { isReminderMinutes } from "@/lib/crm/reminder-options";
import { assertScope } from "@/lib/crm/scopes";
import { createTaskInDb } from "@/lib/crm/tasks";
import type { CompanyWrite, Contact, ContactWrite, Provenance, UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import {
  DIFF_FIELDS,
  EXTENSION_SOURCE,
  type CaptureResponse,
  type DiffField,
  type DiffResponse,
  type DiffRow,
  type LogCheckResponse,
  type LogResponse,
  type NoteResponse,
  type PageCompany,
  type PagePerson,
  type TaskResponse,
  type ThreadMessage,
} from "@/lib/extension/protocol";
import { companySummaryInDb, dayLabel, matchCompany, personSummary } from "@/lib/extension/records";
import { appTimeZone, startOfDay, zonedParts, zonedTimeToDate } from "@/lib/time";

const MESSAGE_LIMIT = 200;
const BODY_LIMIT = 10_000;
const SOURCE_LABEL = "LinkedIn";

type Input = Record<string, unknown>;

function provenance(operation: string, sourceUrl?: string | null): Provenance {
  return { operation, source: EXTENSION_SOURCE, sourceUrl: sourceUrl ?? null };
}

function text(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function longText(value: unknown, max: number, field: string) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\r\n/g, "\n").trim();
  if (clean.length > max) throw new CrmError("invalid_input", `That's too long. Keep it under ${max.toLocaleString("en-GB")} characters.`, 400, { field });
  return clean || null;
}

function object(value: unknown): Input | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Input) : null;
}

function uuid(value: unknown) {
  return typeof value === "string" && isUuid(value) ? value : null;
}

function tagsFrom(value: unknown) {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === "string").slice(0, 20);
  if (typeof value === "string") return value.split(/[;,]/);
  return [];
}

function sourceUrlFrom(value: unknown) {
  const url = text(value, 2000);
  if (!url) return null;
  return canonicalLinkedin(url) ?? canonicalSalesNavigator(url) ?? canonicalCompanyLinkedin(url) ?? null;
}

async function onBoard(db: Db, actor: UserActor, companyId: string | null, boardId: string | null, stageId: string | null, prov: Provenance, name: string) {
  if (!boardId) return null;
  if (!companyId) throw new CrmError("invalid_input", "Add a company to put this on a board.", 400, { field: "boardId" });
  const board = await db.query<{ kind: string }>("select kind from crm.pipelines where id = $1 and workspace_id = $2 and archived_at is null", [
    boardId,
    actor.workspaceId,
  ]);
  if (!board.rows[0]) throw new CrmError("invalid_input", "That board no longer exists.", 400, { field: "boardId" });
  const existing = await db.query(
    `select 1 from crm.opportunities
     where pipeline_id = $1 and company_id = $2 and archived_at is null
       and ($3 = 'board' or status = 'open')
     limit 1`,
    [boardId, companyId, board.rows[0].kind],
  );
  if ((existing.rowCount ?? 0) > 0) return null;
  return createOpportunityInDb(db, actor, { companyId, pipelineId: boardId, stageId: stageId ?? undefined }, prov, name);
}

async function findOrCreateCompany(
  db: Db,
  actor: UserActor,
  input: { name: string | null; domain: string | null; linkedinUrl: string | null } & Omit<CompanyWrite, "name" | "domain" | "linkedinUrl">,
  prov: Provenance,
) {
  const found = await matchCompany(db, actor.workspaceId, input);
  if (found) {
    const company = await readCompanyInDb(db, found.id, actor.workspaceId);
    if (company) return { company, created: false };
  }
  if (!input.name && !input.domain) return null;
  const write: CompanyWrite = { ...input, name: input.name ?? undefined, domain: input.domain, linkedinUrl: input.linkedinUrl, source: SOURCE_LABEL };
  const saved = await upsertCompanyInDb(db, actor, write, prov);
  return { company: saved.company, created: saved.created };
}

function personInput(value: unknown) {
  const person = object(value) ?? {};
  const linkedin = text(person.linkedinUrl, 500);
  const salesNavigator = text(person.salesNavigatorUrl, 500);
  const linkedinUrl = linkedin ? canonicalLinkedin(linkedin) : null;
  const salesNavigatorUrl = salesNavigator ? canonicalSalesNavigator(salesNavigator) : null;
  if (linkedin && !linkedinUrl) throw new CrmError("invalid_input", "That LinkedIn profile link isn't valid.", 400, { field: "linkedinUrl" });
  if (salesNavigator && !salesNavigatorUrl) throw new CrmError("invalid_input", "That Sales Navigator link isn't valid.", 400, { field: "salesNavigatorUrl" });
  return {
    firstName: text(person.firstName, 80),
    lastName: text(person.lastName, 80),
    jobTitle: text(person.jobTitle, 120),
    location: text(person.location, 200),
    linkedinUrl,
    salesNavigatorUrl,
  };
}

function companyInput(value: unknown) {
  const company = object(value);
  if (!company) return null;
  const domainText = text(company.domain, 300);
  const domain = domainText ? canonicalDomain(domainText) : null;
  if (domainText && !domain) throw new CrmError("invalid_input", "Enter a domain like example.com.", 400, { field: "domain" });
  const linkedin = text(company.linkedinUrl, 500);
  return {
    name: text(company.name, 200),
    domain,
    linkedinUrl: linkedin ? canonicalCompanyLinkedin(linkedin) : null,
    industry: text(company.industry, 120),
    sizeCategory: text(company.sizeCategory, 80),
    description: longText(company.description, 2000, "description"),
  };
}

export async function capture(actor: UserActor, body: Input): Promise<CaptureResponse> {
  if (body.kind === "person") return capturePerson(actor, body);
  if (body.kind === "company") return captureCompany(actor, body);
  if (body.kind === "link") return linkPerson(actor, body);
  throw new CrmError("invalid_input", "Choose what to save.", 400, { field: "kind" });
}

async function capturePerson(actor: UserActor, body: Input): Promise<CaptureResponse> {
  assertScope(actor.scopes, "contacts:write");
  const person = personInput(body.person);
  if (!person.firstName && !person.lastName && !person.linkedinUrl) {
    throw new CrmError("invalid_input", "Add their name before saving.", 400, { field: "firstName" });
  }
  const company = companyInput(body.company);
  const ownerId = body.ownerId === null ? null : (uuid(body.ownerId) ?? actor.userId);
  const tags = tagsFrom(body.tags);
  const boardId = uuid(body.boardId);
  const stageId = uuid(body.stageId);
  const prov = provenance("linkedin_capture", sourceUrlFrom(body.sourceUrl) ?? person.linkedinUrl ?? person.salesNavigatorUrl);
  const result = await withActor(actor, async (db) => {
    const savedCompany =
      company && (company.name || company.domain || company.linkedinUrl)
        ? await findOrCreateCompany(db, actor, { name: company.name, domain: company.domain, linkedinUrl: company.linkedinUrl, ownerId, tags }, prov)
        : null;
    const contact = await upsertContactInDb(
      db,
      actor,
      {
        firstName: person.firstName,
        lastName: person.lastName,
        jobTitle: person.jobTitle,
        location: person.location,
        linkedinUrl: person.linkedinUrl,
        salesNavigatorUrl: person.salesNavigatorUrl,
        companyId: savedCompany?.company.id ?? undefined,
        ownerId,
        tags,
        source: SOURCE_LABEL,
      },
      prov,
      { nameMatch: false },
    );
    const opportunity = await onBoard(db, actor, savedCompany?.company.id ?? null, boardId, stageId, prov, savedCompany?.company.name ?? contact.contact.name);
    await recordAudit(db, actor, "lead.created", "lead", savedCompany?.company.id ?? contact.contact.id, prov, {
      companyId: savedCompany?.company.id ?? null,
      contactId: contact.contact.id,
      companyCreated: savedCompany?.created ?? false,
      contactCreated: contact.created,
      opportunityId: opportunity?.id ?? null,
      activityId: null,
      taskId: null,
    });
    return {
      person: await personSummary(db, actor, contact.contact.id),
      company: savedCompany ? await companySummaryInDb(db, actor, savedCompany.company) : null,
      created: { contact: contact.created, company: savedCompany?.created ?? false },
    };
  });
  if (result.created.company && result.company) scheduleEnrichment(actor, result.company.id);
  return result;
}

async function captureCompany(actor: UserActor, body: Input): Promise<CaptureResponse> {
  assertScope(actor.scopes, "companies:write");
  const company = companyInput(body.company);
  if (!company?.name) throw new CrmError("invalid_input", "Enter a company name.", 400, { field: "name" });
  const ownerId = body.ownerId === null ? null : (uuid(body.ownerId) ?? actor.userId);
  const lifecycle = text(body.lifecycle, 40);
  const tags = tagsFrom(body.tags);
  const prov = provenance("linkedin_capture", sourceUrlFrom(body.sourceUrl) ?? company.linkedinUrl);
  const result = await withActor(actor, async (db) => {
    const saved = await findOrCreateCompany(
      db,
      actor,
      {
        name: company.name,
        domain: company.domain,
        linkedinUrl: company.linkedinUrl,
        industry: company.industry,
        sizeCategory: company.sizeCategory,
        description: company.description,
        lifecycle: lifecycle ?? undefined,
        ownerId,
        tags,
      },
      prov,
    );
    if (!saved) throw new CrmError("invalid_input", "Enter a company name.", 400, { field: "name" });
    await onBoard(db, actor, saved.company.id, uuid(body.boardId), uuid(body.stageId), prov, saved.company.name);
    return {
      person: null,
      company: await companySummaryInDb(db, actor, saved.company),
      created: { contact: false, company: saved.created },
    };
  });
  if (result.created.company && result.company) scheduleEnrichment(actor, result.company.id);
  return result;
}

async function linkPerson(actor: UserActor, body: Input): Promise<CaptureResponse> {
  assertScope(actor.scopes, "contacts:write");
  const contactId = uuid(body.contactId);
  if (!contactId) throw new CrmError("not_found", "That person isn't in Orbit any more.", 404);
  const person = personInput({ linkedinUrl: body.linkedinUrl, salesNavigatorUrl: body.salesNavigatorUrl });
  if (!person.linkedinUrl && !person.salesNavigatorUrl) throw new CrmError("invalid_input", "There's no LinkedIn link on this page to save.", 400);
  const prov = provenance("linkedin_link", sourceUrlFrom(body.sourceUrl) ?? person.linkedinUrl ?? person.salesNavigatorUrl);
  return withActor(actor, async (db) => {
    const contact = await readContactInDb(db, contactId, actor.workspaceId);
    if (!contact) throw new CrmError("not_found", "That person isn't in Orbit any more.", 404);
    if (person.linkedinUrl && contact.linkedinUrl && contact.linkedinUrl !== person.linkedinUrl) {
      throw new CrmError("conflict", `${contact.name} already has a different LinkedIn profile saved.`, 409);
    }
    if (person.salesNavigatorUrl && contact.salesNavigatorUrl && contact.salesNavigatorUrl !== person.salesNavigatorUrl) {
      throw new CrmError("conflict", `${contact.name} already has a different Sales Navigator lead saved.`, 409);
    }
    const write: ContactWrite = {};
    if (person.linkedinUrl) write.linkedinUrl = person.linkedinUrl;
    if (person.salesNavigatorUrl) write.salesNavigatorUrl = person.salesNavigatorUrl;
    await updateContactInDb(db, actor, contactId, write, prov);
    return { person: await personSummary(db, actor, contactId), company: null, created: { contact: false, company: false } };
  });
}

function same(left: string | null, right: string | null) {
  return (left ?? "").replace(/\s+/g, " ").trim().toLowerCase() === (right ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function row(field: DiffField, label: string, before: string | null, after: string | null, changed = !same(before, after)): DiffRow {
  return { field, label, before, after, changed: Boolean(after) && changed };
}

function pagePerson(value: unknown): PagePerson {
  const page = object(value) ?? {};
  const name = text(page.name, 160);
  let firstName = text(page.firstName, 80);
  let lastName = text(page.lastName, 80);
  if (name && !firstName && !lastName) {
    const parts = name.split(" ");
    firstName = parts[0] ?? null;
    lastName = parts.slice(1).join(" ") || null;
  }
  const linkedin = text(page.linkedinUrl, 500);
  const lead = text(page.salesNavigatorUrl, 500);
  const companyUrl = text(page.companyLinkedinUrl, 500);
  return {
    name: name ?? ([firstName, lastName].filter(Boolean).join(" ") || null),
    firstName,
    lastName,
    headline: text(page.headline, 300),
    jobTitle: text(page.jobTitle, 120),
    location: text(page.location, 200),
    linkedinUrl: linkedin ? canonicalLinkedin(linkedin) : null,
    salesNavigatorUrl: lead ? canonicalSalesNavigator(lead) : null,
    companyName: text(page.companyName, 200),
    companyLinkedinUrl: companyUrl ? canonicalCompanyLinkedin(companyUrl) : null,
  };
}

function pageCompany(value: unknown): PageCompany {
  const page = object(value) ?? {};
  const linkedin = text(page.linkedinUrl, 500);
  return {
    name: text(page.name, 200),
    tagline: text(page.tagline, 500),
    website: text(page.website, 500),
    industry: text(page.industry, 120),
    sizeCategory: text(page.sizeCategory, 80),
    location: text(page.location, 200),
    linkedinUrl: linkedin ? canonicalCompanyLinkedin(linkedin) : null,
  };
}

function personRows(contact: Contact, page: PagePerson) {
  const rows: DiffRow[] = [
    row("jobTitle", "Job title", contact.jobTitle, page.jobTitle),
    row("location", "Location", contact.location, page.location),
    row(
      "company",
      "Company",
      contact.companyName,
      page.companyName,
      !(contact.companyName && page.companyName && normalizeCompanyName(contact.companyName) === normalizeCompanyName(page.companyName)),
    ),
    row("name", "Name", contact.name, page.name, normalizePersonName(contact.name) !== normalizePersonName(page.name ?? "")),
  ];
  if (page.linkedinUrl) rows.push(row("linkedinUrl", "LinkedIn", contact.linkedinUrl, page.linkedinUrl, contact.linkedinUrl !== page.linkedinUrl));
  if (page.salesNavigatorUrl) {
    rows.push(row("salesNavigatorUrl", "Sales Navigator", contact.salesNavigatorUrl, page.salesNavigatorUrl, contact.salesNavigatorUrl !== page.salesNavigatorUrl));
  }
  return rows.filter((item) => item.after);
}

function companyRows(company: { name: string; website: string | null; industry: string | null; sizeCategory: string | null; linkedinUrl: string | null; domain: string | null }, page: PageCompany) {
  const pageDomain = page.website ? canonicalDomain(page.website) : null;
  const rows: DiffRow[] = [
    row("name", "Name", company.name, page.name, normalizeCompanyName(company.name) !== normalizeCompanyName(page.name ?? "")),
    row("website", "Website", company.website ?? company.domain, page.website, !(pageDomain && (company.domain === pageDomain || (company.website && canonicalDomain(company.website) === pageDomain)))),
    row("industry", "Industry", company.industry, page.industry),
    row("sizeCategory", "Size", company.sizeCategory, page.sizeCategory),
    row("linkedinUrl", "LinkedIn", company.linkedinUrl, page.linkedinUrl, company.linkedinUrl !== page.linkedinUrl),
  ];
  return rows.filter((item) => item.after);
}

function wanted(value: unknown): DiffField[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((field): field is DiffField => typeof field === "string" && (DIFF_FIELDS as readonly string[]).includes(field));
}

export async function diff(actor: UserActor, body: Input): Promise<DiffResponse> {
  const apply = wanted(body.apply);
  const contactId = uuid(body.contactId);
  const companyId = uuid(body.companyId);
  if (!contactId && !companyId) throw new CrmError("invalid_input", "Choose a person or company.", 400);
  if (apply) assertScope(actor.scopes, contactId ? "contacts:write" : "companies:write");
  if (contactId) {
    const page = pagePerson(body.person);
    const prov = provenance("linkedin_update", page.linkedinUrl ?? page.salesNavigatorUrl);
    return withActor(actor, async (db) => {
      const contact = await readContactInDb(db, contactId, actor.workspaceId);
      if (!contact) throw new CrmError("not_found", "That person isn't in Orbit any more.", 404);
      const rows = personRows(contact, page);
      const chosen = apply ? rows.filter((item) => item.changed && apply.includes(item.field)) : [];
      if (chosen.length > 0) {
        const write: ContactWrite = {};
        for (const item of chosen) {
          if (item.field === "jobTitle") write.jobTitle = page.jobTitle;
          if (item.field === "location") write.location = page.location;
          if (item.field === "linkedinUrl") write.linkedinUrl = page.linkedinUrl;
          if (item.field === "salesNavigatorUrl") write.salesNavigatorUrl = page.salesNavigatorUrl;
          if (item.field === "name") {
            write.firstName = page.firstName;
            write.lastName = page.lastName;
          }
          if (item.field === "company") {
            const company = await findOrCreateCompany(db, actor, { name: page.companyName, domain: null, linkedinUrl: page.companyLinkedinUrl }, prov);
            if (company) write.companyId = company.company.id;
          }
        }
        await updateContactInDb(db, actor, contactId, write, prov);
      }
      const updated = await readContactInDb(db, contactId, actor.workspaceId);
      return {
        changes: updated && chosen.length > 0 ? personRows(updated, page) : rows,
        applied: chosen.map((item) => item.field),
        person: await personSummary(db, actor, contactId),
        company: null,
      };
    });
  }
  const page = pageCompany(body.company);
  const prov = provenance("linkedin_update", page.linkedinUrl);
  return withActor(actor, async (db) => {
    const company = await readCompanyInDb(db, companyId!, actor.workspaceId);
    if (!company) throw new CrmError("not_found", "That company isn't in Orbit any more.", 404);
    const rows = companyRows(company, page);
    const chosen = apply ? rows.filter((item) => item.changed && apply.includes(item.field)) : [];
    if (chosen.length > 0) {
      const write: CompanyWrite = {};
      for (const item of chosen) {
        if (item.field === "name" && page.name) write.name = page.name;
        if (item.field === "industry") write.industry = page.industry;
        if (item.field === "sizeCategory") write.sizeCategory = page.sizeCategory;
        if (item.field === "linkedinUrl") write.linkedinUrl = page.linkedinUrl;
        if (item.field === "website" && page.website) {
          write.website = page.website;
          if (!company.domain) write.domain = canonicalDomain(page.website);
        }
      }
      await updateCompanyInDb(db, actor, company.id, write, prov);
    }
    const updated = await readCompanyInDb(db, company.id, actor.workspaceId);
    return {
      changes: updated && chosen.length > 0 ? companyRows(updated, page) : rows,
      applied: chosen.map((item) => item.field),
      person: null,
      company: updated ? await companySummaryInDb(db, actor, updated) : null,
    };
  });
}

export function dueFrom(value: unknown, now = new Date()) {
  if (value === null || value === undefined || value === "") return null;
  const timeZone = appTimeZone();
  const offsets: Record<string, number> = { today: 0, tomorrow: 1, next_week: 7 };
  let day: { year: number; month: number; day: number } | null = null;
  if (typeof value === "string" && value in offsets) {
    const start = startOfDay(now, timeZone, offsets[value]);
    const parts = zonedParts(start, timeZone);
    day = { year: parts.year, month: parts.month, day: parts.day };
  } else if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (match) {
      const [year, month, date] = match.slice(1).map(Number);
      const check = new Date(Date.UTC(year, month - 1, date));
      if (check.getUTCMonth() === month - 1 && check.getUTCDate() === date) day = { year, month, day: date };
    }
  }
  if (!day) throw new CrmError("invalid_input", "Choose when it's due.", 400, { field: "due" });
  return zonedTimeToDate({ ...day, hour: 9, minute: 0, second: 0 }, timeZone).toISOString();
}

async function linkedRecords(db: Db, actor: UserActor, body: Input) {
  const contactId = uuid(body.contactId);
  let companyId = uuid(body.companyId);
  let contact: Contact | null = null;
  if (contactId) {
    contact = await readContactInDb(db, contactId, actor.workspaceId);
    if (!contact) throw new CrmError("not_found", "That person isn't in Orbit any more.", 404);
    companyId = companyId ?? contact.companyId;
  }
  if (companyId && !contactId) {
    const company = await readCompanyInDb(db, companyId, actor.workspaceId);
    if (!company) throw new CrmError("not_found", "That company isn't in Orbit any more.", 404);
  }
  if (!contactId && !companyId) throw new CrmError("invalid_input", "Choose a person or company.", 400);
  return { contact, contactId, companyId };
}

export async function addTask(actor: UserActor, body: Input): Promise<TaskResponse> {
  assertScope(actor.scopes, "tasks:write");
  const title = text(body.title, 200);
  if (!title) throw new CrmError("invalid_input", "Enter a task.", 400, { field: "title" });
  const dueAt = dueFrom(body.due);
  const remind = body.remindMinutes === null || body.remindMinutes === undefined ? null : body.remindMinutes;
  if (remind !== null && !isReminderMinutes(remind)) throw new CrmError("invalid_input", "Choose a reminder from the list.", 400, { field: "remindMinutes" });
  if (remind !== null && !dueAt) throw new CrmError("invalid_input", "Choose when it's due to set a reminder.", 400, { field: "remindMinutes" });
  return withActor(actor, async (db) => {
    const links = await linkedRecords(db, actor, body);
    const task = await createTaskInDb(
      db,
      actor,
      { title, dueAt, remindMinutes: remind, ownerId: actor.userId, contactId: links.contactId, companyId: links.companyId },
      provenance("create_task", links.contact?.linkedinUrl ?? null),
    );
    return {
      task: {
        id: task.id,
        title: task.title,
        dueAt: task.dueAt,
        dueLabel: task.dueAt ? dayLabel(task.dueAt) : null,
        overdue: false,
        dueToday: false,
      },
    };
  });
}

export async function addNote(actor: UserActor, body: Input): Promise<NoteResponse> {
  assertScope(actor.scopes, "activities:write");
  const note = longText(body.body, BODY_LIMIT, "body");
  if (!note) throw new CrmError("invalid_input", "Write a note first.", 400, { field: "body" });
  return withActor(actor, async (db) => {
    const links = await linkedRecords(db, actor, body);
    const activity = await createActivityInDb(
      db,
      actor,
      { type: "note", body: note, contactId: links.contactId, companyId: links.companyId },
      provenance("create_activity", links.contact?.linkedinUrl ?? null),
    );
    return { activityId: activity.id };
  });
}

function messageText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function messageKey(message: { mine: boolean; text: string }) {
  return createHash("sha256").update(`${message.mine ? "me" : "them"}|${messageText(message.text)}`).digest("hex").slice(0, 32);
}

function threadMessages(value: unknown): ThreadMessage[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MESSAGE_LIMIT) throw new CrmError("invalid_input", `Log at most ${MESSAGE_LIMIT} messages at a time.`, 400, { field: "messages" });
  return value.flatMap((item) => {
    const message = object(item);
    const body = typeof message?.text === "string" ? message.text.replace(/\r\n/g, "\n").trim().slice(0, 5000) : "";
    if (!message || !body) return [];
    const at = typeof message.at === "string" && !Number.isNaN(new Date(message.at).getTime()) ? new Date(message.at).toISOString() : null;
    return [{ from: text(message.from, 120) ?? "", mine: message.mine === true, when: text(message.when, 60), at, text: body }];
  });
}

type LoggedRow = { created_at: Date | string; keys: string[] | null };

async function loggedKeys(db: Db, actor: UserActor, contactId: string) {
  const result = await db.query<LoggedRow>(
    `select a.created_at, array(select jsonb_array_elements_text(a.metadata->'linkedinMessageKeys')) as keys
     from crm.activities a
     where a.workspace_id = $1 and a.contact_id = $2 and a.archived_at is null and a.type = 'linkedin'
       and jsonb_typeof(a.metadata->'linkedinMessageKeys') = 'array'
     order by a.created_at desc
     limit 200`,
    [actor.workspaceId, contactId],
  );
  const byKey = new Map<string, string>();
  for (const row of result.rows) {
    const at = iso(row.created_at) ?? new Date().toISOString();
    for (const key of row.keys ?? []) if (!byKey.has(key)) byKey.set(key, at);
  }
  const latest = result.rows[0];
  return {
    byKey,
    last: latest ? { at: iso(latest.created_at) ?? new Date().toISOString(), count: latest.keys?.length ?? 0 } : null,
  };
}

export async function checkLogged(actor: UserActor, body: Input): Promise<LogCheckResponse> {
  const contactId = uuid(body.contactId);
  if (!contactId) throw new CrmError("not_found", "That person isn't in Orbit any more.", 404);
  const messages = threadMessages(body.messages);
  return withActor(actor, async (db) => {
    const contact = await readContactInDb(db, contactId, actor.workspaceId);
    if (!contact) throw new CrmError("not_found", "That person isn't in Orbit any more.", 404);
    const logged = await loggedKeys(db, actor, contactId);
    return {
      messages: messages.map((message) => {
        const at = logged.byKey.get(messageKey(message)) ?? null;
        return { loggedAt: at, loggedLabel: at ? `Logged ${dayLabel(at)}` : null };
      }),
      lastLogged: logged.last ? { ...logged.last, label: dayLabel(logged.last.at) } : null,
    };
  });
}

function firstName(contact: Contact) {
  return contact.firstName ?? contact.name.split(" ")[0] ?? contact.name;
}

export async function logLinkedin(actor: UserActor, body: Input): Promise<LogResponse> {
  assertScope(actor.scopes, "activities:write");
  const contactId = uuid(body.contactId);
  if (!contactId) throw new CrmError("not_found", "That person isn't in Orbit any more.", 404);
  if (body.kind === "message") {
    const message = longText(body.text, BODY_LIMIT, "text");
    if (!message) throw new CrmError("invalid_input", "Paste or type the message.", 400, { field: "text" });
    const direction = body.direction === "sent" ? "sent" : "received";
    const occurredAt = text(body.occurredAt, 60);
    return withActor(actor, async (db) => {
      const contact = await readContactInDb(db, contactId, actor.workspaceId);
      if (!contact) throw new CrmError("not_found", "That person isn't in Orbit any more.", 404);
      const activity = await createActivityInDb(
        db,
        actor,
        {
          type: "linkedin",
          title: direction === "sent" ? `LinkedIn message to ${firstName(contact)}` : `LinkedIn message from ${firstName(contact)}`,
          body: message,
          occurredAt,
          contactId,
          companyId: contact.companyId,
          metadata: { direction, linkedinMessageKeys: [messageKey({ mine: direction === "sent", text: message })] },
        },
        provenance("log_linkedin_message", contact.linkedinUrl),
      );
      return { activityId: activity.id, logged: 1, skipped: 0 };
    });
  }
  if (body.kind !== "conversation") throw new CrmError("invalid_input", "Choose what to log.", 400, { field: "kind" });
  const messages = threadMessages(body.messages);
  if (messages.length === 0) throw new CrmError("invalid_input", "Tick at least one message.", 400, { field: "messages" });
  const threadUrl = text(body.threadUrl, 500);
  return withActor(actor, async (db) => {
    const contact = await readContactInDb(db, contactId, actor.workspaceId);
    if (!contact) throw new CrmError("not_found", "That person isn't in Orbit any more.", 404);
    const logged = await loggedKeys(db, actor, contactId);
    const seen = new Set<string>();
    const fresh = messages.filter((message) => {
      const key = messageKey(message);
      if (logged.byKey.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length === 0) throw new CrmError("invalid_input", "Those messages are already logged.", 400, { field: "messages" });
    const lines = fresh.map((message) => {
      const who = message.mine ? "You" : message.from || contact.name;
      return `${who}${message.when ? `, ${message.when}` : ""}:\n${message.text}`;
    });
    const transcript = lines.join("\n\n");
    if (transcript.length > BODY_LIMIT) throw new CrmError("invalid_input", "That's too much for one activity. Untick some messages.", 400, { field: "messages" });
    const times = fresh.map((message) => message.at).filter((value): value is string => Boolean(value)).sort();
    const activity = await createActivityInDb(
      db,
      actor,
      {
        type: "linkedin",
        title: text(body.title, 200) ?? `LinkedIn messages with ${contact.name}`,
        body: transcript,
        occurredAt: times[times.length - 1] ?? null,
        contactId,
        companyId: contact.companyId,
        metadata: {
          linkedinMessageKeys: [...seen],
          messageCount: fresh.length,
          threadUrl: threadUrl && /^https:\/\/www\.linkedin\.com\/messaging\//.test(threadUrl) ? threadUrl : null,
        },
      },
      provenance("log_linkedin_conversation", contact.linkedinUrl),
    );
    return { activityId: activity.id, logged: fresh.length, skipped: messages.length - fresh.length };
  });
}

