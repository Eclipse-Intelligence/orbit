import { createHash } from "node:crypto";
import type { Db } from "@/lib/db/pool";
import { actorKey } from "@/lib/crm/context";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { stableStringify } from "@/lib/crm/normalize";
import type { Actor, Provenance } from "@/lib/crm/types";

export type MutationOutcome<T> = {
  status: number;
  body: T;
  replayed: boolean;
};

export type MutationOptions = {
  idempotencyKey?: string | null;
  provenance?: Provenance;
};

export function iso(value: Date | string | null) {
  if (!value) return null;
  return new Date(value).toISOString();
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function requestHash(operation: string, payload: unknown) {
  return createHash("sha256")
    .update(stableStringify({ operation, payload }))
    .digest("hex");
}

export function pageWindow(limit?: number, offset?: number) {
  return {
    limit: Math.min(100, Math.max(1, limit ?? 50)),
    offset: Math.min(10_000, Math.max(0, offset ?? 0)),
  };
}

export async function assertOwner(
  db: Db,
  workspaceId: string,
  ownerId: string | null | undefined,
) {
  if (!ownerId) return;
  const result = await db.query(
    "select 1 from crm.workspace_members where workspace_id = $1 and user_id = $2",
    [workspaceId, ownerId],
  );
  if (result.rowCount === 0) {
    throw new CrmError(
      "invalid_input",
      "Owner is not a member of this workspace.",
      400,
      { field: "ownerId" },
    );
  }
}

export async function recordAudit(
  db: Db,
  actor: Actor,
  eventType: string,
  entityType: string,
  entityId: string,
  provenance: Provenance | undefined,
  changes: Record<string, unknown>,
) {
  await db.query(
    `insert into crm.audit_events (
      workspace_id, event_type, entity_type, entity_id, actor_type,
      actor_user_id, actor_agent_id, credential_id, source, source_url,
      operation, changes
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [
      actor.workspaceId,
      eventType,
      entityType,
      entityId,
      actor.type,
      actor.type === "user" ? actor.userId : null,
      actor.type === "agent" ? actor.agentId : null,
      actor.type === "agent" ? actor.credentialId : null,
      provenance?.source ?? null,
      provenance?.sourceUrl ?? null,
      provenance?.operation ?? eventType,
      JSON.stringify(changes),
    ],
  );
}

export async function replayOrRun<T>(
  db: Db,
  actor: Actor,
  key: string | null | undefined,
  hash: string,
  status: number,
  run: () => Promise<T>,
): Promise<MutationOutcome<T>> {
  if (!key) {
    return { status, body: await run(), replayed: false };
  }
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${actor.workspaceId}:${actorKey(actor)}:${key}`,
  ]);
  const existing = await db.query<{
    status_code: number;
    request_hash: string;
    response: T;
  }>(
    `select status_code, request_hash, response
     from crm.idempotency_keys
     where workspace_id = $1 and actor_key = $2 and idempotency_key = $3`,
    [actor.workspaceId, actorKey(actor), key],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.request_hash !== hash) {
      throw new CrmError(
        "idempotency_conflict",
        "This idempotency key was already used for a different request.",
        409,
      );
    }
    return { status: row.status_code, body: row.response, replayed: true };
  }
  const body = await run();
  await db.query(
    `insert into crm.idempotency_keys (
      workspace_id, actor_key, idempotency_key, request_hash, status_code, response
    ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [actor.workspaceId, actorKey(actor), key, hash, status, JSON.stringify(body)],
  );
  return { status, body, replayed: false };
}

export function constraintError(
  error: unknown,
  duplicateCode: string,
  duplicateMessage: string,
): never {
  if (error instanceof CrmError) throw error;
  if (isPgError(error) && error.code === "23505") {
    throw new CrmError(duplicateCode, duplicateMessage, 409);
  }
  if (isPgError(error) && (error.code === "23514" || error.code === "23503")) {
    const line = error.message.split("\n")[0] ?? "";
    const safe =
      line.length > 0 &&
      line.length <= 160 &&
      !/select |insert |update |delete /i.test(line);
    throw new CrmError(
      "invalid_input",
      safe ? line : "That relationship is not valid in this workspace.",
      400,
    );
  }
  throw error;
}

export function assignColumns(
  pairs: Array<[boolean, string, string, unknown]>,
) {
  const sets: string[] = [];
  const values: unknown[] = [];
  const fields: string[] = [];
  for (const [include, column, field, value] of pairs) {
    if (!include) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
    fields.push(field);
  }
  return { sets, values, fields };
}

export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: string[],
) {
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const field of fields) {
    previous[field] = before[field];
    next[field] = after[field];
  }
  return { fields, before: previous, after: next };
}

export function actorIds(actor: Actor) {
  return {
    userId: actor.type === "user" ? actor.userId : null,
    agentId: actor.type === "agent" ? actor.agentId : null,
  };
}

export async function lockNamespace(db: Db, workspaceId: string, name: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${workspaceId}:${name}`,
  ]);
}
