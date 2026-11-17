import type { CampaignStats, CampaignStatus, LeadStatus, SequenceStep } from "@/lib/campaigns/types";
import { logUpstream, unreachable, upstreamMessage } from "@/lib/upstream";
import { withService } from "@/lib/workflows/limits";

export const HEYREACH_API = "https://api.heyreach.io/api/public";
export const HEYREACH_APP = "https://app.heyreach.io/app/campaigns";
export const HEYREACH_PAGE_SIZE = 100;

const REQUEST_TIMEOUT_MS = 30_000;
const STATS_FROM = "2020-01-01T00:00:00.000Z";

export type HeyReachOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  workspaceId?: string;
};

export class HeyReachError extends Error {
  readonly status: number | null;
  readonly retryAfter: string | null;

  constructor(message: string, status: number | null, retryAfter: string | null = null) {
    super(message);
    this.name = "HeyReachError";
    this.status = status;
    this.retryAfter = retryAfter;
  }

  get rejectedKey() {
    return this.status === 401 || this.status === 403;
  }
}

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function count(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function time(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) || parsed <= 0 ? null : new Date(parsed).toISOString();
}

function first<T>(...values: (T | null | undefined)[]): T | null {
  for (const value of values) if (value !== null && value !== undefined) return value;
  return null;
}

function itemsOf(body: unknown) {
  return (Array.isArray(body) ? body : list(record(body).items)).map(record);
}

async function call(key: string, path: string, options: HeyReachOptions & { method?: "GET" | "POST"; body?: Json; query?: Record<string, string> }): Promise<unknown> {
  const run = async () => {
    const url = new URL(`${HEYREACH_API}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const signal = options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const method = options.method ?? (options.body ? "POST" : "GET");
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(url, {
        method,
        headers: { accept: "application/json", "X-API-KEY": key, ...(options.body ? { "content-type": "application/json" } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal,
      });
    } catch (error) {
      logUpstream("HeyReach", null, error, [key]);
      throw new HeyReachError(unreachable("HeyReach"), null);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logUpstream("HeyReach", response.status, body, [key]);
      throw new HeyReachError(upstreamMessage("HeyReach", response.status), response.status, response.headers.get("retry-after"));
    }
    const raw = await response.text().catch(() => "");
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      logUpstream("HeyReach", response.status, error, [key]);
      throw new HeyReachError("HeyReach sent a reply Orbit couldn't read.", response.status);
    }
  };
  const statusOf = (error: unknown) => (error instanceof HeyReachError ? { status: error.status, retryAfter: error.retryAfter } : null);
  return withService("heyreach", run, { scope: options.workspaceId, statusOf });
}

async function allPages(key: string, path: string, options: HeyReachOptions, extra: Json = {}) {
  const rows: Json[] = [];
  for (let offset = 0; ; offset += HEYREACH_PAGE_SIZE) {
    const body = await call(key, path, { ...options, body: { offset, limit: HEYREACH_PAGE_SIZE, ...extra } });
    const page = itemsOf(body);
    rows.push(...page);
    const total = count(record(body).totalCount);
    if (page.length < HEYREACH_PAGE_SIZE || (total !== undefined && rows.length >= total)) return rows;
  }
}

export async function checkHeyReachKey(key: string, options: HeyReachOptions = {}) {
  await call(key, "/auth/CheckApiKey", options);
}

export function campaignStatus(value: unknown): CampaignStatus {
  const status = (text(value) ?? "").toUpperCase().replace(/[\s-]/g, "_");
  if (status === "IN_PROGRESS" || status === "INPROGRESS" || status === "ACTIVE" || status === "RUNNING") return "active";
  if (status === "PAUSED") return "paused";
  if (status === "FINISHED" || status === "COMPLETED") return "completed";
  if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED" || status === "STOPPED") return "stopped";
  if (status === "ARCHIVED") return "archived";
  return "drafted";
}

export function leadStatus(value: unknown): LeadStatus | null {
  const status = (text(value) ?? "").toUpperCase().replace(/[\s_-]/g, "");
  if (!status) return null;
  if (status === "INSEQUENCE" || status === "INPROGRESS" || status === "ACTIVE") return "in_progress";
  if (status === "PENDING" || status === "NOTSTARTED" || status === "QUEUED") return "not_started";
  if (status === "PAUSED") return "paused";
  if (status === "FINISHED" || status === "COMPLETED") return "completed";
  if (status === "FAILED" || status === "STOPPED" || status === "EXCLUDED" || status === "REMOVED" || status === "CANCELED" || status === "CANCELLED") return "stopped";
  return null;
}

export type HeyReachCampaign = { id: string; name: string; status: CampaignStatus; accountIds: string[] };

export async function listHeyReachCampaigns(key: string, options: HeyReachOptions = {}): Promise<HeyReachCampaign[]> {
  const rows = await allPages(key, "/campaign/GetAll", options);
  return rows.flatMap((row) => {
    const id = text(row.id);
    if (!id) return [];
    const accounts = list(row.campaignAccountIds ?? row.linkedInAccountIds).map(text).filter((item): item is string => Boolean(item));
    return [{ id, name: text(row.name) ?? "", status: campaignStatus(row.status), accountIds: [...new Set(accounts)] }];
  });
}

export type HeyReachAccount = {
  id: string;
  name: string;
  email: string | null;
  profileUrl: string | null;
  inviteLimit: number | null;
  messageLimit: number | null;
};

export async function listHeyReachAccounts(key: string, options: HeyReachOptions = {}): Promise<HeyReachAccount[]> {
  const rows = await allPages(key, "/li_account/GetAll", options);
  return rows.flatMap((row): HeyReachAccount[] => {
    const id = text(row.id);
    if (!id) return [];
    const name = [text(row.firstName), text(row.lastName)].filter(Boolean).join(" ") || text(row.name) || "";
    return [
      {
        id,
        name,
        email: text(row.emailAddress) ?? text(row.email),
        profileUrl: text(row.profileUrl) ?? text(row.linkedInProfileUrl),
        inviteLimit: first(count(row.connectionRequestsDailyLimit), count(row.dailyConnectionRequestLimit), count(row.connectionLimit)),
        messageLimit: first(count(row.messagesDailyLimit), count(row.dailyMessageLimit), count(row.messageLimit)),
      },
    ];
  });
}

export function variablesIn(steps: SequenceStep[]) {
  const names = new Set<string>();
  for (const step of steps) {
    for (const match of `${step.subject}\n${step.body}`.matchAll(/(?<!\{)\{\s*([A-Za-z0-9_]+)\s*\}(?!\})/g)) names.add(match[1]);
  }
  return [...names].sort();
}

const STEP_KINDS: Record<string, string> = {
  CONNECTIONREQUEST: "Invite",
  SENDCONNECTIONREQUEST: "Invite",
  INVITE: "Invite",
  MESSAGE: "Message",
  SENDMESSAGE: "Message",
  INMAIL: "InMail",
  SENDINMAIL: "InMail",
};

function sequenceNodes(row: Json): Json[] {
  const direct = list(row.sequence ?? row.steps ?? row.sequenceSteps).map(record);
  if (direct.length > 0) return direct;
  const nodes: Json[] = [];
  let node = record(row.sequenceRootNode ?? record(row.sequence).rootNode);
  for (let guard = 0; Object.keys(node).length > 0 && guard < 100; guard += 1) {
    nodes.push(node);
    node = record(node.nextNode ?? node.next ?? list(node.children)[0]);
  }
  return nodes;
}

export async function readHeyReachSequence(key: string, campaignId: string, options: HeyReachOptions = {}): Promise<SequenceStep[]> {
  const row = record(await call(key, "/campaign/GetById", { ...options, query: { campaignId } }));
  const steps: SequenceStep[] = [];
  for (const node of sequenceNodes(row)) {
    const kind = STEP_KINDS[(text(node.actionType) ?? text(node.type) ?? "").toUpperCase().replace(/[\s_-]/g, "")];
    if (!kind) continue;
    const body = text(node.message) ?? text(node.messageText) ?? text(node.connectionNote) ?? text(node.body) ?? "";
    const delay = count(node.delayInDays) ?? count(node.delay) ?? (count(node.delayInHours) !== undefined ? Math.round(count(node.delayInHours)! / 24) : undefined);
    steps.push({ step: steps.length + 1, variant: null, subject: kind, body, delayDays: delay ?? null });
  }
  return steps;
}

export type HeyReachDay = { day: string; invites: number; accepted: number; messages: number; replies: number };

function statTotals(row: Json): CampaignStats {
  const stats: CampaignStats = {
    invites: count(row.connectionsSent),
    contacted: count(row.connectionsSent),
    accepted: count(row.connectionsAccepted),
    messages: first(count(row.messagesSent), count(row.totalMessageStarted)) ?? undefined,
    replied: first(count(row.totalMessageReplies), count(row.messageReplies)) ?? undefined,
  };
  const inmails = count(row.inmailMessagesSent);
  if (inmails !== undefined) stats.messages = (stats.messages ?? 0) + inmails;
  return Object.fromEntries(Object.entries(stats).filter(([, value]) => value !== undefined));
}

export async function readHeyReachStats(
  key: string,
  campaignId: string,
  options: HeyReachOptions & { now?: Date } = {},
): Promise<{ stats: CampaignStats; days: HeyReachDay[] }> {
  const body = record(
    await call(key, "/stats/GetOverallStats", {
      ...options,
      body: { accountIds: [], campaignIds: [Number.isFinite(Number(campaignId)) ? Number(campaignId) : campaignId], startDate: STATS_FROM, endDate: (options.now ?? new Date()).toISOString() },
    }),
  );
  const stats = statTotals(record(body.overallStats));
  const days = Object.entries(record(body.byDayStats))
    .flatMap(([at, value]): HeyReachDay[] => {
      const parsed = time(at);
      if (!parsed) return [];
      const row = statTotals(record(value));
      return [{ day: parsed.slice(0, 10), invites: row.invites ?? 0, accepted: row.accepted ?? 0, messages: row.messages ?? 0, replies: row.replied ?? 0 }];
    })
    .sort((a, b) => a.day.localeCompare(b.day));
  return { stats, days };
}

export type HeyReachLead = {
  id: string | null;
  profileUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  title: string | null;
  email: string | null;
  accountId: string | null;
  status: LeadStatus | null;
  addedAt: string | null;
  invitedAt: string | null;
  acceptedAt: string | null;
  messagesSent: number;
  lastMessageAt: string | null;
};

function connection(value: unknown) {
  const status = (text(value) ?? "").toUpperCase().replace(/[\s_-]/g, "");
  if (status === "CONNECTIONACCEPTED" || status === "ACCEPTED" || status === "CONNECTED") return "accepted";
  if (status === "CONNECTIONSENT" || status === "SENT" || status === "PENDING" || status === "INVITED") return "sent";
  return null;
}

function messaged(value: unknown) {
  const status = (text(value) ?? "").toUpperCase().replace(/[\s_-]/g, "");
  return status === "MESSAGESENT" || status === "SENT" || status === "MESSAGEREPLY" || status === "REPLIED" || status === "INMAILSENT";
}

export async function listHeyReachLeads(
  key: string,
  campaignId: string,
  offset: number,
  options: HeyReachOptions & { since?: string | null } = {},
): Promise<{ leads: HeyReachLead[]; next: number | null }> {
  const body = record(
    await call(key, "/campaign/GetLeadsFromCampaign", {
      ...options,
      body: {
        campaignId: Number.isFinite(Number(campaignId)) ? Number(campaignId) : campaignId,
        offset,
        limit: HEYREACH_PAGE_SIZE,
        ...(options.since ? { timeFrom: options.since, timeFilter: "LastActionTime" } : {}),
      },
    }),
  );
  const rows = itemsOf(body);
  const leads = rows.map((row): HeyReachLead => {
    const profile = record(row.linkedInUserProfile ?? row.lead ?? row.profile);
    const lastAction = time(row.lastActionTime);
    const connected = connection(row.leadConnectionStatus);
    const sentMessages = first(count(row.messagesSent), count(row.messagesSentCount), count(row.sentMessagesCount));
    const anyMessage = sentMessages !== null ? sentMessages : messaged(row.leadMessageStatus) ? 1 : 0;
    return {
      id: text(row.id) ?? text(row.leadId) ?? text(profile.id),
      profileUrl: text(profile.profileUrl) ?? text(row.profileUrl),
      firstName: text(profile.firstName),
      lastName: text(profile.lastName),
      companyName: text(profile.companyName),
      title: text(profile.position) ?? text(profile.headline),
      email: text(profile.emailAddress) ?? text(profile.email),
      accountId: text(row.linkedInAccountId) ?? text(row.accountId) ?? text(record(row.linkedInAccount).id),
      status: leadStatus(row.leadCampaignStatus ?? row.status),
      addedAt: time(row.creationTime) ?? time(row.addedTime),
      invitedAt: connected ? (time(row.connectionSentTime) ?? lastAction) : null,
      acceptedAt: connected === "accepted" ? (time(row.connectionAcceptedTime) ?? lastAction) : null,
      messagesSent: anyMessage,
      lastMessageAt: anyMessage > 0 ? (time(row.lastMessageSentTime) ?? lastAction) : null,
    };
  });
  const total = count(body.totalCount);
  const seen = offset + rows.length;
  const more = rows.length === HEYREACH_PAGE_SIZE && (total === undefined || seen < total);
  return { leads, next: more ? seen : null };
}
