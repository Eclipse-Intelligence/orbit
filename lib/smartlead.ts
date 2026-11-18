import type { CampaignStats, CampaignStatus, LeadStatus, Mailbox, SequenceStep } from "@/lib/campaigns/types";
import { htmlToText } from "@/lib/mail/text";
import { logUpstream, unreachable, upstreamMessage, urlSecrets } from "@/lib/upstream";
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
  options: SmartleadOptions & { query?: Record<string, string | number | null | undefined>; services?: Service[]; method?: "GET" | "POST" | "DELETE"; body?: Json; secrets?: string[] },
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
      const method = options.method ?? (options.body ? "POST" : "GET");
      response = await (options.fetchImpl ?? fetch)(url, {
        method,
        headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal,
      });
    } catch (error) {
      logUpstream("Smartlead", null, error, [key, ...(options.secrets ?? [])]);
      throw new SmartleadError(unreachable("Smartlead"), null);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logUpstream("Smartlead", response.status, body, [key, ...(options.secrets ?? [])]);
      throw new SmartleadError(upstreamMessage("Smartlead", response.status), response.status, response.headers.get("retry-after"));
    }
    const raw = await response.text().catch(() => "");
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      if ((options.method ?? (options.body ? "POST" : "GET")) !== "GET") return raw;
      logUpstream("Smartlead", response.status, error, [key, ...(options.secrets ?? [])]);
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

export type SmartleadMessage = {
  id: string;
  direction: "inbound" | "outbound";
  statsId: string | null;
  messageId: string | null;
  subject: string | null;
  body: string;
  html: string;
  sentAt: string;
  step: number | null;
  from: string | null;
  automatic: boolean;
};

const AUTOMATIC_REPLY = /out of (the )?office|auto(matic)?[- ]?reply|autoreply|auto-response|away from (the )?office/i;

export function automaticReply(...values: (string | null | undefined)[]) {
  return values.some((value) => Boolean(value && AUTOMATIC_REPLY.test(value)));
}

export async function readSmartleadThread(key: string, campaignId: string, leadId: string, options: SmartleadOptions = {}): Promise<SmartleadMessage[]> {
  const body = await call(key, `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/message-history`, options);
  const rows = (Array.isArray(body) ? body : list(record(body).history ?? record(body).data)).map(record);
  return rows.flatMap((row): SmartleadMessage[] => {
    const sentAt = time(row.time) ?? time(row.sent_time) ?? time(row.created_at);
    if (!sentAt) return [];
    const type = (text(row.type) ?? "").toUpperCase();
    const direction = type === "REPLY" || type === "RECEIVED" || type === "INBOUND" ? "inbound" : "outbound";
    const statsId = text(row.stats_id) ?? text(row.email_stats_id);
    const messageId = text(row.message_id);
    const html = text(row.email_body) ?? text(row.body) ?? "";
    const subject = text(row.subject);
    return [
      {
        id: messageId ?? `${statsId ?? "message"}:${direction}:${sentAt}`,
        direction,
        statsId,
        messageId,
        subject,
        body: htmlToText(html, 100_000),
        html,
        sentAt,
        step: count(row.email_seq_number) ?? count(row.seq_number) ?? count(row.sequence_number) ?? null,
        from: text(row.from) ?? text(row.from_email),
        automatic: direction === "inbound" && (yes(row.is_auto_reply) || yes(row.auto_reply) || automaticReply(text(row.reply_type), text(row.category), subject)),
      },
    ];
  });
}

function htmlBody(value: string) {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"))
    .join("<br>");
}

export type SmartleadReply = { statsId: string; replyTo: { messageId: string | null; sentAt: string; body: string } | null; text: string };

export async function sendSmartleadReply(key: string, campaignId: string, reply: SmartleadReply, options: SmartleadOptions = {}) {
  const body = await call(key, `/campaigns/${encodeURIComponent(campaignId)}/reply-email-thread`, {
    ...options,
    body: {
      email_stats_id: reply.statsId,
      email_body: htmlBody(reply.text),
      reply_message_id: reply.replyTo?.messageId ?? undefined,
      reply_email_time: reply.replyTo?.sentAt ?? undefined,
      reply_email_body: reply.replyTo ? htmlBody(reply.replyTo.body) : undefined,
      add_signature: true,
    },
  });
  const row = record(body);
  return { messageId: text(row.message_id) ?? text(record(row.data).message_id) };
}

export async function setSmartleadCampaignStatus(key: string, campaignId: string, status: "PAUSED" | "START", options: SmartleadOptions = {}) {
  await call(key, `/campaigns/${encodeURIComponent(campaignId)}/status`, { ...options, body: { status } });
}

export async function pauseSmartleadLead(key: string, campaignId: string, leadId: string, options: SmartleadOptions = {}) {
  await call(key, `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/pause`, { ...options, method: "POST" });
}

export async function resumeSmartleadLead(key: string, campaignId: string, leadId: string, options: SmartleadOptions = {}) {
  await call(key, `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/resume`, { ...options, body: { resume_lead_with_delay_days: 0 } });
}

export async function removeSmartleadLead(key: string, campaignId: string, leadId: string, options: SmartleadOptions = {}) {
  await call(key, `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}`, { ...options, method: "DELETE" });
}

export async function listSmartleadCategories(key: string, options: SmartleadOptions = {}) {
  const body = await call(key, "/leads/fetch-categories", options);
  const rows = (Array.isArray(body) ? body : list(record(body).data)).map(record);
  return rows.flatMap((row) => {
    const id = text(row.id);
    const name = text(row.name);
    return id && name ? [{ id, name }] : [];
  });
}

export async function setSmartleadCategory(key: string, campaignId: string, leadId: string, categoryId: string, options: SmartleadOptions = {}) {
  await call(key, `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/category`, {
    ...options,
    body: { category_id: Number.isFinite(Number(categoryId)) ? Number(categoryId) : categoryId, pause_lead: false },
  });
}

export const SMARTLEAD_PUSH_BATCH = 400;

export type SmartleadNewLead = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  website: string | null;
  linkedin: string | null;
  customFields: Record<string, string>;
};

export type SmartleadPush = { taken: number; refused: string[] };

const REFUSED_LISTS = ["invalid_emails", "unsubscribed_leads", "blocked_leads", "duplicate_leads", "bounced_leads", "skipped_leads"];

function refusedAddresses(body: Json) {
  const found = new Set<string>();
  for (const name of REFUSED_LISTS) {
    for (const item of list(body[name])) {
      const address = text(item) ?? text(record(item).email);
      if (address) found.add(address.toLowerCase());
    }
  }
  return [...found];
}

export async function addSmartleadLeads(key: string, campaignId: string, leads: SmartleadNewLead[], options: SmartleadOptions = {}): Promise<SmartleadPush> {
  if (leads.length === 0) return { taken: 0, refused: [] };
  const body = record(
    await call(key, `/campaigns/${encodeURIComponent(campaignId)}/leads`, {
      ...options,
      body: {
        lead_list: leads.slice(0, SMARTLEAD_PUSH_BATCH).map((lead) => ({
          email: lead.email,
          first_name: lead.firstName ?? "",
          last_name: lead.lastName ?? "",
          company_name: lead.companyName ?? "",
          website: lead.website ?? "",
          linkedin_profile: lead.linkedin ?? "",
          custom_fields: lead.customFields,
        })),
        settings: {
          ignore_global_block_list: false,
          ignore_unsubscribe_list: false,
          ignore_duplicate_leads_in_other_campaign: false,
        },
      },
    }),
  );
  const taken = (count(body.upload_count) ?? 0) + (count(body.already_added_to_campaign) ?? 0);
  return { taken, refused: refusedAddresses(body) };
}

export async function findSmartleadLead(key: string, campaignId: string, email: string, options: SmartleadOptions = {}): Promise<{ id: string } | null> {
  let body: unknown;
  try {
    body = await call(key, "/leads/", { ...options, query: { email } });
  } catch (error) {
    if (error instanceof SmartleadError && error.status === 404) return null;
    throw error;
  }
  const row = record(Array.isArray(body) ? body[0] : body);
  const id = text(row.id);
  if (!id) return null;
  const memberships = list(row.lead_campaign_data).map(record);
  if (!memberships.some((item) => text(item.campaign_id) === campaignId)) return null;
  return { id };
}

export const SMARTLEAD_BLOCK_BATCH = 100;

export async function blockSmartleadAddresses(key: string, addresses: string[], options: SmartleadOptions = {}) {
  if (addresses.length === 0) return;
  await call(key, "/leads/add-domain-block-list", { ...options, body: { domain_block_list: addresses.slice(0, SMARTLEAD_BLOCK_BATCH) } });
}

export const SMARTLEAD_WEBHOOK_EVENTS = ["EMAIL_REPLY", "LEAD_CATEGORY_UPDATED"] as const;

export async function createSmartleadWebhook(key: string, campaignId: string, url: string, options: SmartleadOptions = {}) {
  const body = await call(key, `/campaigns/${encodeURIComponent(campaignId)}/webhooks`, {
    ...options,
    secrets: urlSecrets(url),
    body: { id: null, name: "Orbit replies", webhook_url: url, event_types: [...SMARTLEAD_WEBHOOK_EVENTS], categories: [] },
  });
  const row = record(body);
  return text(row.id) ?? text(record(row.data).id) ?? "registered";
}

export type WebhookHint = {
  campaignId: string | null;
  leadId: string | null;
  email: string | null;
  linkedin: string | null;
  receiptKey: string;
};

export function smartleadWebhookHint(payload: unknown, requestId: string | null): WebhookHint | null {
  const row = record(payload);
  const lead = record(row.lead ?? row.lead_data);
  const campaignId = text(row.campaign_id) ?? text(record(row.campaign).id);
  const leadId = text(row.sl_email_lead_id) ?? text(row.lead_id) ?? text(lead.id);
  const email = text(row.sl_lead_email) ?? text(row.lead_email) ?? text(lead.email) ?? (text(row.event_type) === "EMAIL_REPLY" ? text(row.from_email) : null);
  if (!leadId && !email) return null;
  const at = text(row.event_timestamp) ?? text(record(row.reply_message).time) ?? text(row.time) ?? "";
  const receiptKey =
    requestId?.trim() || ["smartlead", text(row.event_type) ?? "", campaignId ?? "", leadId ?? email ?? "", text(row.sequence_number) ?? text(row.stats_id) ?? "", at].join("|");
  return { campaignId, leadId, email, linkedin: null, receiptKey };
}
