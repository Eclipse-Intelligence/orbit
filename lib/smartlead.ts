import type { CampaignStats, CampaignStatus, LeadStatus, Mailbox, SequenceStep } from "@/lib/campaigns/types";
import { logUpstream, unreachable, upstreamMessage } from "@/lib/upstream";
import { withService, type Service } from "@/lib/workflows/limits";

export const SMARTLEAD_API = "https://server.smartlead.ai/api/v1";
export const SMARTLEAD_APP = "https://app.smartlead.ai/app/email-campaign";
export const SMARTLEAD_PAGE_SIZE = 100;

const REQUEST_TIMEOUT_MS = 30_000;

export type SmartleadOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  workspaceId?: string;
};

export class SmartleadError extends Error {
  readonly status: number | null;
  readonly retryAfter: string | null;

  constructor(message: string, status: number | null, retryAfter: string | null = null) {
    super(message);
    this.name = "SmartleadError";
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
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function yes(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

async function call(
  key: string,
  path: string,
  options: SmartleadOptions & { query?: Record<string, string | number | null | undefined>; services?: Service[] },
): Promise<unknown> {
  const services = options.services ?? ["smartlead"];
  const run = async () => {
    const url = new URL(`${SMARTLEAD_API}${path}`);
    url.searchParams.set("api_key", key);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== null && value !== undefined && value !== "") url.searchParams.set(name, String(value));
    }
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(url, { headers: { accept: "application/json" }, signal });
    } catch (error) {
      logUpstream("Smartlead", null, error, [key]);
      throw new SmartleadError(unreachable("Smartlead"), null);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logUpstream("Smartlead", response.status, body, [key]);
      throw new SmartleadError(upstreamMessage("Smartlead", response.status), response.status, response.headers.get("retry-after"));
    }
    try {
      return await response.json();
    } catch (error) {
      logUpstream("Smartlead", response.status, error, [key]);
      throw new SmartleadError("Smartlead sent a reply Orbit couldn't read.", response.status);
    }
  };
  const statusOf = (error: unknown) => (error instanceof SmartleadError ? { status: error.status, retryAfter: error.retryAfter } : null);
  return services.reduceRight<() => Promise<unknown>>(
    (inner, service) => () => withService(service, inner, { scope: service === "smartlead" ? options.workspaceId : undefined, statusOf }),
    run,
  )();
}

export function campaignStatus(value: unknown): CampaignStatus {
  const status = (text(value) ?? "").toUpperCase();
  if (status === "ACTIVE" || status === "START" || status === "STARTED" || status === "INPROGRESS") return "active";
  if (status === "PAUSED") return "paused";
  if (status === "COMPLETED") return "completed";
  if (status === "STOPPED") return "stopped";
  if (status === "ARCHIVED") return "archived";
  return "drafted";
}

export function leadStatus(value: unknown): LeadStatus | null {
  const status = (text(value) ?? "").toUpperCase().replace(/[\s-]/g, "_");
  if (!status) return null;
  if (status === "STARTED" || status === "INPROGRESS" || status === "IN_PROGRESS") return "in_progress";
  if (status === "NOT_STARTED" || status === "NOTSTARTED" || status === "QUEUED") return "not_started";
  if (status === "PAUSED") return "paused";
  if (status === "COMPLETED") return "completed";
  if (status === "STOPPED") return "stopped";
  if (status === "BLOCKED") return "blocked";
  if (status === "UNSUBSCRIBED") return "unsubscribed";
  if (status === "BOUNCED") return "bounced";
  return null;
}

export type SmartleadCampaign = { id: string; name: string; status: CampaignStatus; clientId: string | null };

export async function listSmartleadCampaigns(key: string, options: SmartleadOptions = {}): Promise<SmartleadCampaign[]> {
  const body = await call(key, "/campaigns", options);
  const rows = Array.isArray(body) ? body : list(record(body).data);
  return rows.flatMap((item) => {
    const row = record(item);
    const id = text(row.id);
    if (!id) return [];
    return [{ id, name: text(row.name) ?? "", status: campaignStatus(row.status), clientId: text(row.client_id) }];
  });
}

export async function readSmartleadClient(key: string, clientIds: string[], options: SmartleadOptions = {}) {
  try {
    const body = await call(key, "/client/", options);
    const rows = (Array.isArray(body) ? body : list(record(body).data)).map(record);
    const match = rows.find((row) => clientIds.includes(text(row.id) ?? "")) ?? (rows.length === 1 ? rows[0] : null);
    if (!match) return null;
    return { id: text(match.id), name: text(match.name) };
  } catch (error) {
    if (error instanceof SmartleadError && error.status !== null && error.status !== 429 && error.status < 500) return null;
    throw error;
  }
}

export function variablesIn(steps: SequenceStep[]) {
  const names = new Set<string>();
  for (const step of steps) {
    for (const match of `${step.subject}\n${step.body}`.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) names.add(match[1]);
  }
  return [...names].sort();
}

export async function readSmartleadSequence(key: string, campaignId: string, options: SmartleadOptions = {}): Promise<SequenceStep[]> {
  const body = await call(key, `/campaigns/${encodeURIComponent(campaignId)}/sequences`, options);
  const rows = (Array.isArray(body) ? body : list(record(body).data)).map(record);
  const steps: SequenceStep[] = [];
  rows.forEach((row, index) => {
    const step = count(row.seq_number) ?? index + 1;
    const delayDays = count(record(row.seq_delay_details).delay_in_days) ?? count(row.delay_in_days) ?? null;
    const variants = list(row.sequence_variants ?? row.seq_variants).map(record);
    if (variants.length === 0) {
      steps.push({ step, variant: null, subject: text(row.subject) ?? "", body: text(row.email_body) ?? "", delayDays });
      return;
    }
    variants.forEach((variant, position) => {
      steps.push({
        step,
        variant: text(variant.variant_label) ?? String.fromCharCode(65 + position),
        subject: text(variant.subject) ?? text(row.subject) ?? "",
        body: text(variant.email_body) ?? "",
        delayDays,
      });
    });
  });
  return steps.sort((a, b) => a.step - b.step || (a.variant ?? "").localeCompare(b.variant ?? ""));
}

export async function readSmartleadStats(key: string, campaignId: string, options: SmartleadOptions = {}): Promise<CampaignStats> {
  const row = record(await call(key, `/campaigns/${encodeURIComponent(campaignId)}/analytics`, options));
  const leads = record(row.campaign_lead_stats);
  const stats: CampaignStats = {
    prospects: count(leads.total) ?? count(row.total_count),
    contacted: count(row.unique_sent_count),
    sent: count(row.sent_count),
    opened: count(row.unique_open_count) ?? count(row.open_count),
    clicked: count(row.unique_click_count) ?? count(row.click_count),
    replied: count(row.reply_count),
    positive: count(leads.interested),
    bounced: count(row.bounce_count),
    unsubscribed: count(row.unsubscribed_count),
  };
  return Object.fromEntries(Object.entries(stats).filter(([, value]) => value !== undefined));
}

export type SmartleadLead = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  website: string | null;
  linkedin: string | null;
  title: string | null;
  status: LeadStatus | null;
  category: string | null;
  addedAt: string | null;
};

export async function listSmartleadLeads(
  key: string,
  campaignId: string,
  offset: number,
  options: SmartleadOptions = {},
): Promise<{ leads: SmartleadLead[]; next: number | null }> {
  const body = record(
    await call(key, `/campaigns/${encodeURIComponent(campaignId)}/leads`, {
      ...options,
      query: { offset, limit: SMARTLEAD_PAGE_SIZE },
    }),
  );
  const rows = list(body.data).map(record);
  const leads = rows.flatMap((row): SmartleadLead[] => {
    const lead = record(row.lead);
    const id = text(lead.id) ?? text(row.lead_id);
    if (!id) return [];
    return [
      {
        id,
        email: text(lead.email),
        firstName: text(lead.first_name),
        lastName: text(lead.last_name),
        companyName: text(lead.company_name),
        website: text(lead.website) ?? text(lead.company_url),
        linkedin: text(lead.linkedin_profile),
        title: text(record(lead.custom_fields).title) ?? text(lead.job_title),
        status: leadStatus(row.status ?? row.lead_status),
        category: text(row.lead_category) ?? text(record(row.lead_category).name),
        addedAt: time(row.created_at) ?? time(lead.created_at),
      },
    ];
  });
  const total = count(body.total_leads);
  const seen = offset + rows.length;
  const more = rows.length === SMARTLEAD_PAGE_SIZE && (total === undefined || seen < total);
  return { leads, next: more ? seen : null };
}

export type SmartleadStatRow = {
  leadId: string | null;
  email: string | null;
  name: string | null;
  category: string | null;
  step: number | null;
  variant: string | null;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  repliedAt: string | null;
  bounced: boolean;
  unsubscribed: boolean;
};

export async function readSmartleadStatistics(
  key: string,
  campaignId: string,
  since: string | null,
  offset: number,
  options: SmartleadOptions = {},
): Promise<{ rows: SmartleadStatRow[]; next: number | null }> {
  const body = await call(key, `/campaigns/${encodeURIComponent(campaignId)}/leads-statistics`, {
    ...options,
    services: ["smartlead_stats", "smartlead"],
    query: { event_time_gt: since, limit: SMARTLEAD_PAGE_SIZE, offset },
  });
  const raw = (Array.isArray(body) ? body : list(record(body).data)).map(record);
  const rows = raw.map(
    (row): SmartleadStatRow => ({
      leadId: text(row.lead_id) ?? text(row.email_lead_id),
      email: text(row.lead_email) ?? text(row.email),
      name: text(row.lead_name),
      category: text(row.lead_category),
      step: count(row.sequence_number) ?? count(row.email_seq_number) ?? null,
      variant: text(row.variant_label) ?? text(row.seq_variant_label),
      sentAt: time(row.sent_time),
      openedAt: time(row.open_time),
      clickedAt: time(row.click_time),
      repliedAt: time(row.reply_time),
      bounced: yes(row.is_bounced),
      unsubscribed: yes(row.is_unsubscribed),
    }),
  );
  const more = record(body).hasMore === true || record(body).has_more === true || raw.length === SMARTLEAD_PAGE_SIZE;
  return { rows, next: more && raw.length > 0 ? offset + raw.length : null };
}

export async function readSmartleadMailboxes(key: string, campaignId: string, options: SmartleadOptions = {}): Promise<Mailbox[]> {
  const body = await call(key, `/campaigns/${encodeURIComponent(campaignId)}/email-accounts`, options);
  const rows = (Array.isArray(body) ? body : list(record(body).data)).map(record);
  return rows.flatMap((row): Mailbox[] => {
    const address = text(row.from_email) ?? text(row.email);
    if (!address) return [];
    const warmup = record(row.warmup_details);
    const reputation = count(String(text(warmup.warmup_reputation) ?? "").replace("%", ""));
    const problem =
      row.is_smtp_success === false
        ? "Can't send"
        : row.is_imap_success === false
          ? "Can't read replies"
          : reputation !== undefined && reputation < 90
            ? `Warm-up reputation ${reputation}%`
            : null;
    return [{ address, dailyLimit: count(row.message_per_day) ?? count(row.max_email_per_day) ?? null, problem }];
  });
}
