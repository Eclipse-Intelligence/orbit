import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid, lockNamespace, recordAudit } from "@/lib/crm/mutate";
import { cleanText } from "@/lib/crm/normalize";
import { isRelationshipLabel, type RelationshipLabel, type RelationshipOverride } from "@/lib/crm/relationship-score";
import type { RelationshipTarget } from "@/lib/crm/relationship-signals";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Provenance } from "@/lib/crm/types";

const TABLES: Record<RelationshipTarget, string> = { company: "companies", contact: "contacts" };

type OverrideRow = {
  id: string;
  relationship_override: RelationshipLabel | null;
  relationship_override_reason: string | null;
  relationship_override_at: Date | string | null;
  relationship_override_by: string | null;
  archived_at: Date | string | null;
  by_name: string | null;
};

export type RelationshipOverrideInput = { label: RelationshipLabel | null; reason?: string | null };

function overrideSql(target: RelationshipTarget) {
  return `select r.id, r.relationship_override, r.relationship_override_reason, r.relationship_override_at, r.relationship_override_by, r.archived_at,
      coalesce(nullif(trim(p.full_name), ''), nullif(trim(p.email), '')) as by_name
    from crm.${TABLES[target]} r
    left join crm.profiles p on p.id = r.relationship_override_by`;
}

function mapOverride(row: OverrideRow): RelationshipOverride | null {
  if (!row.relationship_override) return null;
  return {
    label: row.relationship_override,
    reason: row.relationship_override_reason,
    at: iso(row.relationship_override_at),
    byUserId: row.relationship_override_by,
    byName: row.by_name,
  };
}

export function isRelationshipTarget(value: unknown): value is RelationshipTarget {
  return value === "company" || value === "contact";
}

function assertTarget(target: unknown): asserts target is RelationshipTarget {
  if (!isRelationshipTarget(target)) {
    throw new CrmError("invalid_input", "Choose a company or a person to set the relationship on.", 400, { field: "target" });
  }
}

function notFound(target: RelationshipTarget) {
  return new CrmError("not_found", target === "company" ? "Company not found." : "Contact not found.", 404);
}

export async function readRelationshipOverrides(db: Db, workspaceId: string, target: RelationshipTarget, ids: string[]) {
  assertTarget(target);
  const wanted = [...new Set(ids.filter(isUuid))];
  const found = new Map<string, RelationshipOverride>();
  if (wanted.length === 0) return found;
  const rows = await db.query<OverrideRow>(
    `${overrideSql(target)} where r.workspace_id = $1 and r.id = any($2::uuid[]) and r.relationship_override is not null`,
    [workspaceId, wanted],
  );
  for (const row of rows.rows) {
    const override = mapOverride(row);
    if (override) found.set(row.id, override);
  }
  return found;
}

export async function readRelationshipOverride(db: Db, workspaceId: string, target: RelationshipTarget, id: string) {
  assertTarget(target);
  const row = (await db.query<OverrideRow>(`${overrideSql(target)} where r.id = $1 and r.workspace_id = $2`, [id, workspaceId])).rows[0];
  if (!row) return undefined;
  return { label: row.relationship_override, reason: row.relationship_override_reason };
}

export async function setRelationshipOverrideInDb(
  db: Db,
  actor: Actor,
  target: RelationshipTarget,
  id: string,
  input: RelationshipOverrideInput,
  provenance: Provenance,
) {
  assertTarget(target);
  if (input.label !== null && !isRelationshipLabel(input.label)) {
    throw new CrmError("invalid_input", "Relationship is strong, warm, cooling, one_sided, cold or new.", 400, { field: "relationship" });
  }
  const reason = input.label ? cleanText(input.reason ?? null, 500, "reason") : null;
  await lockNamespace(db, actor.workspaceId, TABLES[target]);
  const current = (
    await db.query<OverrideRow>(`${overrideSql(target)} where r.id = $1 and r.workspace_id = $2 for update of r`, [id, actor.workspaceId])
  ).rows[0];
  if (!current) throw notFound(target);
  if (current.archived_at) {
    throw new CrmError(
      "archived",
      target === "company"
        ? "This company is archived. Restore it before changing the relationship."
        : "This person is archived. Restore them before changing the relationship.",
      409,
    );
  }
  const fields = [
    current.relationship_override !== input.label ? "relationshipOverride" : null,
    current.relationship_override_reason !== reason ? "relationshipOverrideReason" : null,
  ].filter((field): field is string => field !== null);
  if (fields.length === 0) return { override: mapOverride(current), changed: false };
  await db.query(
    `update crm.${TABLES[target]}
     set relationship_override = $3,
       relationship_override_reason = $4,
       relationship_override_at = case when $3::text is null then null else now() end,
       relationship_override_by = case when $3::text is null then null else $5::uuid end
     where id = $1 and workspace_id = $2`,
    [id, actor.workspaceId, input.label, reason, actor.type === "user" ? actor.userId : null],
  );
  const saved = (await db.query<OverrideRow>(`${overrideSql(target)} where r.id = $1`, [id])).rows[0];
  if (!saved) throw notFound(target);
  await recordAudit(db, actor, `${target}.updated`, target, id, provenance, {
    fields,
    before: { relationshipOverride: current.relationship_override, relationshipOverrideReason: current.relationship_override_reason },
    after: { relationshipOverride: saved.relationship_override, relationshipOverrideReason: saved.relationship_override_reason },
  });
  return { override: mapOverride(saved), changed: true };
}

export async function setRelationshipOverride(
  actor: Actor,
  target: RelationshipTarget,
  id: string,
  input: RelationshipOverrideInput,
  provenance: Provenance,
) {
  assertTarget(target);
  assertScope(actor.scopes, target === "company" ? "companies:write" : "contacts:write");
  if (!isUuid(id)) throw notFound(target);
  return withActor(actor, (db) => setRelationshipOverrideInDb(db, actor, target, id, input, provenance));
}
