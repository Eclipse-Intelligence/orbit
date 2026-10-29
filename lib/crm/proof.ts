import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid, recordAudit } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { PROOF_LIMITS, PROOF_PERMISSIONS, PROOF_PRODUCTS, type ProofEntry, type ProofPermission, type ProofProduct } from "@/lib/crm/proof-rules";

export type { ProofEntry, ProofWrite } from "@/lib/crm/proof-rules";

type ProofRow = {
  id: string;
  client: string;
  description: string;
  product: ProofProduct;
  used_for: string;
  result: string;
  measured: string;
  permission: ProofPermission;
  approved_by: string;
  review_on: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const COLUMNS = "id, client, description, product, used_for, result, measured, permission, approved_by, review_on::text, created_by, created_at, updated_at";

const LIMITS = PROOF_LIMITS;

const FIELD_NAMES: Record<keyof typeof LIMITS, string> = {
  client: "The client",
  description: "The description",
  usedFor: "What they used it for",
  result: "The result",
  measured: "How it was measured",
  approvedBy: "Who approved it",
};

function mapEntry(row: ProofRow): ProofEntry {
  return {
    id: row.id,
    client: row.client,
    description: row.description,
    product: row.product,
    usedFor: row.used_for,
    result: row.result,
    measured: row.measured,
    permission: row.permission,
    approvedBy: row.approved_by,
    reviewOn: row.review_on,
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function invalid(message: string, field: string): never {
  throw new CrmError("invalid_input", message, 400, { field });
}

function notFound(): never {
  throw new CrmError("not_found", "That proof entry no longer exists.", 404);
}

function text(source: Record<string, unknown>, field: keyof typeof LIMITS, required = false) {
  const value = source[field];
  if (value != null && typeof value !== "string") invalid(`${FIELD_NAMES[field]} must be text.`, field);
  const cleaned = (value ?? "").toString().replace(/\s+/g, " ").trim();
  if (required && !cleaned) invalid(field === "client" ? "Add the client's name." : "Add the result.", field);
  if (cleaned.length > LIMITS[field]) invalid(`${FIELD_NAMES[field]} must be ${LIMITS[field]} characters or fewer.`, field);
  return cleaned;
}

function reviewDate(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    invalid("Pick a review date.", "reviewOn");
  }
  return value;
}

function cleanWrite(input: unknown) {
  if (!input || typeof input !== "object") invalid("Send the proof details.", "client");
  const source = input as Record<string, unknown>;
  const product = source.product ?? "eclipse";
  if (!PROOF_PRODUCTS.includes(product as ProofProduct)) invalid("Choose Eclipse or Cntent.", "product");
  if (!PROOF_PERMISSIONS.includes(source.permission as ProofPermission)) invalid("Choose whether they can be named.", "permission");
  const values = {
    client: text(source, "client", true),
    description: text(source, "description"),
    product: product as ProofProduct,
    usedFor: text(source, "usedFor"),
    result: text(source, "result", true),
    measured: text(source, "measured"),
    permission: source.permission as ProofPermission,
    approvedBy: text(source, "approvedBy"),
    reviewOn: reviewDate(source.reviewOn),
  };
  if (values.permission === "described" && !values.description) {
    invalid("Described only entries need a description that doesn't identify them, such as a 12-person B2B SEO agency.", "description");
  }
  return values;
}

function auditFields(entry: ProofEntry) {
  return { client: entry.client, result: entry.result, permission: entry.permission, reviewOn: entry.reviewOn };
}

async function readEntry(db: Db, actor: UserActor, id: string) {
  if (!isUuid(id)) notFound();
  const result = await db.query<ProofRow>(
    `select ${COLUMNS} from crm.proof_entries where workspace_id = $1 and id = $2 and archived_at is null for update`,
    [actor.workspaceId, id],
  );
  if (!result.rows[0]) notFound();
  return mapEntry(result.rows[0]);
}

export async function listProof(actor: UserActor): Promise<ProofEntry[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<ProofRow>(
      `select ${COLUMNS} from crm.proof_entries
       where workspace_id = $1 and archived_at is null
       order by lower(client), created_at
       limit 500`,
      [actor.workspaceId],
    );
    return result.rows.map(mapEntry);
  });
}

export async function createProof(actor: UserActor, input: unknown, provenance: Provenance) {
  const values = cleanWrite(input);
  return withActor(actor, async (db) => {
    const result = await db.query<ProofRow>(
      `insert into crm.proof_entries (workspace_id, created_by, client, description, product, used_for, result, measured, permission, approved_by, review_on)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning ${COLUMNS}`,
      [actor.workspaceId, actor.userId, values.client, values.description, values.product, values.usedFor, values.result, values.measured, values.permission, values.approvedBy, values.reviewOn],
    );
    const entry = mapEntry(result.rows[0]);
    await recordAudit(db, actor, "proof_entry.created", "proof_entry", entry.id, provenance, { after: auditFields(entry) });
    return entry;
  });
}

export async function updateProof(actor: UserActor, id: string, input: unknown, provenance: Provenance) {
  const values = cleanWrite(input);
  return withActor(actor, async (db) => {
    const current = await readEntry(db, actor, id);
    const result = await db.query<ProofRow>(
      `update crm.proof_entries
       set client = $3, description = $4, product = $5, used_for = $6, result = $7, measured = $8, permission = $9, approved_by = $10, review_on = $11
       where workspace_id = $1 and id = $2
       returning ${COLUMNS}`,
      [actor.workspaceId, id, values.client, values.description, values.product, values.usedFor, values.result, values.measured, values.permission, values.approvedBy, values.reviewOn],
    );
    const entry = mapEntry(result.rows[0]);
    await recordAudit(db, actor, "proof_entry.updated", "proof_entry", entry.id, provenance, { before: auditFields(current), after: auditFields(entry) });
    return entry;
  });
}

export async function archiveProof(actor: UserActor, id: string, provenance: Provenance) {
  return withActor(actor, async (db) => {
    const current = await readEntry(db, actor, id);
    await db.query("update crm.proof_entries set archived_at = now() where workspace_id = $1 and id = $2", [actor.workspaceId, id]);
    await recordAudit(db, actor, "proof_entry.archived", "proof_entry", id, provenance, { before: auditFields(current) });
    return { id };
  });
}
