import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { cleanLifecycle } from "@/lib/companies";
import { aiFiltersFromParams, aiSortField } from "@/lib/ai-fields/params";
import { normalizeTag } from "@/lib/crm/normalize";
import { appTimeZone, readDateTime, startOfDay } from "@/lib/time";
import { parseDateValue } from "@/lib/date-input";
import {
  ACTIVITY_TYPES,
  COMPANY_PRESENCE,
  COMPANY_SORTS,
  CONTACT_PRESENCE,
  CONTACT_SORTS,
  ACCOUNT_HEALTH,
  OPPORTUNITY_STATUSES,
  TASK_PRIORITIES,
  TASK_VIEWS,
  type ActivityListQuery,
  type CompanyListQuery,
  type CompanyWrite,
  type ContactListQuery,
  type OpportunityListQuery,
  type Provenance,
  type TaskListQuery,
  type TaskView,
} from "@/lib/crm/types";

const nullableText = z.string().nullable().optional();

export const SYSTEM_SOURCES = [
  "web",
  "email",
  "assistant",
  "mcp",
  "api",
  "clickup",
  "workflow",
  "communication",
  "microsoft",
  "microsoft_teams",
  "teams",
  "granola",
  "mail",
  "mail_share",
  "chat",
  "task_outcome",
  "backfill",
  "meta_lead_ad",
  "booking",
  "proposal_page",
  "meeting",
  "parallel",
  "readwise",
  "activity_pad",
  "shortcut",
  "contact_email",
  "csv",
  "linkedin_extension",
  "context.dev",
  "enrichment",
  "context",
  "hunter",
  "enrow",
  "icypeas",
] as const;

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g;

export function agentSource(source: string | null | undefined) {
  if (typeof source !== "string") return source;
  const plain = source.normalize("NFKC").replace(INVISIBLE, "").trim().toLowerCase();
  return (SYSTEM_SOURCES as readonly string[]).includes(plain) ? null : source;
}

const LEADING_DATE = /^\s*(\d{4}-\d{2}-\d{2})(?![\d])/;

export function hasImpossibleDate(value: string) {
  const match = LEADING_DATE.exec(value);
  return Boolean(match && !parseDateValue(match[1]));
}

export function assertCalendarDate(value: string | null | undefined, field: string) {
  if (typeof value === "string" && hasImpossibleDate(value)) {
    throw new CrmError("invalid_input", `${field}: enter a real calendar date, such as 2026-11-03.`, 400, { field });
  }
}

const nullableDate = z
  .string()
  .nullable()
  .optional()
  .refine((value) => typeof value !== "string" || !hasImpossibleDate(value), {
    message: "Enter a real calendar date, such as 2026-11-03.",
  });
const tagList = z.array(z.string().max(200)).max(100).nullable().optional();

const companyWriteSchema = z
  .object({
    name: z.string().optional(),
    domain: nullableText,
    website: nullableText,
    description: nullableText,
    industry: nullableText,
    sizeCategory: nullableText,
    linkedinUrl: nullableText,
    lifecycle: z.string().max(200).optional(),
    health: z.enum(ACCOUNT_HEALTH).nullable().optional(),
    healthReason: nullableText,
    ownerId: z.uuid().nullable().optional(),
    source: nullableText,
    sourceReference: nullableText,
    tags: tagList,
  })
  .strict();

const provenanceSchema = z
  .object({
    source: nullableText.transform(agentSource),
    sourceUrl: nullableText,
  })
  .strict();

export const companyMutationSchema = companyWriteSchema
  .extend({ provenance: provenanceSchema.optional() })
  .strict();

export const bulkCompanySchema = z
  .object({
    companies: z.array(companyWriteSchema).min(1).max(50),
    provenance: provenanceSchema.optional(),
  })
  .strict();

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    const first = issues[0];
    throw new CrmError(
      "invalid_input",
      first?.path ? `The request body is invalid: ${first.path}. ${first.message}` : "The request body is invalid.",
      400,
      { issues, ...(first?.path ? { field: first.path } : {}) },
    );
  }
  return result.data;
}

export function integerParam(params: URLSearchParams, name: string) {
  const value = params.get(name)?.trim();
  if (!value) return undefined;
  if (!/^-?\d{1,9}$/.test(value)) {
    throw new CrmError("invalid_input", `${name} must be a whole number.`, 400, { field: name });
  }
  return Number(value);
}

export function splitProvenance(input: {
  provenance?: { source?: string | null; sourceUrl?: string | null };
}): { write: CompanyWrite; provenance?: Provenance } {
  const { provenance, ...write } = input;
  return {
    write,
    provenance: provenance
      ? {
          operation: "api",
          source: provenance.source,
          sourceUrl: provenance.sourceUrl,
        }
      : undefined,
  };
}

function uuidParam(params: URLSearchParams, name: string) {
  const value = params.get(name);
  if (!value) return undefined;
  if (!isUuid(value)) {
    throw new CrmError("invalid_input", `${name} must be a UUID.`, 400, { field: name });
  }
  return value;
}

function ownerParam(params: URLSearchParams) {
  const owner = params.get("owner_id") ?? params.get("owner");
  if (!owner || owner === "all") return undefined;
  if (owner === "unassigned") return owner;
  if (!isUuid(owner)) {
    throw new CrmError("invalid_input", "owner_id must be a UUID.", 400, { field: "owner_id" });
  }
  return owner;
}

function tagParam(params: URLSearchParams) {
  const tag = normalizeTag(params.get("tag") ?? "").slice(0, 200);
  return tag || undefined;
}

export function companyQueryFromSearchParams(
  params: URLSearchParams,
): CompanyListQuery {
  const lifecycle = params.get("lifecycle") ?? undefined;
  const sort = params.get("sort") ?? undefined;
  const order = params.get("order") ?? undefined;
  const owner = ownerParam(params);
  const limit = integerParam(params, "limit");
  const offset = integerParam(params, "offset");
  const query: CompanyListQuery = {};

  const text = params.get("q")?.trim();
  if (text) query.query = text;
  const chosenLifecycle = lifecycle ? cleanLifecycle(lifecycle) : null;
  if (chosenLifecycle) query.lifecycle = chosenLifecycle;
  const health = params.get("health");
  if (health === "none" || (health && (ACCOUNT_HEALTH as readonly string[]).includes(health))) {
    query.health = health as CompanyListQuery["health"];
  }
  if (sort && (COMPANY_SORTS as readonly string[]).includes(sort)) {
    query.sort = sort as CompanyListQuery["sort"];
  }
  const aiSort = aiSortField(sort);
  if (aiSort) query.aiSort = aiSort;
  if (order === "asc" || order === "desc") query.order = order;
  const ai = aiFiltersFromParams(params);
  if (ai.length > 0) query.ai = ai;
  const has = presenceList(params, "has", COMPANY_PRESENCE);
  if (has) query.has = has;
  const missing = presenceList(params, "missing", COMPANY_PRESENCE)?.filter((field) => !has?.includes(field));
  if (missing?.length) query.missing = missing;
  if (owner) query.ownerId = owner;
  const tag = tagParam(params);
  if (tag) query.tag = tag;
  if (params.get("quiet") === "true") query.quiet = true;
  if (params.get("include_archived") === "true") query.includeArchived = true;
  if (limit !== undefined) query.limit = limit;
  if (offset !== undefined) query.offset = offset;
  return query;
}

const contactWriteSchema = z
  .object({
    companyId: z.uuid().nullable().optional(),
    firstName: nullableText,
    lastName: nullableText,
    email: nullableText,
    phone: nullableText,
    jobTitle: nullableText,
    linkedinUrl: nullableText,
    location: nullableText,
    salesNavigatorUrl: nullableText,
    ownerId: z.uuid().nullable().optional(),
    source: nullableText,
    sourceReference: nullableText,
    notes: nullableText,
    tags: tagList,
  })
  .strict();

const opportunityWriteSchema = z
  .object({
    companyId: z.uuid().optional(),
    pipelineId: z.uuid().nullable().optional(),
    primaryContactId: z.uuid().nullable().optional(),
    stageId: z.uuid().nullable().optional(),
    name: z.string().optional(),
    value: z.union([z.string(), z.number()]).nullable().optional(),
    currency: nullableText,
    probability: z.number().int().nullable().optional(),
    expectedCloseDate: nullableDate,
    ownerId: z.uuid().nullable().optional(),
    status: z.enum(OPPORTUNITY_STATUSES).optional(),
    source: nullableText,
  })
  .strict();

const activityWriteSchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES).optional(),
    title: nullableText,
    body: nullableText,
    occurredAt: nullableDate,
    companyId: z.uuid().nullable().optional(),
    contactId: z.uuid().nullable().optional(),
    opportunityId: z.uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const taskWriteSchema = z
  .object({
    title: z.string().optional(),
    description: nullableText,
    dueAt: nullableDate,
    dueDate: nullableDate,
    dueHasTime: z.boolean().optional(),
    durationMinutes: z.number().int().optional(),
    remindMinutes: z.number().int().nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    ownerId: z.uuid().nullable().optional(),
    companyId: z.uuid().nullable().optional(),
    contactId: z.uuid().nullable().optional(),
    opportunityId: z.uuid().nullable().optional(),
    mailThreadKey: z.string().max(500).nullable().optional(),
    completed: z.boolean().optional(),
  })
  .strict();

export const contactMutationSchema = contactWriteSchema
  .extend({ provenance: provenanceSchema.optional() })
  .strict();

export const opportunityMutationSchema = opportunityWriteSchema
  .extend({ provenance: provenanceSchema.optional() })
  .strict();

export const activityMutationSchema = activityWriteSchema
  .extend({ provenance: provenanceSchema.optional() })
  .strict();

export const taskMutationSchema = taskWriteSchema
  .extend({ provenance: provenanceSchema.optional() })
  .strict();

export const leadSchema = z
  .object({
    company: companyWriteSchema.optional(),
    contact: contactWriteSchema.optional(),
    note: nullableText,
    activity: activityWriteSchema.optional(),
    opportunity: opportunityWriteSchema.optional(),
    task: taskWriteSchema.optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

export const bulkLeadSchema = z
  .object({
    leads: z
      .array(
        leadSchema.omit({ provenance: true }).extend({
          activity: activityWriteSchema.extend({ occurredAt: nullableText }).optional(),
          opportunity: opportunityWriteSchema.extend({ expectedCloseDate: nullableText }).optional(),
          task: taskWriteSchema.extend({ dueAt: nullableText, dueDate: nullableText }).optional(),
        }),
      )
      .min(1)
      .max(50),
    provenance: provenanceSchema.optional(),
  })
  .strict();

export const communicationSchema = z
  .object({
    kind: z.enum(["email", "meeting"]),
    title: nullableText,
    body: nullableText,
    occurredAt: nullableDate,
    participantEmails: z.array(z.string().max(200)).max(20).optional(),
    companyId: z.uuid().nullable().optional(),
    contactId: z.uuid().nullable().optional(),
  })
  .strict();

export const webhookSchema = z
  .object({
    url: z.string().max(500),
    events: z.array(z.string().max(80)).min(1).max(30),
    description: nullableText,
  })
  .strict();

export const pipelineStagesSchema = z
  .object({
    stages: z
      .array(
        z
          .object({
            id: z.uuid().optional(),
            name: z.string(),
            probability: z.number().int().optional(),
            isWon: z.boolean().optional(),
            isLost: z.boolean().optional(),
          })
          .strict(),
      )
      .min(2)
      .max(20),
  })
  .strict();

export function takeProvenance<T extends { provenance?: { source?: string | null; sourceUrl?: string | null } }>(
  input: T,
  operation: string,
): { write: Omit<T, "provenance">; provenance: Provenance } {
  const { provenance, ...write } = input;
  return {
    write: write as Omit<T, "provenance">,
    provenance: {
      operation,
      source: provenance?.source,
      sourceUrl: provenance?.sourceUrl,
    },
  };
}

function paging(params: URLSearchParams) {
  return {
    limit: integerParam(params, "limit"),
    offset: integerParam(params, "offset"),
  };
}

function presenceList<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[]) {
  const values = (params.get(key) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is T => (allowed as readonly string[]).includes(value));
  return values.length > 0 ? [...new Set(values)] : undefined;
}

export function contactQueryFromSearchParams(params: URLSearchParams): ContactListQuery {
  const query: ContactListQuery = {};
  const sort = params.get("sort");
  if (sort && (CONTACT_SORTS as readonly string[]).includes(sort)) query.sort = sort as ContactListQuery["sort"];
  const order = params.get("order");
  if (order === "asc" || order === "desc") query.order = order;
  const has = presenceList(params, "has", CONTACT_PRESENCE);
  if (has) query.has = has;
  const missing = presenceList(params, "missing", CONTACT_PRESENCE)?.filter((field) => !has?.includes(field));
  if (missing?.length) query.missing = missing;
  const text = params.get("q")?.trim();
  if (text) query.query = text;
  const companyId = uuidParam(params, "company_id");
  if (companyId) query.companyId = companyId;
  const owner = ownerParam(params);
  if (owner) query.ownerId = owner;
  const tag = tagParam(params);
  if (tag) query.tag = tag;
  if (params.get("include_archived") === "true") query.includeArchived = true;
  return { ...query, ...paging(params) };
}

export function opportunityQueryFromSearchParams(params: URLSearchParams): OpportunityListQuery {
  const query: OpportunityListQuery = {};
  const text = params.get("q")?.trim();
  if (text) query.query = text;
  const companyId = uuidParam(params, "company_id");
  if (companyId) query.companyId = companyId;
  const pipelineId = uuidParam(params, "pipeline_id");
  if (pipelineId) query.pipelineId = pipelineId;
  const status = params.get("status");
  if (status && (OPPORTUNITY_STATUSES as readonly string[]).includes(status)) {
    query.status = status as OpportunityListQuery["status"];
  }
  if (params.get("include_archived") === "true") query.includeArchived = true;
  return { ...query, ...paging(params) };
}

export function activityQueryFromSearchParams(params: URLSearchParams): ActivityListQuery {
  const query: ActivityListQuery = {};
  const text = params.get("q")?.trim();
  if (text) query.query = text;
  const companyId = uuidParam(params, "company_id");
  if (companyId) query.companyId = companyId;
  const contactId = uuidParam(params, "contact_id");
  if (contactId) query.contactId = contactId;
  const opportunityId = uuidParam(params, "opportunity_id");
  if (opportunityId) query.opportunityId = opportunityId;
  const type = params.get("type");
  if (type && (ACTIVITY_TYPES as readonly string[]).includes(type)) {
    query.type = type as ActivityListQuery["type"];
  }
  const actorUserId = uuidParam(params, "actor_user_id");
  if (actorUserId) query.actorUserId = actorUserId;
  const actorAgentId = uuidParam(params, "actor_agent_id");
  if (actorAgentId) query.actorAgentId = actorAgentId;
  const from = dateBound(params, "from", false);
  if (from) query.from = from;
  const to = dateBound(params, "to", true);
  if (to) query.to = to;
  return { ...query, ...paging(params) };
}

function dateBound(params: URLSearchParams, name: string, end: boolean) {
  const value = params.get(name)?.trim();
  if (!value) return undefined;
  const reading = readDateTime(value);
  if (!reading.ok) {
    throw new CrmError("invalid_input", `${name} must be a date, such as 2026-11-03, or a date and time. ${reading.error}`, 400, { field: name });
  }
  return (end && reading.dateOnly ? startOfDay(reading.date, appTimeZone(), 1) : reading.date).toISOString();
}

export function taskQueryFromSearchParams(params: URLSearchParams): TaskListQuery {
  const query: TaskListQuery = {};
  const text = params.get("q")?.trim();
  if (text) query.query = text;
  const companyId = uuidParam(params, "company_id");
  if (companyId) query.companyId = companyId;
  const owner = ownerParam(params);
  if (owner) query.ownerId = owner;
  const view = params.get("view");
  if (view && (TASK_VIEWS as readonly string[]).includes(view)) query.view = view as TaskView;
  if (params.get("include_archived") === "true") query.includeArchived = true;
  return { ...query, ...paging(params) };
}
