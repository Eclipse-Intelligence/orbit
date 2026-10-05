import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import {
  ACTIVITY_TYPES,
  COMPANY_SORTS,
  LIFECYCLES,
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

export const companyWriteSchema = z
  .object({
    name: z.string().optional(),
    domain: nullableText,
    website: nullableText,
    description: nullableText,
    industry: nullableText,
    sizeCategory: nullableText,
    lifecycle: z.enum(LIFECYCLES).optional(),
    ownerId: z.uuid().nullable().optional(),
    source: nullableText,
    sourceReference: nullableText,
  })
  .strict();

export const provenanceSchema = z
  .object({
    source: nullableText,
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
    throw new CrmError("invalid_input", "The request body is invalid.", 400, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
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

export function companyQueryFromSearchParams(
  params: URLSearchParams,
): CompanyListQuery {
  const lifecycle = params.get("lifecycle") ?? undefined;
  const sort = params.get("sort") ?? undefined;
  const order = params.get("order") ?? undefined;
  const owner = params.get("owner_id") ?? params.get("owner") ?? undefined;
  const limit = params.get("limit");
  const offset = params.get("offset");
  const query: CompanyListQuery = {};

  const text = params.get("q")?.trim();
  if (text) query.query = text;
  if (lifecycle && (LIFECYCLES as readonly string[]).includes(lifecycle)) {
    query.lifecycle = lifecycle as CompanyListQuery["lifecycle"];
  }
  if (sort && (COMPANY_SORTS as readonly string[]).includes(sort)) {
    query.sort = sort as CompanyListQuery["sort"];
  }
  if (order === "asc" || order === "desc") query.order = order;
  if (owner === "unassigned") query.ownerId = "unassigned";
  else if (owner && owner !== "all") query.ownerId = owner;
  if (params.get("include_archived") === "true") query.includeArchived = true;
  if (limit && Number.isFinite(Number(limit))) query.limit = Number(limit);
  if (offset && Number.isFinite(Number(offset))) query.offset = Number(offset);
  return query;
}

export const contactWriteSchema = z
  .object({
    companyId: z.uuid().nullable().optional(),
    firstName: nullableText,
    lastName: nullableText,
    email: nullableText,
    phone: nullableText,
    jobTitle: nullableText,
    linkedinUrl: nullableText,
    ownerId: z.uuid().nullable().optional(),
    source: nullableText,
    sourceReference: nullableText,
    notes: nullableText,
  })
  .strict();

export const opportunityWriteSchema = z
  .object({
    companyId: z.uuid().optional(),
    primaryContactId: z.uuid().nullable().optional(),
    stageId: z.uuid().nullable().optional(),
    name: z.string().optional(),
    value: z.union([z.string(), z.number()]).nullable().optional(),
    currency: nullableText,
    probability: z.number().int().nullable().optional(),
    expectedCloseDate: nullableText,
    ownerId: z.uuid().nullable().optional(),
    status: z.enum(OPPORTUNITY_STATUSES).optional(),
    source: nullableText,
  })
  .strict();

export const activityWriteSchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES).optional(),
    title: nullableText,
    body: nullableText,
    occurredAt: nullableText,
    companyId: z.uuid().nullable().optional(),
    contactId: z.uuid().nullable().optional(),
    opportunityId: z.uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export const taskWriteSchema = z
  .object({
    title: z.string().optional(),
    description: nullableText,
    dueAt: nullableText,
    priority: z.enum(TASK_PRIORITIES).optional(),
    ownerId: z.uuid().nullable().optional(),
    companyId: z.uuid().nullable().optional(),
    contactId: z.uuid().nullable().optional(),
    opportunityId: z.uuid().nullable().optional(),
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
  const limit = params.get("limit");
  const offset = params.get("offset");
  return {
    limit: limit && Number.isFinite(Number(limit)) ? Number(limit) : undefined,
    offset: offset && Number.isFinite(Number(offset)) ? Number(offset) : undefined,
  };
}

export function contactQueryFromSearchParams(params: URLSearchParams): ContactListQuery {
  const query: ContactListQuery = {};
  const text = params.get("q")?.trim();
  if (text) query.query = text;
  const companyId = params.get("company_id");
  if (companyId) query.companyId = companyId;
  const owner = params.get("owner_id") ?? params.get("owner");
  if (owner === "unassigned") query.ownerId = "unassigned";
  else if (owner && owner !== "all") query.ownerId = owner;
  if (params.get("include_archived") === "true") query.includeArchived = true;
  return { ...query, ...paging(params) };
}

export function opportunityQueryFromSearchParams(params: URLSearchParams): OpportunityListQuery {
  const query: OpportunityListQuery = {};
  const text = params.get("q")?.trim();
  if (text) query.query = text;
  const companyId = params.get("company_id");
  if (companyId) query.companyId = companyId;
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
  const companyId = params.get("company_id");
  if (companyId) query.companyId = companyId;
  const contactId = params.get("contact_id");
  if (contactId) query.contactId = contactId;
  const opportunityId = params.get("opportunity_id");
  if (opportunityId) query.opportunityId = opportunityId;
  const type = params.get("type");
  if (type && (ACTIVITY_TYPES as readonly string[]).includes(type)) {
    query.type = type as ActivityListQuery["type"];
  }
  return { ...query, ...paging(params) };
}

export function taskQueryFromSearchParams(params: URLSearchParams): TaskListQuery {
  const query: TaskListQuery = {};
  const text = params.get("q")?.trim();
  if (text) query.query = text;
  const companyId = params.get("company_id");
  if (companyId) query.companyId = companyId;
  const owner = params.get("owner_id") ?? params.get("owner");
  if (owner === "unassigned") query.ownerId = "unassigned";
  else if (owner && owner !== "all") query.ownerId = owner;
  const view = params.get("view");
  if (view && (TASK_VIEWS as readonly string[]).includes(view)) query.view = view as TaskView;
  if (params.get("include_archived") === "true") query.includeArchived = true;
  return { ...query, ...paging(params) };
}
