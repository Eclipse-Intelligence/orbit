export type { MutationOptions, MutationOutcome } from "@/lib/crm/mutate";

import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError } from "@/lib/crm/errors";
import {
  assertOwner,
  iso,
  isUuid,
  lockNamespace,
  recordAudit,
  replayOrRun,
  requestHash,
  type MutationOptions,
  type MutationOutcome,
} from "@/lib/crm/mutate";
import { likePattern, normalizeCompanyName, normalizeCompanyWrite } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type {
  Actor,
  BulkItemResult,
  Company,
  CompanyListQuery,
  CompanySort,
  CompanyWrite,
  Lifecycle,
  Member,
  Provenance,
  UpsertResult,
  WorkspaceRole,
} from "@/lib/crm/types";

const COMPANY_SQL = `
  select
    c.id,
    c.workspace_id,
    c.name,
    c.normalized_name,
    c.domain,
    c.website,
    c.description,
    c.industry,
    c.size_category,
    c.lifecycle,
    c.owner_id,
    p.full_name as owner_name,
    p.email as owner_email,
    c.source,
    c.source_reference,
    c.created_by_user_id,
    c.created_by_agent_id,
    c.archived_at,
    c.created_at,
    c.updated_at
  from crm.companies c
  left join crm.profiles p on p.id = c.owner_id
`;

type CompanyRow = {
  id: string;
  workspace_id: string;
  name: string;
  normalized_name: string;
  domain: string | null;
  website: string | null;
  description: string | null;
  industry: string | null;
  size_category: string | null;
  lifecycle: Lifecycle;
  owner_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
  source: string | null;
  source_reference: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const SORT_COLUMNS: Record<CompanySort, string> = {
  name: "c.name",
  domain: "c.domain",
  updated: "c.updated_at",
  created: "c.created_at",
};

function mapCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    normalizedName: row.normalized_name,
    domain: row.domain,
    website: row.website,
    description: row.description,
    industry: row.industry,
    sizeCategory: row.size_category,
    lifecycle: row.lifecycle,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    source: row.source,
    sourceReference: row.source_reference,
    createdByUserId: row.created_by_user_id,
    createdByAgentId: row.created_by_agent_id,
    archivedAt: iso(row.archived_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export async function readCompanyInDb(db: Db, id: string) {
  const result = await db.query<CompanyRow>(`${COMPANY_SQL} where c.id = $1`, [id]);
  return result.rows[0] ? mapCompany(result.rows[0]) : null;
}

async function readCompany(db: Db, id: string) {
  return readCompanyInDb(db, id);
}

function lockCompanies(db: Db, workspaceId: string) {
  return lockNamespace(db, workspaceId, "companies");
}

async function findMatch(
  db: Db,
  workspaceId: string,
  domain: string | null,
  normalizedName: string | null,
) {
  if (!domain && !normalizedName) return null;
  const result = await db.query<CompanyRow>(
    `${COMPANY_SQL}
     where c.workspace_id = $1
       and c.archived_at is null
       and (
         ($2::text is not null and c.domain = $2)
         or ($3::text is not null and c.normalized_name = $3 and c.domain is null)
       )
     order by case when $2::text is not null and c.domain = $2 then 0 else 1 end,
              c.updated_at desc
     limit 1`,
    [workspaceId, domain, normalizedName],
  );
  const row = result.rows[0];
  if (!row) return null;
  const matchedOn = domain && row.domain === domain ? "domain" : "name";
  return { company: mapCompany(row), matchedOn } as const;
}

async function insertCompany(
  db: Db,
  actor: Actor,
  write: CompanyWrite & { normalizedName?: string },
  provenance?: Provenance,
) {
  await assertOwner(db, actor.workspaceId, write.ownerId);
  if (!write.name || !write.normalizedName) {
    throw new CrmError("invalid_input", "Enter a company name.", 400, {
      field: "name",
    });
  }
  try {
    const inserted = await db.query<{ id: string }>(
      `insert into crm.companies (
        workspace_id, name, normalized_name, domain, website, description,
        industry, size_category, lifecycle, owner_id, source, source_reference,
        created_by_user_id, created_by_agent_id
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      ) returning id`,
      [
        actor.workspaceId,
        write.name,
        write.normalizedName,
        write.domain ?? null,
        write.website ?? null,
        write.description ?? null,
        write.industry ?? null,
        write.sizeCategory ?? null,
        write.lifecycle ?? "lead",
        write.ownerId ?? null,
        write.source ?? null,
        write.sourceReference ?? null,
        actor.type === "user" ? actor.userId : null,
        actor.type === "agent" ? actor.agentId : null,
      ],
    );
    const company = await readCompany(db, inserted.rows[0].id);
    if (!company) throw new CrmError("internal_error", "Company was not saved.", 500);
    await recordAudit(db, actor, "company.created", "company", company.id, provenance, {
      after: company,
    });
    return company;
  } catch (error) {
    if (error instanceof CrmError) throw error;
    if (isPgError(error) && error.code === "23505") {
      throw new CrmError("duplicate_company", "A matching company already exists.", 409);
    }
    throw error;
  }
}

function assignments(write: CompanyWrite & { normalizedName?: string }) {
  const sets: string[] = [];
  const values: unknown[] = [];
  const fields: string[] = [];

  function add(column: string, field: string, value: unknown) {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
    fields.push(field);
  }

  if (write.name !== undefined && write.normalizedName) {
    add("name", "name", write.name);
    values.push(write.normalizedName);
    sets.push(`normalized_name = $${values.length}`);
  }
  if (write.domain !== undefined) add("domain", "domain", write.domain);
  if (write.website !== undefined) add("website", "website", write.website);
  if (write.description !== undefined) add("description", "description", write.description);
  if (write.industry !== undefined) add("industry", "industry", write.industry);
  if (write.sizeCategory !== undefined) {
    add("size_category", "sizeCategory", write.sizeCategory);
  }
  if (write.lifecycle !== undefined) add("lifecycle", "lifecycle", write.lifecycle);
  if (write.ownerId !== undefined) add("owner_id", "ownerId", write.ownerId);
  if (write.source !== undefined) add("source", "source", write.source);
  if (write.sourceReference !== undefined) {
    add("source_reference", "sourceReference", write.sourceReference);
  }

  return { sets, values, fields };
}

async function applyUpdate(
  db: Db,
  actor: Actor,
  current: Company,
  write: CompanyWrite & { normalizedName?: string },
  provenance: Provenance | undefined,
  eventType: string,
) {
  await assertOwner(db, actor.workspaceId, write.ownerId);
  const nextName = write.normalizedName ?? current.normalizedName;
  const nextDomain = write.domain === undefined ? current.domain : write.domain;
  const conflict = await findMatch(db, actor.workspaceId, nextDomain, nextName);
  if (conflict && conflict.company.id !== current.id) {
    throw new CrmError("duplicate_company", "A matching company already exists.", 409, {
      existingId: conflict.company.id,
      matchedOn: conflict.matchedOn,
    });
  }

  const change = assignments(write);
  if (change.sets.length === 0) return { company: current, changed: false };

  try {
    change.values.push(current.id);
    await db.query(
      `update crm.companies set ${change.sets.join(", ")} where id = $${change.values.length}`,
      change.values,
    );
  } catch (error) {
    if (isPgError(error) && error.code === "23505") {
      throw new CrmError("duplicate_company", "A matching company already exists.", 409);
    }
    throw error;
  }

  const company = await readCompany(db, current.id);
  if (!company) throw new CrmError("not_found", "Company not found.", 404);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of change.fields) {
    before[field] = current[field as keyof Company];
    after[field] = company[field as keyof Company];
  }
  await recordAudit(db, actor, eventType, "company", company.id, provenance, {
    fields: change.fields,
    before,
    after,
  });
  return { company, changed: true };
}

async function createInTransaction(
  db: Db,
  actor: Actor,
  write: CompanyWrite & { normalizedName?: string },
  provenance?: Provenance,
) {
  await lockCompanies(db, actor.workspaceId);
  const match = await findMatch(
    db,
    actor.workspaceId,
    write.domain ?? null,
    write.normalizedName ?? null,
  );
  if (match) {
    throw new CrmError("duplicate_company", "A matching company already exists.", 409, {
      existingId: match.company.id,
      matchedOn: match.matchedOn,
    });
  }
  return insertCompany(db, actor, write, provenance);
}

async function upsertInTransaction(
  db: Db,
  actor: Actor,
  write: CompanyWrite & { normalizedName?: string },
  provenance?: Provenance,
): Promise<UpsertResult & { changed: boolean }> {
  await lockCompanies(db, actor.workspaceId);
  const match = await findMatch(
    db,
    actor.workspaceId,
    write.domain ?? null,
    write.normalizedName ?? null,
  );
  if (!match) {
    const toInsert =
      write.name && write.normalizedName
        ? write
        : {
            ...write,
            name: write.domain ?? write.website ?? "Company",
            normalizedName: normalizeCompanyName(write.domain ?? write.name ?? "company"),
          };
    const company = await insertCompany(db, actor, toInsert, provenance);
    return { company, created: true, matchedOn: null, changed: true };
  }
  const updated = await applyUpdate(
    db,
    actor,
    match.company,
    write,
    provenance,
    "company.updated",
  );
  return {
    company: updated.company,
    created: false,
    matchedOn: match.matchedOn,
    changed: updated.changed,
  };
}

export async function upsertCompanyInDb(
  db: Db,
  actor: Actor,
  input: CompanyWrite,
  provenance?: Provenance,
) {
  const write = normalizeCompanyWrite(input, "upsert");
  return upsertInTransaction(db, actor, write, provenance);
}

export async function listCompanies(actor: Actor, query: CompanyListQuery = {}) {
  assertScope(actor.scopes, "crm:read");
  const limit = Math.min(100, Math.max(1, query.limit ?? 50));
  const offset = Math.min(10_000, Math.max(0, query.offset ?? 0));
  const sort = query.sort ?? "updated";
  const order =
    query.order ?? (sort === "name" || sort === "domain" ? "asc" : "desc");
  const direction = order === "asc" ? "asc" : "desc";
  const nulls = sort === "domain" ? " nulls last" : "";

  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["c.workspace_id = $1"];
    if (!query.includeArchived) where.push("c.archived_at is null");
    if (query.lifecycle) {
      values.push(query.lifecycle);
      where.push(`c.lifecycle = $${values.length}`);
    }
    if (query.ownerId === "unassigned") where.push("c.owner_id is null");
    else if (query.ownerId) {
      values.push(query.ownerId);
      where.push(`c.owner_id = $${values.length}`);
    }
    const text = query.query?.trim();
    if (text) {
      values.push(likePattern(text.slice(0, 200)));
      const ref = `$${values.length}`;
      where.push(`(
        c.name ilike ${ref} escape '\\'
        or coalesce(c.domain, '') ilike ${ref} escape '\\'
        or coalesce(c.industry, '') ilike ${ref} escape '\\'
        or c.normalized_name ilike ${ref} escape '\\'
      )`);
    }
    const whereSql = where.join(" and ");
    const count = await db.query<{ total: number }>(
      `select count(*)::int as total from crm.companies c where ${whereSql}`,
      values,
    );
    const listed = [...values, limit, offset];
    const rows = await db.query<CompanyRow>(
      `${COMPANY_SQL}
       where ${whereSql}
       order by ${SORT_COLUMNS[sort]} ${direction}${nulls}, c.id asc
       limit $${listed.length - 1} offset $${listed.length}`,
      listed,
    );
    return {
      data: rows.rows.map(mapCompany),
      total: count.rows[0]?.total ?? 0,
      limit,
      offset,
    };
  });
}

export async function countCompanies(actor: Actor) {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<{ total: number }>(
      `select count(*)::int as total
       from crm.companies
       where workspace_id = $1 and archived_at is null`,
      [actor.workspaceId],
    );
    return result.rows[0]?.total ?? 0;
  });
}

export async function listMembers(actor: Actor): Promise<Member[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<{
      id: string;
      full_name: string | null;
      email: string | null;
      role: WorkspaceRole;
    }>(
      `select p.id, p.full_name, p.email, m.role
       from crm.workspace_members m
       join crm.profiles p on p.id = m.user_id
       where m.workspace_id = $1
       order by coalesce(nullif(p.full_name, ''), p.email)`,
      [actor.workspaceId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.full_name || row.email || "Member",
      email: row.email,
      role: row.role,
    }));
  });
}

export async function getCompany(actor: Actor, id: string) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw new CrmError("not_found", "Company not found.", 404);
  return withActor(actor, async (db) => {
    const company = await readCompany(db, id);
    if (!company) throw new CrmError("not_found", "Company not found.", 404);
    return company;
  });
}

export async function createCompany(
  actor: Actor,
  input: CompanyWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ company: Company }>> {
  assertScope(actor.scopes, "companies:write");
  const write = normalizeCompanyWrite(input, "create");
  const provenance = options.provenance ?? { operation: "create_company" };
  const hash = requestHash("create_company", { write, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 201, async () => ({
      company: await createInTransaction(db, actor, write, provenance),
    })),
  );
}

export async function upsertCompany(
  actor: Actor,
  input: CompanyWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<UpsertResult>> {
  assertScope(actor.scopes, "companies:write");
  const write = normalizeCompanyWrite(input, "upsert");
  const provenance = options.provenance ?? { operation: "upsert_company" };
  const hash = requestHash("upsert_company", { write, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const result = await upsertInTransaction(db, actor, write, provenance);
      return {
        company: result.company,
        created: result.created,
        matchedOn: result.matchedOn,
      };
    }),
  );
}

export async function updateCompany(
  actor: Actor,
  id: string,
  input: CompanyWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ company: Company }>> {
  assertScope(actor.scopes, "companies:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Company not found.", 404);
  const write = normalizeCompanyWrite(input, "patch");
  const provenance = options.provenance ?? { operation: "update_company" };
  const hash = requestHash("update_company", { id, write, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      await lockCompanies(db, actor.workspaceId);
      const current = await readCompany(db, id);
      if (!current) throw new CrmError("not_found", "Company not found.", 404);
      const updated = await applyUpdate(
        db,
        actor,
        current,
        write,
        provenance,
        "company.updated",
      );
      return { company: updated.company };
    }),
  );
}

export async function archiveCompany(
  actor: Actor,
  id: string,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ company: Company }>> {
  assertScope(actor.scopes, "companies:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Company not found.", 404);
  const provenance = options.provenance ?? { operation: "archive_company" };
  const hash = requestHash("archive_company", { id, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      await lockCompanies(db, actor.workspaceId);
      const current = await readCompany(db, id);
      if (!current) throw new CrmError("not_found", "Company not found.", 404);
      if (current.archivedAt) return { company: current };
      await db.query(
        "update crm.companies set archived_at = now() where id = $1",
        [id],
      );
      const company = await readCompany(db, id);
      if (!company) throw new CrmError("not_found", "Company not found.", 404);
      await recordAudit(db, actor, "company.archived", "company", company.id, provenance, {
        before: { archivedAt: null },
        after: { archivedAt: company.archivedAt },
      });
      return { company };
    }),
  );
}

export async function bulkUpsertCompanies(
  actor: Actor,
  items: CompanyWrite[],
  options: MutationOptions = {},
): Promise<MutationOutcome<{ results: BulkItemResult[] }>> {
  assertScope(actor.scopes, "companies:write");
  if (!Array.isArray(items) || items.length === 0) {
    throw new CrmError("invalid_input", "Provide at least one company.", 400);
  }
  if (items.length > 50) {
    throw new CrmError(
      "invalid_input",
      "Submit at most 50 companies at a time.",
      400,
    );
  }
  const provenance = options.provenance ?? { operation: "bulk_upsert_companies" };
  const hash = requestHash("bulk_upsert_companies", { items, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const results: BulkItemResult[] = [];
      for (let index = 0; index < items.length; index += 1) {
        await db.query("savepoint bulk_item");
        try {
          const write = normalizeCompanyWrite(items[index], "upsert");
          const result = await upsertInTransaction(db, actor, write, provenance);
          await db.query("release savepoint bulk_item");
          results.push({
            index,
            status: result.created ? "created" : result.changed ? "updated" : "matched",
            company: result.company,
            matchedOn: result.matchedOn,
          });
        } catch (error) {
          await db.query("rollback to savepoint bulk_item");
          await db.query("release savepoint bulk_item");
          if (error instanceof CrmError) {
            results.push({
              index,
              status: "error",
              error: { code: error.code, message: error.message },
            });
            continue;
          }
          throw error;
        }
      }
      return { results };
    }),
  );
}
