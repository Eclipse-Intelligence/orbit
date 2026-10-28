import type { Db } from "@/lib/db/pool";
import { readCompanyInDb } from "@/lib/crm/companies";
import { readContactInDb } from "@/lib/crm/contacts";
import { withActorAfterAppStep } from "@/lib/crm/context";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { isUuid, lockNamespace, recordAudit } from "@/lib/crm/mutate";
import { canonicalEmail, TAG_LIMIT } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Company, Contact, Provenance } from "@/lib/crm/types";

export type MergeResult<T> = {
  kept: T;
  merged: T;
  moved: Record<string, number>;
  filled: string[];
  tagsAdded: string[];
};

type Fill<T> = { field: keyof T & string; columns: string[] };

const NOTES_LIMIT = 10_000;

const COMPANY_FILLS: Fill<Company>[] = [
  { field: "domain", columns: ["domain"] },
  { field: "website", columns: ["website"] },
  { field: "description", columns: ["description"] },
  { field: "industry", columns: ["industry"] },
  { field: "sizeCategory", columns: ["size_category"] },
  { field: "linkedinUrl", columns: ["linkedin_url"] },
  { field: "phone", columns: ["phone"] },
  { field: "address", columns: ["address"] },
  { field: "logoUrl", columns: ["logo_url"] },
  { field: "brand", columns: ["brand"] },
  { field: "enrichedAt", columns: ["enriched_at"] },
  { field: "lifecycle", columns: ["lifecycle"] },
  { field: "ownerId", columns: ["owner_id"] },
  { field: "source", columns: ["source"] },
  { field: "sourceReference", columns: ["source_reference"] },
  { field: "health", columns: ["health", "health_reason", "health_at", "health_activity_id"] },
];

const CONTACT_FILLS: Fill<Contact>[] = [
  { field: "firstName", columns: ["first_name"] },
  { field: "lastName", columns: ["last_name"] },
  { field: "email", columns: ["email", "normalized_email"] },
  { field: "phone", columns: ["phone"] },
  { field: "jobTitle", columns: ["job_title"] },
  { field: "linkedinUrl", columns: ["linkedin_url", "normalized_linkedin"] },
  { field: "companyId", columns: ["company_id"] },
  { field: "ownerId", columns: ["owner_id"] },
  { field: "source", columns: ["source"] },
  { field: "sourceReference", columns: ["source_reference"] },
];

const DEFAULT_LIFECYCLE = "lead";

function isEmpty(field: string, value: unknown) {
  if (field === "lifecycle" && typeof value === "string" && value.toLowerCase() === DEFAULT_LIFECYCLE) return true;
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

async function currentMembers(db: Db, workspaceId: string, ids: (string | null)[]) {
  const wanted = ids.filter((id): id is string => Boolean(id));
  if (wanted.length === 0) return new Set<string>();
  const result = await db.query<{ user_id: string }>(
    "select user_id::text from crm.workspace_members where workspace_id = $1 and user_id = any($2::uuid[])",
    [workspaceId, wanted],
  );
  return new Set(result.rows.map((row) => row.user_id));
}

async function fillsFor<T extends { ownerId: string | null }>(db: Db, workspaceId: string, fills: Fill<T>[], keep: T, merge: T) {
  const members = await currentMembers(db, workspaceId, [merge.ownerId]);
  return fills.filter(
    ({ field }) =>
      isEmpty(field, keep[field]) && !isEmpty(field, merge[field]) && (field !== "ownerId" || members.has(String(merge.ownerId))),
  );
}

function unionTags(keep: string[], merge: string[]) {
  const extra = merge.filter((tag) => !keep.includes(tag));
  const room = Math.max(0, TAG_LIMIT - keep.length);
  return { tags: [...keep, ...extra.slice(0, room)], added: extra.slice(0, room), dropped: extra.slice(room) };
}

function rowsMoved(raw: Record<string, unknown>) {
  const moved: Record<string, number> = {};
  for (const [table, value] of Object.entries(raw)) {
    if (typeof value === "number") moved[table] = value;
  }
  return moved;
}

function mergeFailure(error: unknown): never {
  if (error instanceof CrmError) throw error;
  if (isPgError(error)) {
    if (error.code === "P0002") throw new CrmError("not_found", error.message, 404);
    if (error.code === "22023") throw new CrmError("invalid_input", error.message, 400);
    if (error.code === "42501") throw new CrmError("forbidden", error.message, 403);
  }
  throw error;
}

function actorIds(actor: Actor) {
  return [actor.type === "user" ? actor.userId : null, actor.type === "agent" ? actor.agentId : null];
}

function assertPair(keepId: string, mergeId: string, noun: "company" | "person") {
  const label = noun === "company" ? "Company" : "Contact";
  if (!isUuid(keepId) || !isUuid(mergeId)) throw new CrmError("not_found", `${label} not found.`, 404);
  if (keepId === mergeId) {
    throw new CrmError("invalid_input", `Pick a different ${noun} to merge into.`, 400);
  }
}

async function moveReferences(
  db: Db,
  actor: Actor,
  fn: "merge_company_references" | "merge_contact_references",
  keepId: string,
  mergeId: string,
) {
  try {
    const result = await db.query<{ moved: Record<string, unknown> }>(
      `select private.${fn}($1, $2, $3, $4, $5) as moved`,
      [actor.workspaceId, ...actorIds(actor), keepId, mergeId],
    );
    return result.rows[0]?.moved ?? {};
  } catch (error) {
    mergeFailure(error);
  }
}

async function copyColumns(db: Db, table: "companies" | "contacts", workspaceId: string, keepId: string, mergeId: string, columns: string[], extra: Record<string, unknown>) {
  const sets = columns.map((column) => `${column} = m.${column}`);
  const values: unknown[] = [keepId, workspaceId, mergeId];
  for (const [column, value] of Object.entries(extra)) {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return;
  await db.query(
    `update crm.${table} k set ${sets.join(", ")}
     from crm.${table} m
     where k.id = $1 and k.workspace_id = $2 and m.id = $3 and m.workspace_id = $2`,
    values,
  );
}

async function archive(db: Db, table: "companies" | "contacts", workspaceId: string, id: string) {
  await db.query(`update crm.${table} set archived_at = now() where id = $1 and workspace_id = $2`, [id, workspaceId]);
}

async function recordArchived(
  db: Db,
  actor: Actor,
  entity: "company" | "contact",
  mergedId: string,
  keepId: string,
  archivedAt: string | null,
  provenance: Provenance,
) {
  await recordAudit(db, actor, `${entity}.archived`, entity, mergedId, provenance, {
    mergedInto: keepId,
    before: { archivedAt: null },
    after: { archivedAt },
  });
}

function beforeFields<T>(fills: Fill<T>[], record: T) {
  return Object.fromEntries(fills.map(({ field }) => [field, record[field] ?? null]));
}

export async function mergeCompanies(
  actor: Actor,
  keepId: string,
  mergeId: string,
  provenance: Provenance,
): Promise<MergeResult<Company>> {
  assertScope(actor.scopes, "companies:write");
  assertPair(keepId, mergeId, "company");
  let raw: Record<string, unknown> = {};
  return withActorAfterAppStep(
    actor,
    async (db) => {
      await lockNamespace(db, actor.workspaceId, "companies");
      raw = await moveReferences(db, actor, "merge_company_references", keepId, mergeId);
    },
    async (db) => {
      const keep = await readCompanyInDb(db, keepId, actor.workspaceId);
      const merge = await readCompanyInDb(db, mergeId, actor.workspaceId);
      if (!keep || !merge) throw new CrmError("not_found", "Company not found.", 404);
      const fills = await fillsFor(db, actor.workspaceId, COMPANY_FILLS, keep, merge);
      const tags = unionTags(keep.tags, merge.tags);
      await archive(db, "companies", actor.workspaceId, mergeId);
      await copyColumns(
        db,
        "companies",
        actor.workspaceId,
        keepId,
        mergeId,
        fills.flatMap((fill) => fill.columns),
        tags.added.length > 0 ? { tags: tags.tags } : {},
      );
      const kept = await readCompanyInDb(db, keepId, actor.workspaceId);
      const merged = await readCompanyInDb(db, mergeId, actor.workspaceId);
      if (!kept || !merged) throw new CrmError("not_found", "Company not found.", 404);
      const moved = rowsMoved(raw);
      const filled = fills.map((fill) => fill.field);
      await recordAudit(db, actor, "company.merged", "company", keepId, provenance, {
        keptId: keepId,
        mergedId: mergeId,
        keptName: keep.name,
        mergedName: merge.name,
        moved,
        webState: raw.company_web_state ?? "none",
        filled,
        tagsAdded: tags.added,
        tagsDropped: tags.dropped,
        before: {
          kept: { ...beforeFields(fills, keep), tags: keep.tags },
          merged: { archivedAt: null },
        },
        after: {
          kept: { ...beforeFields(fills, kept), tags: kept.tags },
          merged: { archivedAt: merged.archivedAt },
        },
      });
      await recordArchived(db, actor, "company", mergeId, keepId, merged.archivedAt, provenance);
      return { kept, merged, moved, filled, tagsAdded: tags.added };
    },
  );
}

function mergedNotes(keep: Contact, merge: Contact) {
  const current = keep.notes?.trim() ?? "";
  const parts = [current];
  const extra = merge.notes?.trim();
  if (extra && extra !== current) parts.push(extra);
  const keepEmail = keep.email ? canonicalEmail(keep.email) : null;
  const mergeEmail = merge.email ? canonicalEmail(merge.email) : null;
  if (keepEmail && mergeEmail && keepEmail !== mergeEmail) parts.push(`Other email: ${merge.email}`);
  const notes = parts.filter(Boolean).join("\n\n").slice(0, NOTES_LIMIT);
  return notes === current ? null : notes;
}

export async function mergeContacts(
  actor: Actor,
  keepId: string,
  mergeId: string,
  provenance: Provenance,
): Promise<MergeResult<Contact>> {
  assertScope(actor.scopes, "contacts:write");
  assertPair(keepId, mergeId, "person");
  let raw: Record<string, unknown> = {};
  return withActorAfterAppStep(
    actor,
    async (db) => {
      await lockNamespace(db, actor.workspaceId, "contacts");
      raw = await moveReferences(db, actor, "merge_contact_references", keepId, mergeId);
    },
    async (db) => {
      const keep = await readContactInDb(db, keepId, actor.workspaceId);
      const merge = await readContactInDb(db, mergeId, actor.workspaceId);
      if (!keep || !merge) throw new CrmError("not_found", "Contact not found.", 404);
      const fills = await fillsFor(db, actor.workspaceId, CONTACT_FILLS, keep, merge);
      const tags = unionTags(keep.tags, merge.tags);
      const notes = mergedNotes(keep, merge);
      await archive(db, "contacts", actor.workspaceId, mergeId);
      await copyColumns(db, "contacts", actor.workspaceId, keepId, mergeId, fills.flatMap((fill) => fill.columns), {
        ...(tags.added.length > 0 ? { tags: tags.tags } : {}),
        ...(notes !== null ? { notes } : {}),
      });
      const kept = await readContactInDb(db, keepId, actor.workspaceId);
      const merged = await readContactInDb(db, mergeId, actor.workspaceId);
      if (!kept || !merged) throw new CrmError("not_found", "Contact not found.", 404);
      const moved = rowsMoved(raw);
      const filled = [...fills.map((fill) => fill.field), ...(notes !== null ? ["notes"] : [])];
      await recordAudit(db, actor, "contact.merged", "contact", keepId, provenance, {
        keptId: keepId,
        mergedId: mergeId,
        keptName: keep.name,
        mergedName: merge.name,
        moved,
        filled,
        tagsAdded: tags.added,
        tagsDropped: tags.dropped,
        before: {
          kept: { ...beforeFields(fills, keep), tags: keep.tags, notes: keep.notes },
          merged: { archivedAt: null },
        },
        after: {
          kept: { ...beforeFields(fills, kept), tags: kept.tags, notes: kept.notes },
          merged: { archivedAt: merged.archivedAt },
        },
      });
      await recordArchived(db, actor, "contact", mergeId, keepId, merged.archivedAt, provenance);
      return { kept, merged, moved, filled, tagsAdded: tags.added };
    },
  );
}
