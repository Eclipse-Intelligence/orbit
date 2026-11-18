import type { CampaignStats, CampaignStatus, LeadStatus, SequenceStep } from "@/lib/campaigns/types";
import { logRefusal, logUpstream, providerReason, redactSecrets, refusedMessage, requestPath, scrubPersonal, unreachable, urlSecrets } from "@/lib/upstream";
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
  readonly keyCheck: boolean;

  constructor(message: string, status: number | null, retryAfter: string | null = null, keyCheck = false) {
    super(message);
    this.name = "HeyReachError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.keyCheck = keyCheck;
  }

  get rejectedKey() {
    return this.keyCheck && (this.status === 401 || this.status === 403);
  }
}

export const HEYREACH_UNREADABLE = "HeyReach sent a reply Orbit couldn't read.";

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

function campaignNumber(campaignId: string) {
  return Number.isFinite(Number(campaignId)) ? Number(campaignId) : campaignId;
}

function itemsOf(body: unknown) {
  if (Array.isArray(body)) return body.map(record);
  const items = record(body).items;
  if (!Array.isArray(items)) throw new HeyReachError(HEYREACH_UNREADABLE, null);
  return items.map(record);
}

function refusalReason(body: string, secrets: string[]) {
  const reason = providerReason(body, secrets);
  let fields: string | null = null;
  try {
    const parsed = record(JSON.parse(body));
    if (parsed.errors && typeof parsed.errors === "object") fields = providerReason(JSON.stringify({ errors: parsed.errors }), secrets);
  } catch {
    fields = null;
  }
  if (!fields || reason?.includes(fields)) return reason;
  return reason ? `${reason}: ${fields}` : fields;
}

const DETAIL_MAX = 800;

function titleOf(body: string, secrets: string[]) {
  try {
    const parsed = record(JSON.parse(body));
    const title = text(parsed.title) ?? text(parsed.errorMessage) ?? text(parsed.message);
    return title ? scrubPersonal(redactSecrets(title, secrets)).replace(/[.\s]+$/, "") : null;
  } catch {
    return null;
  }
}

export function validationDetail(body: string, secrets: string[]) {
  let errors: unknown;
  try {
    errors = record(JSON.parse(body)).errors;
  } catch {
    return null;
  }
  if (!errors || typeof errors !== "object") return null;
  const entries = Array.isArray(errors) ? errors.map((item, index) => [String(index), item] as const) : Object.entries(errors as Json);
  const parts = entries.flatMap(([name, value]) => {
    const messages = (Array.isArray(value) ? value : [value]).map((item) => (typeof item === "string" ? item : text(record(item).message) ?? text(record(item).errorMessage))).filter((item): item is string => Boolean(item));
    const line = scrubPersonal(redactSecrets(`${name}: ${messages.join(" ") || "invalid"}`.replace(/\s+/g, " ").trim(), secrets));
    return line ? [line] : [];
  });
  if (parts.length === 0) return null;
  const joined = parts.join("; ");
  return joined.length > DETAIL_MAX ? `${joined.slice(0, DETAIL_MAX - 1).trimEnd()}…` : joined;
}

export function heyReachEndpoint(url: URL) {
  return requestPath(url).replace(/^\/api\/public/, "").split("/").slice(0, 3).join("/");
}

async function call(
  key: string,
  path: string,
  options: HeyReachOptions & { method?: "GET" | "POST"; body?: Json; query?: Record<string, string>; secrets?: string[]; keyCheck?: boolean },
): Promise<unknown> {
  const keyCheck = options.keyCheck === true;
  const run = async () => {
    const url = new URL(`${HEYREACH_API}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
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
      logUpstream("HeyReach", null, error, [key, ...(options.secrets ?? [])]);
      throw new HeyReachError(unreachable("HeyReach"), null);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const secrets = [key, ...(options.secrets ?? [])];
      const reason = refusalReason(body, secrets);
      const endpoint = heyReachEndpoint(url);
      const detail = validationDetail(body, secrets);
      logRefusal("HeyReach", response.status, endpoint, detail ? `${titleOf(body, secrets) ?? "Refused"}. Fields ${detail}` : reason);
      const refused = (response.status === 401 || response.status === 403) && !keyCheck;
      throw new HeyReachError(
        refused ? `HeyReach refused this request (${response.status}).` : refusedMessage("HeyReach", response.status, reason, endpoint.split("/").pop()),
        response.status,
        response.headers.get("retry-after"),
        keyCheck,
      );
    }
    const raw = await response.text().catch(() => "");
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      logUpstream("HeyReach", response.status, error, [key, ...(options.secrets ?? [])]);
      throw new HeyReachError(HEYREACH_UNREADABLE, response.status);
    }
  };
  const statusOf = (error: unknown) => (error instanceof HeyReachError ? { status: error.status, retryAfter: error.retryAfter } : null);
  return withService("heyreach", run, { scope: options.workspaceId, statusOf });
}

async function allPages(key: string, path: string, options: HeyReachOptions & { keyCheck?: boolean; secrets?: string[] }, extra: Json = {}) {
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
  await call(key, "/auth/CheckApiKey", { ...options, keyCheck: true });
}

const CAMPAIGN_STATUSES: Record<string, CampaignStatus> = {
  DRAFT: "drafted",
  SCHEDULED: "active",
  STARTING: "active",
  IN_PROGRESS: "active",
  INPROGRESS: "active",
  ACTIVE: "active",
  RUNNING: "active",
  PAUSED: "paused",
  FINISHED: "completed",
  COMPLETED: "completed",
  CANCELED: "stopped",
  CANCELLED: "stopped",
  FAILED: "stopped",
  STOPPED: "stopped",
  ARCHIVED: "archived",
};

export function campaignStatus(value: unknown): CampaignStatus | null {
  return CAMPAIGN_STATUSES[(text(value) ?? "").toUpperCase().replace(/[\s-]/g, "_")] ?? null;
}

export const HEYREACH_LEAD_STATES = ["pending", "in_sequence", "finished", "paused", "failed", "excluded"] as const;
export type HeyReachLeadState = (typeof HEYREACH_LEAD_STATES)[number];

const LEAD_STATES: Record<string, HeyReachLeadState> = {
  PENDING: "pending",
  INSEQUENCE: "in_sequence",
  FINISHED: "finished",
  PAUSED: "paused",
  FAILED: "failed",
  EXCLUDED: "excluded",
  PENDINGOREXCLUDEDTOBECALCULATED: "pending",
};

export function heyReachLeadState(value: unknown): HeyReachLeadState | null {
  return LEAD_STATES[(text(value) ?? "").toUpperCase().replace(/[\s_-]/g, "")] ?? null;
}

export function leadStatus(value: unknown): LeadStatus | null {
  const status = (text(value) ?? "").toUpperCase().replace(/[\s_-]/g, "");
  if (!status) return null;
  if (status === "INSEQUENCE" || status === "INPROGRESS" || status === "ACTIVE" || status === "STARTING") return "in_progress";
  if (status === "PENDING" || status === "NOTSTARTED" || status === "QUEUED") return "not_started";
  if (status === "PAUSED") return "paused";
  if (status === "FINISHED" || status === "COMPLETED") return "completed";
  if (status === "FAILED" || status === "STOPPED" || status === "EXCLUDED" || status === "REMOVED" || status === "CANCELED" || status === "CANCELLED") return "stopped";
  return null;
}

export type HeyReachLeadCounts = {
  total?: number;
  enrolled?: number;
  notEnrolled?: number;
  finished?: number;
  paused?: number;
  failed?: number;
  excluded?: number;
};

export type HeyReachCampaign = { id: string; name: string; status: CampaignStatus | null; accountIds: string[]; listId: string | null; leadCounts: HeyReachLeadCounts | null };

function leadCountsOf(value: unknown): HeyReachLeadCounts | null {
  const row = record(value);
  if (Object.keys(row).length === 0) return null;
  const counts: HeyReachLeadCounts = {
    total: count(row.totalUsers),
    enrolled: count(row.totalUsersInProgress),
    notEnrolled: count(row.totalUsersPending),
    finished: count(row.totalUsersFinished),
    paused: first(count(row.totalUsersPaused), count(row.totalUsersManuallyStopped)) ?? undefined,
    failed: count(row.totalUsersFailed),
    excluded: count(row.totalUsersExcluded),
  };
  const kept = Object.fromEntries(Object.entries(counts).filter(([, item]) => item !== undefined)) as HeyReachLeadCounts;
  return Object.keys(kept).length > 0 ? kept : null;
}

export async function listHeyReachCampaigns(key: string, options: HeyReachOptions = {}): Promise<HeyReachCampaign[]> {
  const rows = await allPages(key, "/campaign/GetAll", { ...options, keyCheck: true });
  return rows.flatMap((row) => {
    const campaign = heyReachCampaignOf(row);
    return campaign ? [campaign] : [];
  });
}

function heyReachCampaignOf(row: Json): HeyReachCampaign | null {
  const id = text(row.id);
  if (!id) return null;
  const accounts = list(row.campaignAccountIds ?? row.linkedInAccountIds).map(text).filter((item): item is string => Boolean(item));
  return {
    id,
    name: text(row.name) ?? "",
    status: campaignStatus(row.status),
    accountIds: [...new Set(accounts)],
    listId: text(row.linkedInUserListId),
    leadCounts: leadCountsOf(row.progressStats),
  };
}

export async function readHeyReachCampaign(key: string, campaignId: string, options: HeyReachOptions = {}): Promise<HeyReachCampaign | null> {
  let body: unknown;
  try {
    body = await call(key, "/campaign/GetById", { ...options, query: { campaignId } });
  } catch (error) {
    if (error instanceof HeyReachError && error.status === 404) return null;
    throw error;
  }
  if (body === null) return null;
  const found = heyReachCampaignOf(record(body));
  if (!found) throw new HeyReachError(HEYREACH_UNREADABLE, null);
  return found;
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
    const name = [text(row.firstName), text(row.lastName)].filter(Boolean).join(" ");
    const limits = record(row.accountLimits);
    return [
      {
        id,
        name,
        email: text(row.emailAddress),
        profileUrl: text(row.profileUrl),
        inviteLimit: count(limits.connectioRequestLimit) ?? null,
        messageLimit: count(limits.messageLimit) ?? null,
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
  CONNECTION_REQUEST: "Invite",
  MESSAGE: "Message",
  INMAIL: "InMail",
  VIEW_PROFILE: "View profile",
  FOLLOW: "Follow",
  LIKE_POST: "Like post",
  FIND_EMAIL: "Find email",
  SEND_LEAD_TO_SMARTLEAD: "Send to Smartlead",
  SEND_LEAD_TO_INSTANTLY: "Send to Instantly",
  SEND_LEAD_TO_BISON: "Send to EmailBison",
};

function nodeType(node: Json) {
  return (text(node.nodeType) ?? "").toUpperCase();
}

function stepKind(node: Json) {
  return STEP_KINDS[nodeType(node)];
}

const SEQUENCE_DEPTH = 100;

function longestPath(node: Json, depth = 0): Json[] {
  if (depth > SEQUENCE_DEPTH || Object.keys(node).length === 0 || nodeType(node) === "END" || !nodeType(node)) return [];
  const branches = [node.conditionalNode, node.unconditionalNode].map((next) => longestPath(record(next), depth + 1));
  const longest = branches.reduce((best, branch) => (branch.filter(stepKind).length > best.filter(stepKind).length ? branch : best), branches[0]);
  return [node, ...longest];
}

function delayDays(node: Json) {
  const amount = count(node.actionDelay);
  if (amount === undefined) return undefined;
  return (text(node.actionDelayUnit) ?? "DAY").toUpperCase() === "HOUR" ? Math.round(amount / 24) : amount;
}

export function heyReachSteps(body: unknown): SequenceStep[] {
  const steps: SequenceStep[] = [];
  for (const node of longestPath(record(body))) {
    const kind = stepKind(node);
    if (!kind) continue;
    const payload = record(node.payload);
    const message = text(list(payload.messages)[0]) ?? text(payload.fallbackMessage) ?? "";
    steps.push({ step: steps.length + 1, variant: null, subject: kind, body: message, delayDays: delayDays(node) ?? null });
  }
  return steps;
}

export async function readHeyReachSequence(key: string, campaignId: string, options: HeyReachOptions = {}): Promise<SequenceStep[]> {
  return heyReachSteps(await call(key, "/campaign/GetCampaignSequence", { ...options, query: { campaignId } }));
}

export type HeyReachDay = { day: string; invites: number; accepted: number; messages: number; replies: number };

function statTotals(row: Json): CampaignStats {
  const stats: CampaignStats = {
    invites: count(row.connectionsSent),
    accepted: count(row.connectionsAccepted),
    messages: first(count(row.messagesSent), count(row.totalMessageStarted)) ?? undefined,
    replied: first(count(row.totalMessageReplies), count(row.messageReplies)) ?? undefined,
  };
  const inmailReplies = count(row.totalInmailReplies);
  if (inmailReplies !== undefined && stats.replied !== undefined) stats.replied += inmailReplies;
  const inmails = count(row.inmailMessagesSent);
  if (inmails !== undefined) stats.messages = (stats.messages ?? 0) + inmails;
  return Object.fromEntries(Object.entries(stats).filter(([, value]) => value !== undefined));
}

export async function readHeyReachStats(
  key: string,
  campaignId: string,
  options: HeyReachOptions & { now?: Date } = {},
): Promise<{ stats: CampaignStats; days: HeyReachDay[]; listId: string | null; leadCounts: HeyReachLeadCounts | null }> {
  const campaign = await readHeyReachCampaign(key, campaignId, options);
  const body = record(
    await call(key, "/stats/GetOverallStats", {
      ...options,
      body: { accountIds: [], campaignIds: [campaignNumber(campaignId)], startDate: STATS_FROM, endDate: (options.now ?? new Date()).toISOString() },
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
  return { stats, days, listId: campaign?.listId ?? null, leadCounts: campaign?.leadCounts ?? null };
}

export type HeyReachConnection = "none" | "sent" | "accepted";
export type HeyReachMessaging = "none" | "sent" | "replied";

export type HeyReachLead = {
  id: string | null;
  state: HeyReachLeadState | null;
  connection: HeyReachConnection | null;
  messaging: HeyReachMessaging | null;
  lastActionAt: string | null;
  senderName: string | null;
  profileUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  title: string | null;
  email: string | null;
  accountId: string | null;
  status: LeadStatus | null;
  rawStatus: string | null;
  addedAt: string | null;
  invitedAt: string | null;
  acceptedAt: string | null;
  messagesSent: number;
  lastMessageAt: string | null;
  tags: string[];
};

function connection(value: unknown): HeyReachConnection | null {
  const status = (text(value) ?? "").toUpperCase();
  if (status === "CONNECTIONACCEPTED") return "accepted";
  if (status === "CONNECTIONSENT") return "sent";
  if (status === "NONE") return "none";
  return null;
}

function messaging(value: unknown): HeyReachMessaging | null {
  const status = (text(value) ?? "").toUpperCase();
  if (status === "MESSAGEREPLY") return "replied";
  if (status === "MESSAGESENT") return "sent";
  if (status === "NONE") return "none";
  return null;
}

export const HEYREACH_SINCE_FILTER = "LastActionTakenOrFailedTime";

export async function listHeyReachLeads(
  key: string,
  campaignId: string,
  offset: number,
  options: HeyReachOptions & { since?: string | null; now?: Date } = {},
): Promise<{ leads: HeyReachLead[]; next: number | null }> {
  const body = record(
    await call(key, "/campaign/GetLeadsFromCampaign", {
      ...options,
      body: {
        campaignId: Number.isFinite(Number(campaignId)) ? Number(campaignId) : campaignId,
        offset,
        limit: HEYREACH_PAGE_SIZE,
        ...(options.since ? { timeFrom: options.since, timeTo: (options.now ?? new Date()).toISOString(), timeFilter: HEYREACH_SINCE_FILTER } : {}),
      },
    }),
  );
  const rows = itemsOf(body);
  const leads = rows.map((row): HeyReachLead => {
    const profile = record(row.linkedInUserProfile);
    const lastAction = time(row.lastActionTime);
    const connected = connection(row.leadConnectionStatus);
    const messages = messaging(row.leadMessageStatus);
    const anyMessage = count(row.messagesSent) ?? (messages === "sent" || messages === "replied" ? 1 : 0);
    return {
      id: text(row.id),
      state: heyReachLeadState(row.leadCampaignStatus),
      connection: connected,
      messaging: messages,
      lastActionAt: lastAction,
      senderName: text(row.linkedInSenderFullName),
      profileUrl: text(profile.profileUrl),
      firstName: text(profile.firstName),
      lastName: text(profile.lastName),
      companyName: text(profile.companyName),
      title: text(profile.position) ?? text(profile.headline),
      email: text(profile.emailAddress),
      accountId: text(row.linkedInSenderId),
      status: leadStatus(row.leadCampaignStatus),
      rawStatus: text(row.leadCampaignStatus),
      addedAt: time(row.creationTime),
      invitedAt: connected === "sent" || connected === "accepted" ? lastAction : null,
      acceptedAt: connected === "accepted" ? lastAction : null,
      messagesSent: anyMessage,
      lastMessageAt: anyMessage > 0 ? lastAction : null,
      tags: tagsOf(row.leadTags ?? profile.tags),
    };
  });
  const total = count(body.totalCount);
  const seen = offset + rows.length;
  const more = rows.length === HEYREACH_PAGE_SIZE && (total === undefined || seen < total);
  return { leads, next: more ? seen : null };
}

export const HEYREACH_LIST_PAGE = 500;

export type HeyReachListLead = {
  profileUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  title: string | null;
  email: string | null;
};

export async function listHeyReachListLeads(key: string, listId: string, offset: number, options: HeyReachOptions = {}): Promise<{ leads: HeyReachListLead[]; next: number | null }> {
  const body = record(await call(key, "/list/GetLeadsFromList", { ...options, body: { listId: campaignNumber(listId), offset, limit: HEYREACH_LIST_PAGE } }));
  const rows = itemsOf(body);
  const leads = rows.map(
    (row): HeyReachListLead => ({
      profileUrl: text(row.profileUrl),
      firstName: text(row.firstName),
      lastName: text(row.lastName),
      companyName: text(row.companyName),
      title: text(row.position) ?? text(row.headline),
      email: text(row.emailAddress),
    }),
  );
  const total = count(body.totalCount);
  const seen = offset + rows.length;
  const more = rows.length === HEYREACH_LIST_PAGE && (total === undefined || seen < total);
  return { leads, next: more ? seen : null };
}

export type HeyReachMessage = {
  at: string;
  body: string;
  fromThem: boolean;
  automatic: boolean;
};

export type HeyReachConversation = {
  id: string;
  accountId: string | null;
  profileUrl: string | null;
  leadId: string | null;
  lastMessageAt: string | null;
  messages: HeyReachMessage[] | null;
  tags: string[];
};

function fromThem(value: unknown, row: Json) {
  if (typeof row.isReply === "boolean") return row.isReply;
  if (typeof row.fromCorrespondent === "boolean") return row.fromCorrespondent;
  const sender = (text(value) ?? text(row.direction) ?? "").toUpperCase();
  return sender === "CORRESPONDENT" || sender === "THEM" || sender === "LEAD" || sender === "INBOUND" || sender === "RECEIVED";
}

function messagesOf(row: Json): HeyReachMessage[] | null {
  if (!Array.isArray(row.messages)) return null;
  return row.messages.map(record).flatMap((message): HeyReachMessage[] => {
    const at = time(message.createdAt) ?? time(message.sentAt) ?? time(message.timestamp);
    if (!at) return [];
    return [
      {
        at,
        body: text(message.body) ?? text(message.message) ?? text(message.text) ?? "",
        fromThem: fromThem(message.sender, message),
        automatic: message.isAutomatic === true || message.automatic === true,
      },
    ];
  });
}

function tagsOf(value: unknown) {
  return list(value)
    .map((tag) => text(tag) ?? text(record(tag).name) ?? text(record(tag).displayName))
    .filter((tag): tag is string => Boolean(tag));
}

function conversationOf(row: Json): HeyReachConversation | null {
  const id = text(row.id) ?? text(row.conversationId);
  if (!id) return null;
  const profile = record(row.correspondentProfile);
  return {
    id,
    accountId: text(row.linkedInAccountId) ?? text(record(row.linkedInAccount).id),
    profileUrl: text(profile.profileUrl),
    leadId: null,
    lastMessageAt: time(row.lastMessageAt),
    messages: messagesOf(row),
    tags: tagsOf(profile.tags ?? row.leadTags),
  };
}

export async function listHeyReachConversations(
  key: string,
  filter: { campaignId: string; profileUrl?: string | null },
  offset: number,
  options: HeyReachOptions = {},
): Promise<{ conversations: HeyReachConversation[]; next: number | null }> {
  const body = record(
    await call(key, "/inbox/GetConversationsV2", {
      ...options,
      body: {
        filters: { campaignIds: [campaignNumber(filter.campaignId)], ...(filter.profileUrl ? { leadProfileUrl: filter.profileUrl } : {}) },
        offset,
        limit: HEYREACH_PAGE_SIZE,
      },
    }),
  );
  const rows = itemsOf(body);
  const conversations = rows.map(conversationOf).filter((item): item is HeyReachConversation => Boolean(item));
  const total = count(body.totalCount);
  const seen = offset + rows.length;
  const more = rows.length === HEYREACH_PAGE_SIZE && (total === undefined || seen < total);
  return { conversations, next: more ? seen : null };
}

export async function readHeyReachChatroom(key: string, accountId: string, conversationId: string, options: HeyReachOptions = {}) {
  const body = record(await call(key, `/inbox/GetChatroom/${encodeURIComponent(accountId)}/${encodeURIComponent(conversationId)}`, options));
  return conversationOf({ id: conversationId, linkedInAccountId: accountId, ...body });
}

export async function sendHeyReachMessage(key: string, input: { conversationId: string; accountId: string; text: string }, options: HeyReachOptions = {}) {
  await call(key, "/inbox/SendMessage", {
    ...options,
    body: { message: input.text, subject: "", conversationId: input.conversationId, linkedInAccountId: Number.isFinite(Number(input.accountId)) ? Number(input.accountId) : input.accountId },
  });
}

export async function setHeyReachCampaignStatus(key: string, campaignId: string, status: "paused" | "active", options: HeyReachOptions = {}) {
  await call(key, status === "paused" ? "/campaign/Pause" : "/campaign/Resume", { ...options, method: "POST", query: { campaignId } });
}

export async function startHeyReachCampaign(key: string, campaignId: string, options: HeyReachOptions = {}) {
  await call(key, "/campaign/StartCampaign", { ...options, method: "POST", query: { campaignId } });
}

export async function stopHeyReachLead(key: string, campaignId: string, profileUrl: string, options: HeyReachOptions = {}) {
  await call(key, "/campaign/StopLeadInCampaign", {
    ...options,
    body: { campaignId: campaignNumber(campaignId), leadMemberId: null, leadUrl: profileUrl },
  });
}

export const HEYREACH_PUSH_BATCH = 100;

export type HeyReachNewLead = {
  profileUrl: string;
  firstName: string;
  lastName: string;
  companyName: string | null;
  position: string | null;
  email: string | null;
  accountId: string | null;
  customFields: Record<string, string>;
};

export async function addHeyReachLeads(key: string, campaignId: string, leads: HeyReachNewLead[], options: HeyReachOptions = {}) {
  if (leads.length === 0) return { taken: 0 };
  const body = record(
    await call(key, "/campaign/AddLeadsToCampaignV2", {
      ...options,
      body: {
        campaignId: campaignNumber(campaignId),
        accountLeadPairs: leads.slice(0, HEYREACH_PUSH_BATCH).map((lead) => ({
          ...(lead.accountId ? { linkedInAccountId: Number.isFinite(Number(lead.accountId)) ? Number(lead.accountId) : lead.accountId } : {}),
          lead: {
            firstName: lead.firstName,
            lastName: lead.lastName,
            profileUrl: lead.profileUrl,
            ...(lead.companyName ? { companyName: lead.companyName } : {}),
            ...(lead.position ? { position: lead.position } : {}),
            ...(lead.email ? { emailAddress: lead.email } : {}),
            customUserFields: Object.entries(lead.customFields).map(([name, value]) => ({ name, value })),
          },
        })),
      },
    }),
  );
  const taken = (count(body.addedLeadsCount) ?? count(body.added) ?? 0) + (count(body.updatedLeadsCount) ?? count(body.updated) ?? 0);
  return { taken };
}

export async function findHeyReachLead(key: string, campaignId: string, profileUrl: string, options: HeyReachOptions = {}): Promise<{ id: string | null } | null> {
  for (let offset = 0; ; offset += HEYREACH_PAGE_SIZE) {
    let body: unknown;
    try {
      body = await call(key, "/campaign/GetCampaignsForLead", { ...options, body: { profileUrl, offset, limit: HEYREACH_PAGE_SIZE } });
    } catch (error) {
      if (error instanceof HeyReachError && error.status === 404) return null;
      throw error;
    }
    if (body === null) return null;
    const rows = itemsOf(body);
    if (rows.some((row) => text(row.campaignId) === campaignId)) return { id: null };
    const total = count(record(body).totalCount);
    if (rows.length < HEYREACH_PAGE_SIZE || (total !== undefined && offset + rows.length >= total)) return null;
  }
}

export const HEYREACH_REPLY_EVENT = "EVERY_MESSAGE_REPLY_RECEIVED";

export const HEYREACH_ACTION_EVENTS = {
  CONNECTION_REQUEST_SENT: "invite_sent",
  CONNECTION_REQUEST_ACCEPTED: "invite_accepted",
  MESSAGE_SENT: "message_sent",
  INMAIL_SENT: "inmail_sent",
  FOLLOW_SENT: "followed",
  LIKED_POST: "post_liked",
  VIEWED_PROFILE: "profile_viewed",
} as const;

export type HeyReachActionEvent = keyof typeof HEYREACH_ACTION_EVENTS;

export const HEYREACH_TAG_EVENT = "LEAD_TAG_UPDATED";

export type HeyReachAutoTag = "positive" | "negative" | "generic";

export const HEYREACH_AUTO_TAG_EVENTS: Record<string, HeyReachAutoTag> = {
  LEAD_AUTO_TAGGED_INTERESTED: "positive",
  LEAD_AUTO_TAGGED_NOT_INTERESTED: "negative",
  LEAD_AUTO_TAGGED_GENERIC: "generic",
};

export const HEYREACH_POSITIVE_TAG_EVENT = "LEAD_AUTO_TAGGED_INTERESTED";

export const HEYREACH_CORE_WEBHOOK_EVENTS: string[] = [HEYREACH_REPLY_EVENT, ...Object.keys(HEYREACH_ACTION_EVENTS)];

export const HEYREACH_WEBHOOK_EVENTS: string[] = [...HEYREACH_CORE_WEBHOOK_EVENTS, HEYREACH_TAG_EVENT, ...Object.keys(HEYREACH_AUTO_TAG_EVENTS)];

export const HEYREACH_WEBHOOK_NAME_LIMIT = 25;

const WEBHOOK_NAMES: Record<string, string> = {
  [HEYREACH_REPLY_EVENT]: "replies",
  [HEYREACH_TAG_EVENT]: "tags",
  CONNECTION_REQUEST_SENT: "invite sent",
  CONNECTION_REQUEST_ACCEPTED: "invite accepted",
  MESSAGE_SENT: "message sent",
  INMAIL_SENT: "InMail sent",
  FOLLOW_SENT: "followed",
  LIKED_POST: "liked post",
  VIEWED_PROFILE: "viewed profile",
  LEAD_AUTO_TAGGED_INTERESTED: "interested",
  LEAD_AUTO_TAGGED_NOT_INTERESTED: "not interested",
  LEAD_AUTO_TAGGED_GENERIC: "auto tag",
};

export function heyReachWebhookName(eventType: string) {
  const what = WEBHOOK_NAMES[eventType] ?? eventType.toLowerCase().replace(/_/g, " ");
  return `Orbit ${what}`.slice(0, HEYREACH_WEBHOOK_NAME_LIMIT).trim();
}

export type HeyReachWebhook = { id: string; eventType: string; url: string; campaignIds: string[] | null; active: boolean };

function webhookCampaignIds(value: unknown) {
  if (!Array.isArray(value)) return null;
  const ids = value.map((item) => (typeof item === "number" && Number.isSafeInteger(item) ? String(item) : typeof item === "string" && /^\d+$/.test(item.trim()) ? item.trim() : null));
  return ids.every((id): id is string => id !== null) ? ids : null;
}

export async function listHeyReachWebhooks(key: string, url: string, options: HeyReachOptions = {}): Promise<HeyReachWebhook[]> {
  const rows = await allPages(key, "/webhooks/GetAllWebhooks", { ...options, secrets: urlSecrets(url) }, { includeCustomHeaders: false });
  return rows.flatMap((row) => {
    const id = text(row.id);
    const eventType = text(row.eventType);
    const webhookUrl = text(row.webhookUrl);
    if (!id || !eventType || !webhookUrl) return [];
    return [{ id, eventType: eventType.toUpperCase(), url: webhookUrl, campaignIds: webhookCampaignIds(row.campaignIds), active: row.isActive !== false }];
  });
}

export function allCampaignsWebhook(hooks: HeyReachWebhook[], url: string, eventType: string) {
  return hooks.find((hook) => hook.active && hook.url === url && hook.eventType === eventType && hook.campaignIds !== null && hook.campaignIds.length === 0)?.id ?? null;
}

export async function createHeyReachWebhook(key: string, url: string, options: HeyReachOptions & { eventType?: string } = {}) {
  const eventType = options.eventType ?? HEYREACH_REPLY_EVENT;
  const body = record(
    await call(key, "/webhooks/CreateWebhook", {
      ...options,
      secrets: urlSecrets(url),
      body: { webhookName: heyReachWebhookName(eventType), webhookUrl: url, eventType, campaignIds: [] },
    }),
  );
  return text(body.webhookId) ?? text(body.id) ?? text(record(body.data).id) ?? null;
}

function eventTypeOf(row: Json) {
  return (text(row.event_type) ?? text(row.eventType) ?? text(row.type) ?? "").toUpperCase().replace(/[\s-]/g, "_");
}

function leadOf(row: Json) {
  return record(row.lead ?? row.correspondent ?? row.correspondentProfile ?? row.leadProfile ?? row.lead_profile ?? row.profile);
}

function profileUrlOf(row: Json, lead: Json) {
  return (
    text(lead.profile_url) ??
    text(lead.profileUrl) ??
    text(lead.linkedin_url) ??
    text(lead.linkedinUrl) ??
    text(lead.linkedInUrl) ??
    text(row.leadProfileUrl) ??
    text(row.lead_profile_url) ??
    text(row.profileUrl) ??
    text(row.profile_url)
  );
}

export function webhookCampaignId(payload: unknown) {
  const row = record(payload);
  const campaign = record(row.campaign);
  return text(campaign.id) ?? text(campaign.campaignId) ?? text(row.campaignId) ?? text(row.campaign_id);
}

export type HeyReachWebhookAction = {
  campaignId: string | null;
  kind: (typeof HEYREACH_ACTION_EVENTS)[HeyReachActionEvent];
  profileUrl: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  title: string | null;
  accountId: string | null;
  at: string;
};

function eventTime(row: Json, now: Date) {
  return time(row.timestamp) ?? time(row.event_time) ?? time(row.eventTime) ?? time(row.creation_time) ?? time(row.createdAt) ?? now.toISOString();
}

export function heyReachWebhookAction(payload: unknown, now = new Date()): HeyReachWebhookAction | null {
  const row = record(payload);
  const kind = HEYREACH_ACTION_EVENTS[eventTypeOf(row) as HeyReachActionEvent];
  if (!kind) return null;
  const lead = leadOf(row);
  const profileUrl = profileUrlOf(row, lead);
  if (!profileUrl) return null;
  const sender = record(row.sender ?? row.linkedInAccount ?? row.linkedin_account);
  return {
    campaignId: webhookCampaignId(row),
    kind,
    profileUrl,
    firstName: text(lead.first_name) ?? text(lead.firstName),
    lastName: text(lead.last_name) ?? text(lead.lastName),
    companyName: text(lead.company_name) ?? text(lead.companyName),
    title: text(lead.position) ?? text(lead.headline),
    accountId: text(sender.id) ?? text(row.linkedInAccountId) ?? text(row.sender_id),
    at: eventTime(row, now),
  };
}

export type HeyReachWebhookTag = {
  campaignId: string | null;
  profileUrl: string;
  autoTag: HeyReachAutoTag | null;
  tags: string[] | null;
  at: string;
};

function tagNames(value: unknown) {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => (typeof item === "string" ? item.trim() : text(record(item).name) ?? text(record(item).tag) ?? text(record(item).displayName)))
    .filter((item): item is string => Boolean(item))
    .map((item) => item.slice(0, 100))
    .slice(0, 50);
}

export function heyReachWebhookTag(payload: unknown, now = new Date()): HeyReachWebhookTag | null {
  const row = record(payload);
  const type = eventTypeOf(row);
  const autoTag = HEYREACH_AUTO_TAG_EVENTS[type] ?? null;
  if (!autoTag && type !== HEYREACH_TAG_EVENT) return null;
  const lead = leadOf(row);
  const profileUrl = profileUrlOf(row, lead);
  if (!profileUrl) return null;
  return {
    campaignId: webhookCampaignId(row),
    profileUrl,
    autoTag,
    tags: tagNames(row.tags) ?? tagNames(lead.tags) ?? tagNames(row.lead_tags) ?? tagNames(row.leadTags) ?? (text(row.tag) ? [text(row.tag)!] : null),
    at: eventTime(row, now),
  };
}

const SHAPE_VALUES = /reference|step|index|node|event_?type|campaign_?id/i;

export function webhookShape(payload: unknown, prefix = "", depth = 0): string[] {
  if (depth > 4) return [];
  if (Array.isArray(payload)) return payload.length > 0 ? webhookShape(payload[0], `${prefix}[]`, depth + 1) : [`${prefix}[]`];
  if (!payload || typeof payload !== "object") return [];
  return Object.entries(payload as Json).flatMap(([name, value]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    if (value && typeof value === "object") return webhookShape(value, path, depth + 1);
    const plain = typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= 100);
    const shown = SHAPE_VALUES.test(name) && plain ? `=${String(value)}` : `:${value === null ? "null" : typeof value}`;
    return [`${path}${shown}`];
  });
}

export function heyReachWebhookHint(payload: unknown) {
  const row = record(payload);
  const lead = leadOf(row);
  const campaignId = webhookCampaignId(row);
  const leadId = text(lead.id) ?? text(row.leadId) ?? text(row.lead_id);
  const profileUrl = profileUrlOf(row, lead);
  if (!leadId && !profileUrl) return null;
  const messages = list(row.recent_messages ?? row.messages).map(record);
  const last = messages[messages.length - 1] ?? {};
  const at = text(last.creation_time) ?? text(last.createdAt) ?? text(row.timestamp) ?? text(row.event_time) ?? "";
  const conversation = text(row.conversation_id) ?? text(row.conversationId) ?? "";
  return { campaignId, leadId, profileUrl, receiptKey: ["heyreach", text(row.event_type) ?? text(row.eventType) ?? "", campaignId ?? "", leadId ?? profileUrl ?? "", conversation, at].join("|") };
}
