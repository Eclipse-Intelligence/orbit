import { randomBytes } from "node:crypto";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { encryptSecret } from "@/lib/crypto/secret";
import { mailOrigin } from "@/lib/mail/origin";
import { createGraphSubscription, deleteGraphSubscription, GraphSubscriptionError, renewGraphSubscription } from "@/lib/microsoft/subscriptions";

const SUBSCRIPTION_MINUTES = 4_200;
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
const STEP_RESERVE_MS = 2_000;
export const CALENDAR_CHANGES = "created,updated,deleted";

export type CalendarSourceRef = { kind: "connection" | "account"; id: string };

type Options = { fetchImpl?: typeof fetch; deadline: number; only?: string[]; placeholder: string; listed?: string[] };

type CalendarRow = {
  id: string;
  provider_calendar_id: string;
  wanted: boolean;
  graph_subscription_id: string | null;
  graph_subscription_expires_at: Date | string | null;
  graph_subscription_retry_at: Date | string | null;
};

function column(source: CalendarSourceRef) {
  return source.kind === "connection" ? "connection_id" : "account_id";
}

export function calendarResource(providerCalendarId: string) {
  return `me/calendars/${providerCalendarId}/events`;
}

export function calendarNotificationUrl(origin: string) {
  return `${origin}/api/microsoft/calendar-webhook`;
}

function later(value: Date | string | null, now: number) {
  return value !== null && new Date(value).getTime() > now;
}

async function clearSubscription(actor: UserActor, calendarId: string, subscriptionId: string) {
  await withActor(actor, (db) =>
    db.query(
      `update crm.calendars set graph_subscription_id = null, graph_subscription_expires_at = null, graph_client_state = null
       where id = $1 and graph_subscription_id = $2`,
      [calendarId, subscriptionId],
    ),
  );
}

async function subscribe(actor: UserActor, token: string, row: CalendarRow, origin: string, options: Options) {
  const clientState = randomBytes(32).toString("base64url");
  const created = await createGraphSubscription(
    token,
    {
      resource: calendarResource(row.provider_calendar_id),
      changeType: CALENDAR_CHANGES,
      notificationUrl: calendarNotificationUrl(origin),
      clientState,
      minutes: SUBSCRIPTION_MINUTES,
    },
    { fetchImpl: options.fetchImpl, deadline: options.deadline },
  );
  const stored = await withActor(actor, (db) =>
    db.query(
      `update crm.calendars
       set graph_subscription_id = $2, graph_subscription_expires_at = $3, graph_client_state = $4, graph_subscription_retry_at = null
       where id = $1 and graph_subscription_id is not distinct from $5
       returning id`,
      [row.id, created.id, created.expiresAt, encryptSecret(clientState), row.graph_subscription_id],
    ),
  );
  if ((stored.rowCount ?? 0) > 0) return;
  await deleteGraphSubscription(token, created.id, { fetchImpl: options.fetchImpl, deadline: options.deadline }).catch((error) =>
    console.error("Couldn't remove a spare calendar subscription", error instanceof Error ? error.message : error),
  );
}

async function keepOne(actor: UserActor, token: string, row: CalendarRow, origin: string, options: Options) {
  const now = Date.now();
  const limit = { fetchImpl: options.fetchImpl, deadline: options.deadline };
  if (!row.wanted) {
    if (!row.graph_subscription_id) return;
    await deleteGraphSubscription(token, row.graph_subscription_id, limit);
    await clearSubscription(actor, row.id, row.graph_subscription_id);
    return;
  }
  if (row.graph_subscription_id) {
    const expires = row.graph_subscription_expires_at ? new Date(row.graph_subscription_expires_at).getTime() : 0;
    if (expires - now > RENEW_BEFORE_MS) return;
    const renewed = await renewGraphSubscription(token, row.graph_subscription_id, SUBSCRIPTION_MINUTES, limit);
    if (renewed) {
      await withActor(actor, (db) =>
        db.query("update crm.calendars set graph_subscription_expires_at = $3 where id = $1 and graph_subscription_id = $2", [
          row.id,
          row.graph_subscription_id,
          renewed,
        ]),
      );
      return;
    }
    await clearSubscription(actor, row.id, row.graph_subscription_id);
    row = { ...row, graph_subscription_id: null };
  }
  if (later(row.graph_subscription_retry_at, now)) return;
  await subscribe(actor, token, row, origin, options);
}

export async function keepCalendarSubscriptions(actor: UserActor, source: CalendarSourceRef, token: string, options: Options) {
  const origin = mailOrigin();
  if (!origin) return { kept: 0, failed: 0 };
  const rows = await withActor(actor, (db) =>
    db.query<CalendarRow>(
      `select id, provider_calendar_id, (is_visible or use_for_crm) as wanted, graph_subscription_id,
              graph_subscription_expires_at, graph_subscription_retry_at
       from crm.calendars
       where ${column(source)} = $1 and provider_calendar_id <> $2 and ($3::uuid[] is null or id = any($3::uuid[]))
       order by is_default desc, name`,
      [source.id, options.placeholder, options.only ?? null],
    ),
  );
  let kept = 0;
  let failed = 0;
  for (const found of rows.rows) {
    if (options.deadline - Date.now() < STEP_RESERVE_MS) break;
    const row = options.listed && !options.listed.includes(found.provider_calendar_id) ? { ...found, wanted: false } : found;
    try {
      await keepOne(actor, token, row, origin, options);
      kept += 1;
    } catch (error) {
      failed += 1;
      console.error("Calendar subscription failed", error instanceof Error ? error.message : error);
      if (error instanceof GraphSubscriptionError && error.status === 408) break;
      if (!calendarSubscriptionRefused(error)) continue;
      await withActor(actor, (db) =>
        db.query("update crm.calendars set graph_subscription_retry_at = now() + make_interval(secs => $2) where id = $1", [
          row.id,
          RETRY_AFTER_FAILURE_MS / 1000,
        ]),
      ).catch(() => null);
    }
  }
  return { kept, failed };
}

export function calendarSubscriptionRefused(error: unknown) {
  return error instanceof GraphSubscriptionError && (error.status === 400 || error.status === 403) && !/validat/i.test(`${error.message} ${error.code}`);
}

export async function releaseGoneCalendars(
  actor: UserActor,
  source: CalendarSourceRef,
  listedProviderIds: string[],
  token: string,
  options: { fetchImpl?: typeof fetch; deadline: number },
) {
  const rows = await withActor(actor, (db) =>
    db.query<{ id: string; graph_subscription_id: string }>(
      `select id, graph_subscription_id from crm.calendars
       where ${column(source)} = $1 and provider_calendar_id <> all($2::text[]) and graph_subscription_id is not null`,
      [source.id, listedProviderIds],
    ),
  );
  for (const row of rows.rows) {
    if (options.deadline - Date.now() < STEP_RESERVE_MS) break;
    try {
      await deleteGraphSubscription(token, row.graph_subscription_id, options);
      await clearSubscription(actor, row.id, row.graph_subscription_id);
    } catch (error) {
      console.error("Couldn't remove the subscription of a calendar that's gone", error instanceof Error ? error.message : error);
    }
  }
}
