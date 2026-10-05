import { createHmac, randomBytes } from "node:crypto";
import type { Db } from "@/lib/db/pool";
import { getAdminPool } from "@/lib/db/pool";
import { CrmError } from "@/lib/crm/errors";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor } from "@/lib/crm/types";

function iso(value: Date | string | null) {
  if (!value) return null;
  return new Date(value).toISOString();
}

export const WEBHOOK_EVENTS = [
  "company.created",
  "company.updated",
  "company.archived",
  "contact.created",
  "contact.updated",
  "contact.archived",
  "lead.created",
  "opportunity.created",
  "opportunity.updated",
  "opportunity.stage_changed",
  "opportunity.archived",
  "activity.created",
  "task.created",
  "task.completed",
  "task.reopened",
  "task.updated",
  "task.archived",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const BACKOFF_SECONDS = [60, 300, 1800, 7200];

export type WebhookEndpoint = {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  createdAt: string;
};

export type WebhookDelivery = {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

export function assertWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CrmError("invalid_input", "Enter a valid webhook URL.", 400, { field: "url" });
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && local) return url.toString();
  throw new CrmError("invalid_input", "Webhook URLs use https.", 400, { field: "url" });
}

export async function enqueueWebhookDeliveries(
  db: Db,
  workspaceId: string,
  eventId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await db.query(
    `insert into crm.webhook_deliveries (
      workspace_id, endpoint_id, event_id, event_type, payload
    )
    select $1, endpoint.id, $2, $3, $4::jsonb
    from crm.webhook_endpoints endpoint
    where endpoint.workspace_id = $1
      and endpoint.archived_at is null
      and endpoint.enabled
      and ($3 = any(endpoint.events) or '*' = any(endpoint.events))`,
    [workspaceId, eventId, eventType, JSON.stringify(payload)],
  );
}

export async function createWebhook(
  actor: Actor,
  input: { url: string; events: string[]; description?: string | null },
) {
  assertScope(actor.scopes, "admin");
  const url = assertWebhookUrl(input.url.trim());
  const events = [...new Set(input.events.map((event) => event.trim()).filter(Boolean))];
  if (events.length === 0) {
    throw new CrmError("invalid_input", "Choose at least one event.", 400, { field: "events" });
  }
  for (const event of events) {
    if (event !== "*" && !(WEBHOOK_EVENTS as readonly string[]).includes(event)) {
      throw new CrmError("invalid_input", `Unknown event ${event}.`, 400, { field: "events" });
    }
  }
  const secret = randomBytes(24).toString("base64url");
  const { withActor } = await import("@/lib/crm/context");
  const endpoint = await withActor(actor, async (db) => {
    const inserted = await db.query<{
      id: string;
      url: string;
      description: string | null;
      events: string[];
      enabled: boolean;
      created_at: Date;
    }>(
      `insert into crm.webhook_endpoints (workspace_id, url, secret, description, events)
       values ($1, $2, $3, $4, $5)
       returning id, url, description, events, enabled, created_at`,
      [actor.workspaceId, url, secret, input.description?.trim() || null, events],
    );
    return inserted.rows[0];
  });
  return {
    endpoint: mapEndpoint(endpoint),
    secret,
  };
}

export async function listWebhooks(actor: Actor): Promise<WebhookEndpoint[]> {
  assertScope(actor.scopes, "crm:read");
  const { withActor } = await import("@/lib/crm/context");
  return withActor(actor, async (db) => {
    const rows = await db.query<{
      id: string;
      url: string;
      description: string | null;
      events: string[];
      enabled: boolean;
      created_at: Date;
    }>(
      `select id, url, description, events, enabled, created_at
       from crm.webhook_endpoints
       where workspace_id = $1 and archived_at is null
       order by created_at desc`,
      [actor.workspaceId],
    );
    return rows.rows.map(mapEndpoint);
  });
}

export async function archiveWebhook(actor: Actor, id: string) {
  assertScope(actor.scopes, "admin");
  const { withActor } = await import("@/lib/crm/context");
  await withActor(actor, async (db) => {
    const updated = await db.query(
      `update crm.webhook_endpoints
       set archived_at = now(), enabled = false
       where id = $1 and workspace_id = $2 and archived_at is null`,
      [id, actor.workspaceId],
    );
    if (updated.rowCount === 0) throw new CrmError("not_found", "Webhook not found.", 404);
  });
}

export async function listWebhookDeliveries(actor: Actor, limit = 50): Promise<WebhookDelivery[]> {
  assertScope(actor.scopes, "crm:read");
  const { withActor } = await import("@/lib/crm/context");
  return withActor(actor, async (db) => {
    const rows = await db.query<{
      id: string;
      endpoint_id: string;
      event_id: string;
      event_type: string;
      status: string;
      attempts: number;
      next_attempt_at: Date | null;
      last_status_code: number | null;
      last_error: string | null;
      delivered_at: Date | null;
      created_at: Date;
    }>(
      `select id, endpoint_id, event_id, event_type, status, attempts, next_attempt_at,
              last_status_code, last_error, delivered_at, created_at
       from crm.webhook_deliveries
       where workspace_id = $1
       order by created_at desc
       limit $2`,
      [actor.workspaceId, Math.min(100, Math.max(1, limit))],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      endpointId: row.endpoint_id,
      eventId: row.event_id,
      eventType: row.event_type,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: iso(row.next_attempt_at),
      lastStatusCode: row.last_status_code,
      lastError: row.last_error,
      deliveredAt: iso(row.delivered_at),
      createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    }));
  });
}

type ClaimedDelivery = {
  id: string;
  secret: string;
  url: string;
  event_type: string;
  event_id: string;
  payload: Record<string, unknown>;
  attempts: number;
};

export async function deliverDueWebhooks(limit = 20) {
  const admin = getAdminPool();
  const claimed = await admin.query<ClaimedDelivery>(
    `update crm.webhook_deliveries delivery
     set attempts = delivery.attempts + 1,
         next_attempt_at = now() + interval '5 minutes'
     where delivery.id in (
       select id
       from crm.webhook_deliveries
       where status = 'pending' and next_attempt_at <= now()
       order by created_at
       limit $1
       for update skip locked
     )
     returning delivery.id, delivery.event_type, delivery.event_id, delivery.payload, delivery.attempts,
       (select secret from crm.webhook_endpoints endpoint where endpoint.id = delivery.endpoint_id) as secret,
       (select url from crm.webhook_endpoints endpoint where endpoint.id = delivery.endpoint_id) as url`,
    [limit],
  );

  for (const row of claimed.rows) {
    const body = JSON.stringify(row.payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    try {
      const signature = createHmac("sha256", row.secret).update(`${timestamp}.${body}`).digest("hex");
      const response = await fetch(row.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-crm-event": row.event_type,
          "x-crm-event-id": row.event_id,
          "x-crm-timestamp": timestamp,
          "x-crm-signature": `v1=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        await admin.query(
          `update crm.webhook_deliveries
           set status = 'delivered', delivered_at = now(), last_status_code = $2, last_error = null
           where id = $1`,
          [row.id, response.status],
        );
        continue;
      }
      await markAttempt(row, response.status, `HTTP ${response.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Delivery failed";
      await markAttempt(row, null, message.slice(0, 300));
    }
  }
  return claimed.rowCount ?? 0;
}

async function markAttempt(row: ClaimedDelivery, statusCode: number | null, message: string) {
  const admin = getAdminPool();
  const failed = row.attempts >= 5;
  const delay = BACKOFF_SECONDS[Math.min(row.attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 7200;
  await admin.query(
    `update crm.webhook_deliveries
     set status = $2,
         last_status_code = $3,
         last_error = $4,
         next_attempt_at = now() + make_interval(secs => $5)
     where id = $1`,
    [row.id, failed ? "failed" : "pending", statusCode, message, failed ? 0 : delay],
  );
}

function mapEndpoint(row: {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  created_at: Date;
}): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    enabled: row.enabled,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}
