import { randomUUID } from "node:crypto";
import { query } from "@/lib/db/pool";
import type { ProviderId } from "@/lib/enrichment/providers";

export const SERVICES = ["llm", "web_search", "parallel", "context_dev", "mindcase", "enrow", "icypeas", "hunter", "smartlead", "smartlead_push", "smartlead_stats", "heyreach"] as const;
export type Service = (typeof SERVICES)[number];

export const ENRICHMENT_SERVICES: Record<ProviderId, Service> = { context: "context_dev", hunter: "hunter", enrow: "enrow", icypeas: "icypeas" };

type Window = { limit: number; seconds: number };
type ServiceLimit = { windows: Window[]; atOnce: number | null };

const SLOT_SECONDS = 300;
const BUSY_SLOT_WAIT_MS = 15_000;
const RETRY_AFTER_MAX_MS = 10 * 60_000;
const DEFAULT_429_WAIT_MS = 60_000;

const DEFAULTS: Record<Service, { perMinute?: number; perHour?: number; atOnce?: number }> = {
  llm: { perMinute: 600, atOnce: 100 },
  web_search: { perMinute: 120, atOnce: 30 },
  parallel: { perMinute: 120, atOnce: 30 },
  context_dev: { perMinute: 60, atOnce: 10 },
  mindcase: { perMinute: 30, atOnce: 5 },
  enrow: { perMinute: 60, atOnce: 10 },
  icypeas: { perMinute: 60, atOnce: 10 },
  hunter: { perMinute: 60, atOnce: 10 },
  smartlead: { perMinute: 60, perHour: 1000 },
  smartlead_push: { perMinute: 40, perHour: 700 },
  smartlead_stats: { perMinute: 10 },
  heyreach: { perMinute: 300 },
};

function envNumber(name: string, fallback: number | undefined) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function serviceLimit(service: Service): ServiceLimit {
  const name = `WORKFLOW_LIMIT_${service.toUpperCase()}`;
  const base = DEFAULTS[service];
  const perMinute = envNumber(`${name}_PER_MINUTE`, base.perMinute);
  const perHour = envNumber(`${name}_PER_HOUR`, base.perHour);
  const atOnce = envNumber(`${name}_AT_ONCE`, base.atOnce);
  return {
    windows: [
      ...(perMinute ? [{ limit: perMinute, seconds: 60 }] : []),
      ...(perHour ? [{ limit: perHour, seconds: 3600 }] : []),
    ],
    atOnce: atOnce ?? null,
  };
}

const SERVICE_NAMES: Record<Service, string> = {
  llm: "the AI",
  web_search: "the AI's web search",
  parallel: "Parallel",
  context_dev: "context.dev",
  mindcase: "Mindcase",
  enrow: "Enrow",
  icypeas: "Icypeas",
  hunter: "Hunter",
  smartlead: "Smartlead",
  smartlead_push: "Smartlead",
  smartlead_stats: "Smartlead",
  heyreach: "HeyReach",
};

export class ServiceBusy extends Error {
  readonly service: Service;
  readonly until: Date;

  constructor(service: Service, until: Date, message?: string) {
    super(message || `Waiting for a turn with ${SERVICE_NAMES[service]}.`);
    this.name = "ServiceBusy";
    this.service = service;
    this.until = until;
  }
}

function jitter() {
  return 1_000 + Math.floor(Math.random() * 4_000);
}

function windowEnd(seconds: number, now = Date.now()) {
  const size = seconds * 1000;
  return Math.floor(now / size) * size + size;
}

function bucketKey(service: Service, scope: string | undefined, suffix: string) {
  return `workflow-service:${service}${scope ? `:${scope}` : ""}:${suffix}`;
}

export type ServiceTicket = { release: () => Promise<void> };

export async function takeService(service: Service, options: { scope?: string; holder?: string } = {}): Promise<ServiceTicket> {
  const limit = serviceLimit(service);
  const key = bucketKey(service, options.scope, "slots");
  const holder = options.holder ?? randomUUID();
  let released = !limit.atOnce;
  const release = async () => {
    if (released) return;
    released = true;
    await query("select private.release_slot($1, $2)", [key, holder]).catch((error) => console.error("Couldn't release a service slot", error));
  };
  if (limit.atOnce) {
    const taken = await query<{ ok: boolean }>("select private.take_slot($1, $2, $3, $4) as ok", [key, limit.atOnce, holder, SLOT_SECONDS]);
    if (!taken.rows[0]?.ok) throw new ServiceBusy(service, new Date(Date.now() + BUSY_SLOT_WAIT_MS + jitter()));
  }
  for (const window of limit.windows) {
    const allowed = await query<{ ok: boolean }>("select private.consume_rate_limit($1, $2, $3, 1) as ok", [
      bucketKey(service, options.scope, `${window.seconds}s`),
      window.limit,
      window.seconds,
    ]).catch(async (error) => {
      await release();
      throw error;
    });
    if (!allowed.rows[0]?.ok) {
      await release();
      throw new ServiceBusy(service, new Date(windowEnd(window.seconds) + jitter()));
    }
  }
  return { release };
}

export function retryAfterMs(value: string | null | undefined, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.min(Math.max(at - now, 0), RETRY_AFTER_MAX_MS);
}

export function busyFromStatus(service: Service, status: number | null | undefined, retryAfter?: string | null, message?: string) {
  if (status !== 429) return null;
  const wait = retryAfterMs(retryAfter) ?? DEFAULT_429_WAIT_MS;
  return new ServiceBusy(service, new Date(Date.now() + wait + jitter()), message);
}

export async function withService<T>(
  service: Service,
  run: () => Promise<T>,
  options: { scope?: string; statusOf?: (error: unknown) => { status: number | null; retryAfter?: string | null } | null } = {},
): Promise<T> {
  const ticket = await takeService(service, { scope: options.scope });
  try {
    return await run();
  } catch (error) {
    const seen = options.statusOf?.(error);
    const busy = seen ? busyFromStatus(service, seen.status, seen.retryAfter, error instanceof Error ? error.message : undefined) : null;
    throw busy ?? error;
  } finally {
    await ticket.release();
  }
}
