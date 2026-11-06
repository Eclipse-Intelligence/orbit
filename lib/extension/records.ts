import { answerFor, ANSWER_SQL, type AnswerRow } from "@/lib/ai-fields/cells";
import { readFields, scopeMembership } from "@/lib/ai-fields/fields";
import { displayAiValue, likelihoodText, setByText } from "@/lib/ai-fields/types";
import { lifecycleLabel } from "@/lib/companies";
import { readCompanyInDb } from "@/lib/crm/companies";
import { readContactInDb } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { iso } from "@/lib/crm/mutate";
import {
  canonicalCompanyLinkedin,
  canonicalDomain,
  canonicalLinkedin,
  canonicalSalesNavigator,
  normalizeCompanyName,
  normalizedLinkedin,
  normalizePersonName,
} from "@/lib/crm/normalize";
import { LIFECYCLES, type Company, type Contact, type UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import {
  looksLikeDateOrDuration,
  looksLikeEmploymentType,
  type CompanyBrief,
  type CompanyMatch,
  type CompanySummary,
  type DealSummary,
  type ExtensionBoard,
  type ExtensionWorkspace,
  type LastContact,
  type LookupQuery,
  type LookupResponse,
  type PageKind,
  type PersonMatch,
  type PersonSummary,
  type TaskSummary,
  type WorkspaceLookup,
} from "@/lib/extension/protocol";
import { appTimeZone, startOfDay, zonedParts } from "@/lib/time";

const INTERACTION_TYPES = ["email", "meeting", "call", "linkedin"];
const ACTIVITY_KINDS: Record<string, string> = { email: "Email", meeting: "Meeting", call: "Call", linkedin: "LinkedIn" };
const CANDIDATE_LIMIT = 3;

export function dayLabel(value: string | Date, now = new Date()) {
  const date = new Date(value);
  const timeZone = appTimeZone();
  const day = zonedParts(date, timeZone);
  const today = zonedParts(now, timeZone);
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone };
  if (day.year !== today.year) options.year = "numeric";
  return new Intl.DateTimeFormat("en-GB", options).format(date);
}

export function dueLabel(value: string, now = new Date()) {
  const due = new Date(value).getTime();
  const today = startOfDay(now).getTime();
  const tomorrow = startOfDay(now, appTimeZone(), 1).getTime();
  if (due >= today && due < tomorrow) return "Today";
  if (due >= tomorrow && due < startOfDay(now, appTimeZone(), 2).getTime()) return "Tomorrow";
  return dayLabel(value, now);
}

function moneyLabel(value: string | null, currency: string) {
  if (!value) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${value}`;
  }
}

function openPath(workspaceId: string, path: string) {
  return `/open?workspace=${encodeURIComponent(workspaceId)}&to=${encodeURIComponent(path)}`;
}

function brief(company: Company, workspaceId: string): CompanyBrief {
  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    lifecycle: company.lifecycle,
    lifecycleLabel: lifecycleLabel(company.lifecycle),
    linkedinUrl: company.linkedinUrl,
    url: openPath(workspaceId, `/companies/${company.id}`),
  };
}

type DealRow = { id: string; name: string; value: string | null; currency: string; pipeline_name: string | null; stage_name: string | null };

async function dealFor(db: Db, workspaceId: string, companyId: string | null, contactId: string | null): Promise<DealSummary | null> {
  if (!companyId && !contactId) return null;
  const result = await db.query<DealRow>(
    `select o.id, o.name, o.value::text as value, o.currency, p.name as pipeline_name, s.name as stage_name
     from crm.opportunities o
     left join crm.pipelines p on p.id = o.pipeline_id
     left join crm.pipeline_stages s on s.id = o.stage_id
     where o.workspace_id = $1 and o.archived_at is null and o.status = 'open'
       and (o.company_id = $2 or ($3::uuid is not null and o.primary_contact_id = $3))
     order by (o.primary_contact_id is not distinct from $3::uuid) desc, (p.kind = 'sales') desc, o.updated_at desc
     limit 1`,
    [workspaceId, companyId, contactId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, name: row.name, value: moneyLabel(row.value, row.currency), board: row.pipeline_name ?? "Opportunities", stage: row.stage_name };
}

type TaskRow = { id: string; title: string; due_at: Date | string | null };

function taskSummary(row: TaskRow, now = new Date()): TaskSummary {
  const dueAt = iso(row.due_at);
  const today = startOfDay(now).getTime();
  const tomorrow = startOfDay(now, appTimeZone(), 1).getTime();
  const due = dueAt ? new Date(dueAt).getTime() : null;
  return {
    id: row.id,
    title: row.title,
    dueAt,
    dueLabel: dueAt ? dueLabel(dueAt, now) : null,
    overdue: due !== null && due < today,
    dueToday: due !== null && due >= today && due < tomorrow,
  };
}

async function openTasks(db: Db, workspaceId: string, companyId: string | null, contactId: string | null) {
  const result = await db.query<TaskRow & { total: number }>(
    `select t.id, t.title, t.due_at, count(*) over ()::int as total
     from crm.tasks t
     where t.workspace_id = $1 and t.archived_at is null and t.completed_at is null
       and (($2::uuid is not null and t.company_id = $2) or ($3::uuid is not null and t.contact_id = $3))
     order by t.due_at asc nulls last, t.created_at asc
     limit 5`,
    [workspaceId, companyId, contactId],
  );
  return { tasks: result.rows.map((row) => taskSummary(row)), total: result.rows[0]?.total ?? 0 };
}

async function lastContactFor(db: Db, workspaceId: string, contactId: string): Promise<LastContact | null> {
  const result = await db.query<{ type: string; title: string | null; body: string | null; occurred_at: Date | string }>(
    `select a.type, a.title, a.body, a.occurred_at
     from crm.activities a
     where a.workspace_id = $1 and a.contact_id = $2 and a.archived_at is null and a.type = any($3::text[])
     order by a.occurred_at desc
     limit 1`,
    [workspaceId, contactId, INTERACTION_TYPES],
  );
  const row = result.rows[0];
  if (!row) return null;
  const occurredAt = iso(row.occurred_at) ?? new Date().toISOString();
  const title = row.title?.trim() || row.body?.trim().split("\n")[0]?.slice(0, 120) || ACTIVITY_KINDS[row.type] || "Activity";
  return { kind: ACTIVITY_KINDS[row.type] ?? "Activity", title, occurredAt, whenLabel: dayLabel(occurredAt) };
}

async function personSummaryInDb(db: Db, actor: UserActor, contact: Contact): Promise<PersonSummary> {
  const company = contact.companyId ? await readCompanyInDb(db, contact.companyId, actor.workspaceId) : null;
  const deal = await dealFor(db, actor.workspaceId, contact.companyId, contact.id);
  const lastContact = await lastContactFor(db, actor.workspaceId, contact.id);
  const tasks = await openTasks(db, actor.workspaceId, contact.companyId, contact.id);
  return {
    id: contact.id,
    name: contact.name,
    firstName: contact.firstName,
    lastName: contact.lastName,
    jobTitle: contact.jobTitle,
    email: contact.email,
    location: contact.location,
    linkedinUrl: contact.linkedinUrl,
    salesNavigatorUrl: contact.salesNavigatorUrl,
    tags: contact.tags,
    owner: contact.ownerId ? { id: contact.ownerId, name: contact.ownerName ?? "Member" } : null,
    company: company ? brief(company, actor.workspaceId) : null,
    deal,
    lastContact,
    tasks: tasks.tasks,
    addedLabel: dayLabel(contact.createdAt),
    url: openPath(actor.workspaceId, `/contacts/${contact.id}`),
  };
}

async function aiFieldValues(db: Db, workspaceId: string, company: Company) {
  const values: CompanySummary["aiFields"] = [];
  if (company.icpFit !== null && company.icpFit !== undefined) {
    values.push({ id: "icp-fit", label: "ICP fit", value: `${Number(company.icpFit).toFixed(1)} of 4`, detail: null, meta: null });
  }
  const fields = await readFields(db, workspaceId);
  if (fields.length === 0) return values;
  const scopes = await scopeMembership(db, workspaceId, fields, [company.id]);
  const rows = await db.query<AnswerRow>(`${ANSWER_SQL} where a.workspace_id = $1 and a.company_id = $2`, [workspaceId, company.id]);
  const byField = new Map(rows.rows.map((row) => [row.field_id, row]));
  for (const field of fields) {
    const answer = answerFor(field, company.id, byField.get(field.id), scopes.get(field.id)?.has(company.id) ?? false);
    if (answer.state !== "answered") continue;
    const value = displayAiValue(field, answer.value);
    if (!value) continue;
    const meta = answer.manual
      ? `${setByText(answer.manualByName)}${answer.manualAt ? ` on ${dayLabel(answer.manualAt)}` : ""}`
      : [answer.sources.length > 0 ? `${answer.sources.length} source${answer.sources.length === 1 ? "" : "s"}` : null, answer.checkedAt ? dayLabel(answer.checkedAt) : null]
          .filter(Boolean)
          .join(" · ") || null;
    values.push({ id: field.id, label: field.label, value, detail: answer.manual ? null : likelihoodText(answer), meta });
  }
  return values;
}

export async function companySummaryInDb(db: Db, actor: UserActor, company: Company): Promise<CompanySummary> {
  const deal = await dealFor(db, actor.workspaceId, company.id, null);
  const tasks = await openTasks(db, actor.workspaceId, company.id, null);
  const people = await db.query<{ id: string; first_name: string | null; last_name: string | null; email: string | null; job_title: string | null }>(
    `select c.id, c.first_name, c.last_name, c.email, c.job_title
     from crm.contacts c
     where c.workspace_id = $1 and c.company_id = $2 and c.archived_at is null
     order by c.updated_at desc
     limit 12`,
    [actor.workspaceId, company.id],
  );
  const aiFields = await aiFieldValues(db, actor.workspaceId, company);
  const next = tasks.tasks.find((task) => task.dueLabel);
  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    website: company.website,
    industry: company.industry,
    sizeCategory: company.sizeCategory,
    lifecycle: company.lifecycle,
    lifecycleLabel: lifecycleLabel(company.lifecycle),
    linkedinUrl: company.linkedinUrl,
    tags: company.tags,
    owner: company.ownerId ? { id: company.ownerId, name: company.ownerName ?? company.ownerEmail ?? "Member" } : null,
    deal,
    people: people.rows.map((row) => ({
      id: row.id,
      name: [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || row.email || "Contact",
      jobTitle: row.job_title,
    })),
    openTasks: tasks.total,
    nextDueLabel: next?.dueLabel ? (next.dueToday || next.dueLabel === "Tomorrow" ? next.dueLabel.toLowerCase() : next.dueLabel) : null,
    tasks: tasks.tasks,
    aiFields,
    url: openPath(actor.workspaceId, `/companies/${company.id}`),
  };
}

export async function personSummary(db: Db, actor: UserActor, contactId: string) {
  const contact = await readContactInDb(db, contactId, actor.workspaceId);
  return contact ? personSummaryInDb(db, actor, contact) : null;
}

async function companySummary(db: Db, actor: UserActor, companyId: string) {
  const company = await readCompanyInDb(db, companyId, actor.workspaceId);
  return company ? companySummaryInDb(db, actor, company) : null;
}

function pageKind(url: string): PageKind {
  if (canonicalSalesNavigator(url)) return "lead";
  if (canonicalLinkedin(url)) return "person";
  if (canonicalCompanyLinkedin(url)) return "company";
  try {
    const parsed = new URL(url);
    if (/(^|\.)linkedin\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith("/messaging/")) return "conversation";
  } catch {
    return "other";
  }
  return "other";
}

function cleanLookupText(value: string | undefined, max = 200) {
  const text = value?.replace(/\s+/g, " ").trim().slice(0, max);
  return text && !looksLikeDateOrDuration(text) && !looksLikeEmploymentType(text) ? text : null;
}

async function contactIdsWhere(db: Db, workspaceId: string, column: "normalized_linkedin" | "sales_navigator_url", value: string) {
  const result = await db.query<{ id: string }>(
    `select c.id from crm.contacts c
     where c.workspace_id = $1 and c.archived_at is null and c.${column} = $2
     order by c.updated_at desc
     limit 1`,
    [workspaceId, value],
  );
  return result.rows[0]?.id ?? null;
}

async function companiesNamed(db: Db, workspaceId: string, name: string | null, linkedinUrl: string | null) {
  const normalized = name ? normalizeCompanyName(name) : "";
  if (!normalized && !linkedinUrl) return [];
  const result = await db.query<{ id: string }>(
    `select c.id from crm.companies c
     where c.workspace_id = $1 and c.archived_at is null
       and (($2::text <> '' and c.normalized_name = $2) or ($3::text is not null and c.linkedin_url = $3))
     limit 20`,
    [workspaceId, normalized, linkedinUrl],
  );
  return result.rows.map((row) => row.id);
}

async function possibleMatches(
  db: Db,
  workspaceId: string,
  input: { name: string | null; company: string | null; companyUrl: string | null; linkedinUrl: string | null; salesNavigatorUrl: string | null },
) {
  const key = input.name ? normalizePersonName(input.name) : "";
  if (!key) return [];
  const companyIds = await companiesNamed(db, workspaceId, input.company, input.companyUrl);
  if (companyIds.length === 0) return [];
  const result = await db.query<{ id: string; first_name: string | null; last_name: string | null; normalized_linkedin: string | null; sales_navigator_url: string | null }>(
    `select c.id, c.first_name, c.last_name, c.normalized_linkedin, c.sales_navigator_url
     from crm.contacts c
     where c.workspace_id = $1 and c.archived_at is null and c.company_id = any($2::uuid[])
     order by c.updated_at desc
     limit 500`,
    [workspaceId, companyIds],
  );
  const profile = input.linkedinUrl ? normalizedLinkedin(input.linkedinUrl) : null;
  return result.rows
    .filter((row) => normalizePersonName(`${row.first_name ?? ""} ${row.last_name ?? ""}`) === key)
    .filter((row) => !(profile && row.normalized_linkedin && row.normalized_linkedin !== profile))
    .filter((row) => !(input.salesNavigatorUrl && row.sales_navigator_url && row.sales_navigator_url !== input.salesNavigatorUrl))
    .slice(0, CANDIDATE_LIMIT)
    .map((row) => row.id);
}

function presenceFor(status: WorkspaceLookup["status"], person: PersonSummary | null, company: CompanySummary | null) {
  if (status === "maybe") return "Possible match";
  if (status === "none") return "Not in Orbit";
  if (person) return `In Orbit, saved ${person.addedLabel}`;
  return company ? "In Orbit" : "Not in Orbit";
}

async function lookupPerson(db: Db, actor: UserActor, kind: PageKind, query: LookupQuery) {
  const linkedinUrl = kind === "person" ? canonicalLinkedin(query.url) : query.linkedinUrl ? canonicalLinkedin(query.linkedinUrl) : null;
  const salesNavigatorUrl = kind === "lead" ? canonicalSalesNavigator(query.url) : null;
  let matchedOn: PersonMatch | null = null;
  let contactId: string | null = null;
  if (linkedinUrl) {
    contactId = await contactIdsWhere(db, actor.workspaceId, "normalized_linkedin", normalizedLinkedin(linkedinUrl));
    if (contactId) matchedOn = "linkedin";
  }
  if (!contactId && salesNavigatorUrl) {
    contactId = await contactIdsWhere(db, actor.workspaceId, "sales_navigator_url", salesNavigatorUrl);
    if (contactId) matchedOn = "sales_navigator";
  }
  if (contactId) {
    const person = await personSummary(db, actor, contactId);
    if (person) return { status: "in" as const, matchedOn, person, company: null, candidates: [], companyCandidates: [] };
  }
  const companyUrl = query.companyUrl ? canonicalCompanyLinkedin(query.companyUrl) : null;
  const ids = await possibleMatches(db, actor.workspaceId, {
    name: cleanLookupText(query.name),
    company: cleanLookupText(query.company),
    companyUrl,
    linkedinUrl,
    salesNavigatorUrl,
  });
  const candidates: PersonSummary[] = [];
  for (const id of ids) {
    const candidate = await personSummary(db, actor, id);
    if (candidate) candidates.push(candidate);
  }
  if (candidates.length > 0) return { status: "maybe" as const, matchedOn: "name" as const, person: null, company: null, candidates, companyCandidates: [] };
  return { status: "none" as const, matchedOn: null, person: null, company: null, candidates: [], companyCandidates: [] };
}

type CompanyCandidateRow = { id: string; linkedin_url: string | null; domain: string | null };

export type CompanyMatchResult = { found: { id: string; matchedOn: CompanyMatch } | null; candidates: string[] };

export async function matchCompany(
  db: Db,
  workspaceId: string,
  input: { linkedinUrl: string | null; domain: string | null; name: string | null },
): Promise<CompanyMatchResult> {
  const conflicts = (row: CompanyCandidateRow) =>
    Boolean((input.linkedinUrl && row.linkedin_url && row.linkedin_url !== input.linkedinUrl) || (input.domain && row.domain && row.domain !== input.domain));
  const attempts: [CompanyMatch, string, string | null][] = [
    ["linkedin", "c.linkedin_url = $2", input.linkedinUrl],
    ["domain", "c.domain = $2", input.domain],
    ["name", "c.normalized_name = $2", input.name ? normalizeCompanyName(input.name) || null : null],
  ];
  const candidates: string[] = [];
  for (const [matchedOn, condition, value] of attempts) {
    if (!value) continue;
    const result = await db.query<CompanyCandidateRow>(
      `select c.id, c.linkedin_url, c.domain from crm.companies c
       where c.workspace_id = $1 and c.archived_at is null and ${condition}
       order by c.updated_at desc
       limit 20`,
      [workspaceId, value],
    );
    for (const row of result.rows) {
      if (matchedOn !== "linkedin" && conflicts(row)) {
        if (!candidates.includes(row.id)) candidates.push(row.id);
        continue;
      }
      return { found: { id: row.id, matchedOn }, candidates: [] };
    }
  }
  return { found: null, candidates: candidates.slice(0, CANDIDATE_LIMIT) };
}

async function lookupCompany(db: Db, actor: UserActor, query: LookupQuery) {
  const match = await matchCompany(db, actor.workspaceId, {
    linkedinUrl: canonicalCompanyLinkedin(query.url),
    domain: query.domain ? canonicalDomain(query.domain) : null,
    name: cleanLookupText(query.name),
  });
  const company = match.found ? await companySummary(db, actor, match.found.id) : null;
  if (match.found && company) return { status: "in" as const, matchedOn: match.found.matchedOn, person: null, company, candidates: [], companyCandidates: [] };
  const companyCandidates: CompanySummary[] = [];
  for (const id of match.candidates) {
    const candidate = await companySummary(db, actor, id);
    if (candidate) companyCandidates.push(candidate);
  }
  if (companyCandidates.length > 0) return { status: "maybe" as const, matchedOn: "name" as const, person: null, company: null, candidates: [], companyCandidates };
  return { status: "none" as const, matchedOn: null, person: null, company: null, candidates: [], companyCandidates: [] };
}

export async function lookupPage(actors: UserActor[], query: LookupQuery): Promise<LookupResponse> {
  const url = typeof query.url === "string" ? query.url.slice(0, 2000) : "";
  const kind = pageKind(url);
  const canonical =
    kind === "person" ? canonicalLinkedin(url) : kind === "lead" ? canonicalSalesNavigator(url) : kind === "company" ? canonicalCompanyLinkedin(url) : null;
  if (kind === "other" || kind === "conversation") return { kind, url: canonical, workspaces: [] };
  const settled = await Promise.allSettled(
    actors.map((actor) =>
      withActor(actor, async (db): Promise<WorkspaceLookup> => {
        const found = kind === "company" ? await lookupCompany(db, actor, query) : await lookupPerson(db, actor, kind, query);
        return {
          workspaceId: actor.workspaceId,
          workspaceName: actor.workspaceName,
          ...found,
          presence: presenceFor(found.status, found.person, found.company),
        };
      }),
    ),
  );
  const workspaces = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (workspaces.length === 0 && settled[0]?.status === "rejected") throw settled[0].reason;
  return { kind, url: canonical, workspaces };
}

export async function workspaceOptions(actor: UserActor): Promise<ExtensionWorkspace> {
  return withActor(actor, async (db) => {
    const members = await db.query<{ id: string; name: string }>(
      `select p.id, coalesce(nullif(p.full_name, ''), p.email, 'Member') as name
       from crm.workspace_members m join crm.profiles p on p.id = m.user_id
       where m.workspace_id = $1
       order by (p.id = $2) desc, 2`,
      [actor.workspaceId, actor.userId],
    );
    const pipelines = await db.query<{ id: string; name: string; kind: "sales" | "board" }>(
      `select p.id, p.name, p.kind from crm.pipelines p
       where p.workspace_id = $1 and p.archived_at is null and (p.kind = 'board' or p.is_default)
       order by (p.kind = 'sales') desc, p.position asc, p.created_at asc`,
      [actor.workspaceId],
    );
    const stages = await db.query<{ id: string; pipeline_id: string; name: string }>(
      `select s.id, s.pipeline_id, s.name from crm.pipeline_stages s
       join crm.pipelines p on p.id = s.pipeline_id
       where p.workspace_id = $1 and p.archived_at is null and not s.is_won and not s.is_lost
       order by s.position asc`,
      [actor.workspaceId],
    );
    const lifecycles = await db.query<{ lifecycle: string }>(
      `select distinct c.lifecycle from crm.companies c where c.workspace_id = $1 and c.archived_at is null limit 60`,
      [actor.workspaceId],
    );
    const boards: ExtensionBoard[] = pipelines.rows.map((pipeline) => ({
      id: pipeline.id,
      name: pipeline.name,
      kind: pipeline.kind,
      stages: stages.rows.filter((stage) => stage.pipeline_id === pipeline.id).map((stage) => ({ id: stage.id, name: stage.name })),
    }));
    const custom = lifecycles.rows.map((row) => row.lifecycle).filter((value) => !(LIFECYCLES as readonly string[]).includes(value)).sort();
    return {
      id: actor.workspaceId,
      name: actor.workspaceName,
      role: actor.role,
      members: members.rows,
      boards,
      lifecycles: [...LIFECYCLES, ...custom].map((value) => ({ value, label: lifecycleLabel(value) })),
    };
  });
}
