import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import {
  COMPANY_SORTS,
  LIFECYCLES,
  type CompanyListQuery,
  type CompanyWrite,
  type Provenance,
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
