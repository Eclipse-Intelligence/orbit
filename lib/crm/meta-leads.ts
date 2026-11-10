import { after } from "next/server";
import { clientIp } from "@/lib/booking/book";
import { withActor } from "@/lib/crm/context";
import { createActivityInDb } from "@/lib/crm/activities";
import { createCompanyInDb, readCompanyInDb } from "@/lib/crm/companies";
import { isFreeMailDomain } from "@/lib/crm/communications";
import { readContactInDb, updateContactInDb, upsertContactInDb } from "@/lib/crm/contacts";
import { memberActor } from "@/lib/crm/conversations";
import { CrmError, isPgError, notSetUp, ShownError } from "@/lib/crm/errors";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { lockNamespace, recordAudit } from "@/lib/crm/mutate";
import { canonicalDomain, canonicalEmail, isSharedHost, normalizeCompanyName, normalizeTag, TAG_LIMIT } from "@/lib/crm/normalize";
import { alertLink, workspaceActors } from "@/lib/crm/workspaces";
import type { Company, Contact, ContactWrite, Provenance, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query, type Db } from "@/lib/db/pool";
import {
  cut,
  fetchMetaForm,
  fetchMetaLead,
  fetchMetaPage,
  listMetaForms,
  listMetaLeadsPage,
  metaAccessToken,
  metaConfigured,
  metaEnvStatus,
  metaId,
  verifyMetaChallenge,
  verifyMetaSignature,
  type MetaLead,
} from "@/lib/meta";
import { pushToUser, type PushSender } from "@/lib/push";

const META_LEAD_SOURCE = "Meta Lead Ad";
const META_LEAD_TAG = "Meta lead";
const META_WEBHOOK_PATH = "/api/webhooks/meta-leads";
const META_SETTINGS_HREF = "/settings/tools#meta-leads";

const PROVENANCE: Provenance = { operation: "meta_lead_ad", source: "meta_lead_ad", automatic: true };
const MAX_BODY_BYTES = 1024 * 1024;
const RATE_LIMIT = 300;
const RATE_WINDOW_SECONDS = 60;
const WEBHOOK_BUDGET_MS = 45_000;
const BACKUP_EVERY = "1 hour";
const OVERLAP_MS = 2 * 60 * 60 * 1000;
const FIRST_LOOK_BACK_MS = 24 * 60 * 60 * 1000;
const STEP_RESERVE_MS = 1_500;
const ALERT_RESERVE_MS = 3_000;
const PAGE_RESERVE_MS = 3_000;
const RETRY_SHARE = 0.4;
const MAX_VALUE = 1000;
const MAX_ANSWERS = 100;
const MAX_ANSWER_BYTES = 60_000;
const MAX_RAW_BYTES = 150_000;
const NO_DETAILS = "The lead has no name, email, phone or company.";
const MIN_TIME = Date.UTC(1970, 0, 1);
const MAX_TIME = Date.UTC(9999, 11, 31);

type LeadChange = { leadgenId: string; pageId: string | null; formId: string | null; adId: string | null; raw: Record<string, unknown> };

type Answer = { name: string; label: string; values: string[] };

type Via = "webhook" | "backup";

export type MetaLeadOptions = {
  fetchImpl?: typeof fetch;
  deadline?: number;
  send?: PushSender;
  schedule?: (work: () => Promise<void>) => void;
  rateLimit?: boolean;
};

type RunContext = MetaLeadOptions & { heldAlerted?: Set<string>; token?: string };

type MemberRow = {
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

type Pending = {
  id: string;
  leadgenId: string;
  pageId: string | null;
  formId: string | null;
  adId: string | null;
  fetched: boolean;
  filed: boolean;
  workspaceId: string | null;
  linkedBy: string | null;
  via: Via;
};

type LeadRow = {
  id: string;
  workspace_id: string;
  leadgen_id: string;
  page_id: string | null;
  form_id: string | null;
  form_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  platform: string | null;
  is_organic: boolean | null;
  lead_created_at: Date | null;
  answers: unknown;
  fetched_at: Date | null;
  filed_at: Date | null;
};

type FiledLead = {
  leadId: string;
  leadgenId: string;
  contactId: string | null;
  companyId: string | null;
  activityId: string | null;
  name: string | null;
  campaign: string | null;
  form: string | null;
};

function errorType(error: unknown) {
  if (isPgError(error)) return `pg ${error.code}`;
  if (error instanceof CrmError) return `crm ${error.code}`;
  if (error instanceof Error) return error.name;
  return typeof error;
}

function logFailure(context: string, id: string | null, error: unknown) {
  console.error(context, { id, type: errorType(error) });
}

function shownMessage(error: unknown, fallback: string) {
  return error instanceof ShownError && error.message.trim() ? cut(error.message.replace(/\s+/g, " ").trim(), 500) : fallback;
}

function background(work: () => Promise<void>) {
  const guarded = () => work().catch((error) => logFailure("Meta lead job failed", null, error));
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

function timeLeft(deadline: number | undefined, reserve = STEP_RESERVE_MS) {
  return !deadline || deadline - Date.now() > reserve;
}

function remainingMs(deadline: number | undefined) {
  return deadline ? Math.max(0, Math.floor(deadline - Date.now())) : Number.POSITIVE_INFINITY;
}

const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function plain(value: string, max = MAX_VALUE) {
  return cut(value.toWellFormed().normalize("NFC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim(), max).trim();
}

const LABELS: Record<string, string> = {
  full_name: "Full name",
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  work_email: "Work email",
  phone_number: "Phone",
  work_phone_number: "Work phone",
  job_title: "Job title",
  company_name: "Company",
  city: "City",
  state: "State",
  province: "Province",
  country: "Country",
  post_code: "Postcode",
  zip_code: "Postcode",
  street_address: "Address",
};

function answerLabel(name: string) {
  const known = LABELS[name.toLowerCase()];
  if (known) return known;
  const words = plain(name.replace(/_+/g, " "), 200);
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Answer";
}

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function readAnswers(fieldData: unknown): Answer[] {
  if (!Array.isArray(fieldData)) return [];
  const answers: Answer[] = [];
  let size = 2;
  for (const item of fieldData.slice(0, MAX_ANSWERS)) {
    if (!item || typeof item !== "object") continue;
    const rawName = (item as { name?: unknown }).name;
    const rawValues = (item as { values?: unknown }).values;
    if (typeof rawName !== "string") continue;
    const name = plain(rawName, 200);
    if (!name) continue;
    const list = Array.isArray(rawValues) ? rawValues : rawValues === undefined || rawValues === null ? [] : [rawValues];
    const values = list
      .filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value))
      .map((value) => plain(String(value)))
      .filter(Boolean)
      .slice(0, 20);
    const entry = { name, label: answerLabel(name), values };
    const entryBytes = bytes(entry) + 1;
    if (size + entryBytes > MAX_ANSWER_BYTES) continue;
    size += entryBytes;
    answers.push(entry);
  }
  return answers;
}

function valuesOf(answers: Answer[], names: string[]) {
  return names.flatMap((name) => answers.find((item) => item.name.toLowerCase() === name)?.values ?? []);
}

function joined(answers: Answer[], ...names: string[]) {
  for (const name of names) {
    const value = answers.find((item) => item.name.toLowerCase() === name)?.values.join(", ").trim();
    if (value) return value;
  }
  return null;
}

function firstEmail(values: string[]) {
  for (const value of values) {
    const email = value.includes("@") ? canonicalEmail(value) : null;
    if (email) return email;
  }
  return null;
}

function firstPhone(values: string[]) {
  const value = values.find((item) => /^\+?[\d\s().-]{6,40}$/.test(item) && item.replace(/\D/g, "").length >= 6);
  return value ? clip(value, 40) : null;
}

type LeadPerson = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  companyName: string | null;
  city: string | null;
};

function clip(value: string | null, max: number) {
  return value ? cut(value, max).trim() || null : null;
}

const SOMEONE_ELSE = /refer|friend|partner|colleague|manager|assistant|other|someone|recommend/i;
const EMAIL_WORDS = new Set(["email", "mail", "emailaddress", "mailaddress"]);
const PHONE_WORDS = new Set(["phone", "phonenumber", "mobile", "mobilenumber", "tel", "telephone", "telefon", "telefonnummer", "cell", "cellphone", "whatsapp"]);

function keyWords(name: string) {
  return name
    .toLowerCase()
    .replace(/e-mail/g, "email")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function ownAnswers(answers: Answer[], words: Set<string>) {
  return answers.filter((item) => !SOMEONE_ELSE.test(item.name) && keyWords(item.name).some((word) => words.has(word)));
}

export function leadPerson(answers: Answer[]): LeadPerson {
  const full = joined(answers, "full_name");
  let firstName = joined(answers, "first_name");
  let lastName = joined(answers, "last_name");
  if (!firstName && !lastName && full) {
    const parts = full.split(" ").filter(Boolean);
    firstName = parts[0] ?? null;
    lastName = parts.slice(1).join(" ") || null;
  }
  const email = firstEmail(valuesOf(answers, ["email", "work_email"])) ?? firstEmail(ownAnswers(answers, EMAIL_WORDS).flatMap((item) => item.values));
  const phone =
    firstPhone(valuesOf(answers, ["phone_number", "work_phone_number", "user_provided_phone_number"])) ??
    firstPhone(ownAnswers(answers, PHONE_WORDS).flatMap((item) => item.values));
  return {
    firstName: clip(firstName, 80),
    lastName: clip(lastName, 80),
    email,
    phone,
    jobTitle: clip(joined(answers, "job_title"), 120),
    companyName: clip(joined(answers, "company_name"), 200),
    city: clip(joined(answers, "city"), 200),
  };
}

function platformLabel(value: unknown) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "fb" || key === "facebook") return "Facebook";
  if (key === "ig" || key === "instagram") return "Instagram";
  if (key === "msg" || key === "messenger") return "Messenger";
  const label = plain(value, 40);
  return label || null;
}

export function isoTime(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = typeof value === "number" ? value * 1000 : new Date(value).getTime();
  return Number.isFinite(time) && time >= MIN_TIME && time <= MAX_TIME ? new Date(time).toISOString() : null;
}

function text(value: unknown, max = 300) {
  return typeof value === "string" ? plain(value, max) || null : null;
}

function normaliseLead(lead: MetaLead, formName: string | null) {
  return {
    form_id: metaId(lead.form_id),
    form_name: formName ? plain(formName, 300) || null : null,
    ad_id: metaId(lead.ad_id),
    ad_name: text(lead.ad_name),
    adset_id: metaId(lead.adset_id),
    adset_name: text(lead.adset_name),
    campaign_id: metaId(lead.campaign_id),
    campaign_name: text(lead.campaign_name),
    platform: platformLabel(lead.platform),
    is_organic: typeof lead.is_organic === "boolean" ? lead.is_organic : null,
    created_at: isoTime(lead.created_time),
    answers: readAnswers(lead.field_data),
  };
}

function wellFormed(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.toWellFormed().replace(/\u0000/g, "");
  if (depth > 20 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => wellFormed(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [wellFormed(key, depth + 1) as string, wellFormed(item, depth + 1)]));
}

export function rawLead(lead: MetaLead): Record<string, unknown> {
  try {
    const raw = JSON.stringify(wellFormed(lead));
    if (Buffer.byteLength(raw, "utf8") <= MAX_RAW_BYTES) return JSON.parse(raw) as Record<string, unknown>;
  } catch {}
  return { id: String(lead.id), truncated: true };
}

const ID_KEYS = /("(?:leadgen_id|page_id|form_id|ad_id|adgroup_id|id)"\s*:\s*)(\d+)(?=\s*[,}\]])/g;

export function parseMetaWebhook(raw: string): LeadChange[] | null {
  let body: unknown;
  try {
    body = JSON.parse(raw.replace(ID_KEYS, '$1"$2"'));
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const changes: LeadChange[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const list = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(list)) continue;
    for (const change of list) {
      if (!change || typeof change !== "object") continue;
      if ((change as { field?: unknown }).field !== "leadgen") continue;
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== "object") continue;
      const fields = value as Record<string, unknown>;
      const leadgenId = metaId(fields.leadgen_id);
      if (!leadgenId || seen.has(leadgenId)) continue;
      seen.add(leadgenId);
      const pageId = metaId(fields.page_id) ?? metaId((entry as { id?: unknown }).id);
      const formId = metaId(fields.form_id);
      const adId = metaId(fields.ad_id);
      changes.push({
        leadgenId,
        pageId,
        formId,
        adId,
        raw: { leadgen_id: leadgenId, page_id: pageId, form_id: formId, ad_id: adId, adgroup_id: metaId(fields.adgroup_id), created_time: isoTime(fields.created_time) },
      });
    }
  }
  return changes;
}

async function readCapped(request: Request, max: number) {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function allowed(request: Request) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [
    `meta-leads:${clientIp(request.headers)}`,
    RATE_LIMIT,
    RATE_WINDOW_SECONDS,
  ]);
  return Boolean(result.rows[0]?.allowed);
}

const NO_STORE = { "cache-control": "no-store" };

export function handleMetaVerification(request: Request) {
  const challenge = verifyMetaChallenge(new URL(request.url).searchParams);
  if (challenge === null) return new Response("Forbidden", { status: 403, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } });
  return new Response(challenge, { status: 200, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } });
}

type ReceivedRow = { id: string; leadgen_id: string; workspace_id: string | null; fetched: boolean; filed: boolean; linked_by: string | null };

async function receive(changes: LeadChange[], via: Via) {
  const items = changes.map((change) => ({ leadgen_id: change.leadgenId, page_id: change.pageId, form_id: change.formId, ad_id: change.adId, payload: { webhook: change.raw } }));
  const result = await query<ReceivedRow>("select * from private.meta_leads_receive($1::jsonb, $2)", [JSON.stringify(items), via]);
  return result.rows;
}

export async function handleMetaLeadsWebhook(request: Request, options: MetaLeadOptions = {}) {
  const started = Date.now();
  try {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) return Response.json({ error: "Too large." }, { status: 413, headers: NO_STORE });
    if (options.rateLimit !== false && !(await allowed(request))) {
      return Response.json({ error: "Too many requests." }, { status: 429, headers: NO_STORE });
    }
    const raw = await readCapped(request, MAX_BODY_BYTES);
    if (raw === null) return Response.json({ error: "Too large." }, { status: 413, headers: NO_STORE });
    if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"))) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
    }
    const changes = parseMetaWebhook(raw.toString("utf8"));
    if (changes === null) return Response.json({ error: "Invalid body." }, { status: 400, headers: NO_STORE });
    if (changes.length > 0) {
      const rows = await receive(changes, "webhook");
      const byId = new Map(changes.map((change) => [change.leadgenId, change]));
      const pending = rows
        .filter((row) => !row.filed)
        .map((row): Pending => {
          const change = byId.get(row.leadgen_id);
          return {
            id: row.id,
            leadgenId: row.leadgen_id,
            pageId: change?.pageId ?? null,
            formId: change?.formId ?? null,
            adId: change?.adId ?? null,
            fetched: row.fetched,
            filed: row.filed,
            workspaceId: row.workspace_id,
            linkedBy: row.linked_by,
            via: "webhook",
          };
        });
      if (pending.length > 0) {
        const deadline = options.deadline ?? started + WEBHOOK_BUDGET_MS;
        (options.schedule ?? background)(() => processAll(pending, { ...options, deadline }));
      }
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    logFailure("Meta lead webhook failed", null, error);
    return Response.json({ error: "Try again later." }, { status: 503, headers: NO_STORE });
  }
}

type SavedRow = { id: string; workspace_id: string | null; fetched: boolean; filed: boolean; linked_by: string | null };

async function save(leadgenId: string, input: { pageId: string | null; formId: string | null; adId: string | null; via: Via; lead: ReturnType<typeof normaliseLead>; payload: Record<string, unknown> }) {
  const result = await query<SavedRow>("select * from private.meta_lead_save($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)", [
    leadgenId,
    input.pageId,
    input.formId,
    input.adId,
    input.via,
    JSON.stringify(input.lead),
    JSON.stringify(input.payload),
  ]);
  return result.rows[0] ?? null;
}

async function markFailed(id: string, message: string) {
  await query("select private.meta_lead_failed($1, $2)", [id, cut(message, 500)]).catch((error) => logFailure("Meta lead failure not saved", id, error));
}

async function processAll(pending: Pending[], options: RunContext) {
  const forms = new Map<string, string | null>();
  const context: RunContext = { ...options, heldAlerted: options.heldAlerted ?? new Set() };
  for (const item of pending) {
    if (!timeLeft(context.deadline)) break;
    await processSafely(item, forms, context);
  }
}

async function processSafely(pending: Pending, forms: Map<string, string | null>, options: RunContext) {
  try {
    return await processLead(pending, forms, options);
  } catch (error) {
    logFailure("Meta lead not processed", pending.id, error);
    await markFailed(pending.id, shownMessage(error, "Couldn't save the lead."));
    return null;
  }
}

async function formName(formId: string | null, forms: Map<string, string | null>, options: MetaLeadOptions) {
  if (!formId) return null;
  if (forms.has(formId)) return forms.get(formId) ?? null;
  const name = await fetchMetaForm(formId, { fetchImpl: options.fetchImpl, deadline: options.deadline })
    .then((form) => form.name)
    .catch(() => null);
  forms.set(formId, name);
  return name;
}

async function processLead(pending: Pending, forms: Map<string, string | null>, options: RunContext) {
  if (pending.filed) {
    if (pending.workspaceId) await notifyFiled(pending.id, pending.workspaceId, pending.linkedBy, options);
    return null;
  }
  let workspaceId = pending.workspaceId;
  let linkedBy = pending.linkedBy;
  if (!pending.fetched) {
    let lead: MetaLead;
    try {
      lead = await fetchMetaLead(pending.leadgenId, { fetchImpl: options.fetchImpl, deadline: options.deadline });
    } catch (error) {
      await markFailed(pending.id, shownMessage(error, "Couldn't fetch the lead from Meta."));
      if (!workspaceId && pending.pageId) await alertHeld(pending.pageId, options);
      return null;
    }
    const formId = metaId(lead.form_id) ?? pending.formId;
    const normalised = normaliseLead(lead, await formName(formId, forms, options));
    const row = await save(pending.leadgenId, { pageId: pending.pageId, formId, adId: metaId(lead.ad_id) ?? pending.adId, via: pending.via, lead: normalised, payload: { lead: rawLead(lead) } });
    if (!row || row.filed) return null;
    workspaceId = row.workspace_id;
    linkedBy = row.linked_by;
  }
  if (!workspaceId) {
    if (pending.pageId) await alertHeld(pending.pageId, options);
    return null;
  }
  return fileAndAlert(pending.id, workspaceId, linkedBy, options);
}

async function workspaceMembers(workspaceId: string) {
  const result = await query<MemberRow>("select workspace_id, workspace_name, user_id, role, email, full_name from private.background_members()");
  return result.rows.filter((row) => row.workspace_id === workspaceId);
}

function filingActor(members: MemberRow[], linkedBy: string | null) {
  const admins = members.filter((member) => member.role === "owner" || member.role === "admin");
  const chosen = admins.find((member) => member.user_id === linkedBy) ?? admins.find((member) => member.role === "owner") ?? admins[0];
  return chosen ? memberActor(chosen) : null;
}

async function fileAndAlert(leadId: string, workspaceId: string, linkedBy: string | null, options: MetaLeadOptions) {
  const members = await workspaceMembers(workspaceId);
  const actor = filingActor(members, linkedBy);
  if (!actor) {
    await markFailed(leadId, "Nobody in the workspace can take the lead.");
    return null;
  }
  let filed: FiledLead | null;
  try {
    filed = await fileMetaLead(actor, leadId);
  } catch (error) {
    logFailure("Meta lead not filed", leadId, error);
    await markFailed(leadId, shownMessage(error, "Couldn't save the lead."));
    return null;
  }
  if (filed && timeLeft(options.deadline, ALERT_RESERVE_MS)) {
    try {
      await alertNewLead(filed, members, linkedBy, options);
    } catch (error) {
      logFailure("Meta lead alert failed", leadId, error);
      await markFailed(leadId, "Couldn't send the notification.");
    }
  }
  return filed;
}

async function notifyFiled(leadId: string, workspaceId: string, linkedBy: string | null, options: MetaLeadOptions) {
  const members = await workspaceMembers(workspaceId);
  const actor = filingActor(members, linkedBy);
  if (!actor) return;
  const filed = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string; leadgen_id: string; contact_id: string | null; company_id: string | null; activity_id: string | null; campaign_name: string | null; form_name: string | null; contact_name: string | null; company_name: string | null }>(
      `select l.id, l.leadgen_id, l.contact_id, l.company_id, l.activity_id, l.campaign_name, l.form_name,
              nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as contact_name, co.name as company_name
       from crm.meta_leads l
       left join crm.contacts c on c.id = l.contact_id
       left join crm.companies co on co.id = l.company_id
       where l.id = $1 and l.workspace_id = $2 and l.filed_at is not null`,
      [leadId, workspaceId],
    );
    return result.rows[0] ?? null;
  });
  if (!filed) return;
  await alertNewLead(
    {
      leadId: filed.id,
      leadgenId: filed.leadgen_id,
      contactId: filed.contact_id,
      companyId: filed.company_id,
      activityId: filed.activity_id,
      name: filed.contact_name ?? filed.company_name,
      campaign: filed.campaign_name,
      form: filed.form_name,
    },
    members,
    linkedBy,
    options,
  );
}

function personName(person: LeadPerson) {
  return [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
}

function activityBody(row: Pick<LeadRow, "campaign_name" | "adset_name" | "ad_name" | "platform" | "is_organic">, answers: Answer[]) {
  const lines = answers.map((item) => `${item.label}: ${item.values.join(", ") || "(blank)"}`);
  const details = [
    row.campaign_name ? `Campaign: ${row.campaign_name}` : null,
    row.adset_name ? `Ad set: ${row.adset_name}` : null,
    row.ad_name ? `Ad: ${row.ad_name}` : null,
    row.platform ? `Platform: ${row.platform}` : null,
    row.is_organic ? "Organic: yes" : null,
  ].filter((line): line is string => Boolean(line));
  const body = [lines.join("\n"), details.join("\n")].filter(Boolean).join("\n\n");
  return body.length > 9_500 ? `${cut(body, 9_500).trim()}\n…` : body;
}

function leadDomain(email: string | null) {
  const raw = email?.split("@")[1];
  const domain = raw ? canonicalDomain(raw) : null;
  if (!domain || isFreeMailDomain(domain) || isSharedHost(domain) || /^\d{1,3}(\.\d{1,3}){3}$/.test(domain) || !domain.includes(".")) return null;
  return domain;
}

async function matchCompany(db: Db, actor: UserActor, person: LeadPerson, leadgenId: string): Promise<{ company: Company | null; created: boolean }> {
  if (!person.companyName) return { company: null, created: false };
  const normalized = normalizeCompanyName(person.companyName);
  if (!normalized) return { company: null, created: false };
  const domain = leadDomain(person.email);
  await lockNamespace(db, actor.workspaceId, "companies");
  if (domain) {
    const byDomain = await db.query<{ id: string }>(
      "select id from crm.companies where workspace_id = $1 and archived_at is null and domain = $2 order by updated_at desc limit 1",
      [actor.workspaceId, domain],
    );
    if (byDomain.rows[0]) return { company: await readCompanyInDb(db, byDomain.rows[0].id, actor.workspaceId), created: false };
  }
  const byName = await db.query<{ id: string }>(
    `select id from crm.companies
     where workspace_id = $1 and archived_at is null and normalized_name = $2 and ($3::text is null or domain is null)
     order by (domain is null) desc, updated_at desc limit 1`,
    [actor.workspaceId, normalized, domain],
  );
  if (byName.rows[0]) return { company: await readCompanyInDb(db, byName.rows[0].id, actor.workspaceId), created: false };
  const company = await createCompanyInDb(
    db,
    actor,
    { name: person.companyName, domain, lifecycle: "lead", source: META_LEAD_SOURCE, sourceReference: leadgenId },
    PROVENANCE,
  );
  return { company, created: true };
}

function withTag(tags: string[]) {
  const tag = normalizeTag(META_LEAD_TAG);
  if (tags.includes(tag) || tags.length >= TAG_LIMIT) return null;
  return [...tags, tag];
}

async function matchContact(db: Db, actor: UserActor, person: LeadPerson, companyId: string | null, leadgenId: string): Promise<{ contact: Contact | null; created: boolean }> {
  const identifiable = Boolean(person.firstName || person.lastName || person.email || person.phone);
  if (!identifiable) return { contact: null, created: false };
  await lockNamespace(db, actor.workspaceId, "contacts");
  if (person.email) {
    const existing = await db.query<{ id: string }>(
      `select id from crm.contacts
       where workspace_id = $1 and archived_at is null and normalized_email = $2
       order by updated_at desc limit 1`,
      [actor.workspaceId, person.email],
    );
    const found = existing.rows[0] ? await readContactInDb(db, existing.rows[0].id, actor.workspaceId) : null;
    if (found) {
      const fill: ContactWrite = {};
      if (!found.firstName && person.firstName) fill.firstName = person.firstName;
      if (!found.lastName && person.lastName) fill.lastName = person.lastName;
      if (!found.phone && person.phone) fill.phone = person.phone;
      if (!found.jobTitle && person.jobTitle) fill.jobTitle = person.jobTitle;
      if (!found.location && person.city) fill.location = person.city;
      if (!found.companyId && companyId) fill.companyId = companyId;
      if (!found.source) fill.source = META_LEAD_SOURCE;
      if (!found.sourceReference) fill.sourceReference = leadgenId;
      const tags = withTag(found.tags);
      if (tags) fill.tags = tags;
      if (Object.keys(fill).length === 0) return { contact: found, created: false };
      const updated = await updateContactInDb(db, actor, found.id, fill, PROVENANCE);
      return { contact: updated.contact, created: false };
    }
  }
  const result = await upsertContactInDb(
    db,
    actor,
    {
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      phone: person.phone,
      jobTitle: person.jobTitle,
      location: person.city,
      companyId,
      source: META_LEAD_SOURCE,
      sourceReference: leadgenId,
      tags: [META_LEAD_TAG],
    },
    PROVENANCE,
    { nameMatch: false },
  );
  return { contact: result.contact, created: result.created };
}

async function degrade<T>(db: Db, name: string, leadId: string, fallback: T, attempts: (() => Promise<T>)[]) {
  for (const attempt of attempts) {
    await db.query(`savepoint ${name}`);
    try {
      const result = await attempt();
      await db.query(`release savepoint ${name}`);
      return result;
    } catch (error) {
      await db.query(`rollback to savepoint ${name}`);
      await db.query(`release savepoint ${name}`);
      if (!(error instanceof CrmError)) throw error;
      logFailure(`Meta lead ${name} skipped`, leadId, error);
    }
  }
  return fallback;
}

async function fileMetaLead(actor: UserActor, leadId: string): Promise<FiledLead | null> {
  return withActor(actor, async (db) => {
    const found = await db.query<LeadRow>(
      `select id, workspace_id, leadgen_id, page_id, form_id, form_name, ad_id, ad_name, adset_id, adset_name,
              campaign_id, campaign_name, platform, is_organic, lead_created_at, answers, fetched_at, filed_at
       from crm.meta_leads where id = $1 and workspace_id = $2 for update`,
      [leadId, actor.workspaceId],
    );
    const row = found.rows[0];
    if (!row || row.filed_at || !row.fetched_at) return null;
    const answers = readAnswers(Array.isArray(row.answers) ? row.answers : []);
    const person = leadPerson(answers);
    const company = await degrade<{ company: Company | null; created: boolean }>(db, "meta_company", row.id, { company: null, created: false }, [
      () => matchCompany(db, actor, person, row.leadgen_id),
    ]);
    const companyId = company.company?.id ?? null;
    const contact = await degrade<{ contact: Contact | null; created: boolean }>(db, "meta_contact", row.id, { contact: null, created: false }, [
      () => matchContact(db, actor, person, companyId, row.leadgen_id),
      () => matchContact(db, actor, { ...person, phone: null, jobTitle: null, city: null }, companyId, row.leadgen_id),
      () => matchContact(db, actor, { ...person, phone: null, jobTitle: null, city: null }, null, row.leadgen_id),
    ]);
    let activityId: string | null = null;
    if (contact.contact || company.company) {
      const activity = await createActivityInDb(
        db,
        actor,
        {
          type: "note",
          title: cut(`Meta lead: ${row.form_name ?? "Lead form"}`, 200),
          body: activityBody(row, answers) || "No answers.",
          occurredAt: row.lead_created_at ? new Date(row.lead_created_at).toISOString() : undefined,
          contactId: contact.contact?.id ?? null,
          companyId: companyId ?? contact.contact?.companyId ?? null,
          metadata: {
            source: "meta_lead_ad",
            metaLeadId: row.id,
            leadgenId: row.leadgen_id,
            pageId: row.page_id,
            formId: row.form_id,
            adId: row.ad_id,
            adsetId: row.adset_id,
            campaignId: row.campaign_id,
          },
        },
        PROVENANCE,
      );
      activityId = activity.id;
      await recordAudit(db, actor, "lead.created", "lead", contact.contact?.id ?? companyId!, PROVENANCE, {
        companyId,
        contactId: contact.contact?.id ?? null,
        companyCreated: company.created,
        contactCreated: contact.created,
        activityId,
        metaLeadId: row.id,
        leadgenId: row.leadgen_id,
        formId: row.form_id,
        campaignId: row.campaign_id,
      });
    }
    await db.query("update crm.meta_leads set contact_id = $2, company_id = $3, activity_id = $4, filed_at = now(), error = $5 where id = $1", [
      row.id,
      contact.contact?.id ?? null,
      companyId,
      activityId,
      activityId ? null : NO_DETAILS,
    ]);
    const name = personName(person) || contact.contact?.name || person.email || company.company?.name || null;
    return {
      leadId: row.id,
      leadgenId: row.leadgen_id,
      contactId: contact.contact?.id ?? null,
      companyId,
      activityId,
      name,
      campaign: row.campaign_name,
      form: row.form_name,
    };
  });
}

async function alert(actor: UserActor, input: { key: string; title: string; body: string; href: string }, options: MetaLeadOptions) {
  const key = cut(input.key, 500);
  const title = cut(input.title, 200);
  const href = await alertLink(actor, input.href);
  const fresh = await withActor(actor, async (db) => {
    const logged = await db.query("insert into crm.push_log (workspace_id, user_id, key) values ($1, $2, $3) on conflict (user_id, key) do nothing returning id", [
      actor.workspaceId,
      actor.userId,
      key,
    ]);
    if ((logged.rowCount ?? 0) === 0) return false;
    await db.query("insert into crm.notifications (workspace_id, user_id, title, body, href, source) values ($1, $2, $3, $4, $5, 'meta_lead')", [
      actor.workspaceId,
      actor.userId,
      title,
      input.body ? cut(input.body, 4000) : null,
      href,
    ]);
    return true;
  });
  if (!fresh) return false;
  const wait = remainingMs(options.deadline) - STEP_RESERVE_MS;
  if (wait <= 0) return true;
  const pushed = pushToUser(actor, { title: cut(input.title, 120), body: cut(input.body, 400), url: input.href, tag: key }, { send: options.send }).catch((error) =>
    logFailure("Meta lead push failed", actor.userId, error),
  );
  if (Number.isFinite(wait)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pushed, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(1, Math.floor(wait)))))]);
    if (timer) clearTimeout(timer);
  } else {
    await pushed;
  }
  return true;
}

async function alertNewLead(filed: FiledLead, members: MemberRow[], linkedBy: string | null, options: MetaLeadOptions) {
  const recipients = members.filter((member) => member.role === "owner" || member.role === "admin" || member.user_id === linkedBy);
  const href = filed.contactId ? contactHref(filed.contactId) : filed.companyId ? companyHref(filed.companyId) : META_SETTINGS_HREF;
  const body = filed.campaign ?? filed.form ?? META_LEAD_SOURCE;
  const title = filed.activityId ? `New lead: ${filed.name ?? "Unnamed lead"}` : "New lead without contact details";
  const results = await Promise.allSettled(recipients.map((member) => alert(memberActor(member), { key: `meta-lead:${filed.leadgenId}`, title, body, href }, options)));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  await query("select private.meta_lead_notified($1)", [filed.leadId]);
}

async function alertHeld(pageId: string, options: RunContext) {
  if (options.heldAlerted?.has(pageId)) return;
  options.heldAlerted?.add(pageId);
  try {
    const owners = await query<MemberRow>("select * from private.meta_lead_alert_owners()");
    const day = new Date().toISOString().slice(0, 10);
    await Promise.allSettled(
      owners.rows.map((owner) =>
        alert(memberActor(owner), { key: `meta-unlinked:${pageId}:${day}`, title: "Lead from a Page that isn't linked", body: `Page ${pageId}`, href: META_SETTINGS_HREF }, options),
      ),
    );
  } catch (error) {
    logFailure("Meta held lead alert failed", pageId, error);
  }
}

type WaitingRow = {
  id: string;
  workspace_id: string | null;
  leadgen_id: string;
  page_id: string | null;
  form_id: string | null;
  ad_id: string | null;
  fetched: boolean;
  filed: boolean;
  linked_by: string | null;
  received_via: Via;
};

async function fileWaitingLeads(options: RunContext & { pageId?: string; limit?: number } = {}) {
  const waiting = await query<WaitingRow>("select * from private.meta_leads_waiting($1, $2)", [options.limit ?? 50, options.pageId ?? null]);
  const forms = new Map<string, string | null>();
  const context: RunContext = { ...options, heldAlerted: options.heldAlerted ?? new Set() };
  let filed = 0;
  for (const row of waiting.rows) {
    if (!timeLeft(context.deadline)) break;
    if (!row.fetched && !metaAccessToken()) continue;
    const result = await processSafely(
      {
        id: row.id,
        leadgenId: row.leadgen_id,
        pageId: row.page_id,
        formId: row.form_id,
        adId: row.ad_id,
        fetched: row.fetched,
        filed: row.filed,
        workspaceId: row.workspace_id,
        linkedBy: row.linked_by,
        via: row.received_via,
      },
      forms,
      context,
    );
    if (result) filed += 1;
  }
  return { waiting: waiting.rows.length, filed };
}

type DuePage = {
  id: string;
  workspace_id: string;
  page_id: string;
  page_name: string | null;
  linked_by: string | null;
  full_history: boolean;
  last_run_at: Date | null;
  created_at: Date;
};

type FormCursor = { form_id: string; last_run_at: Date | null; last_attempt_at: Date | null; list_since: Date | null; list_after: string | null; list_started_at: Date | null };

type PageRun = { imported: number; skipped: number; complete: boolean; errors: string[]; name: string | null; started: Date };

async function backupLead(page: DuePage, formId: string, formName: string | null, lead: MetaLead, options: RunContext) {
  let row: SavedRow | null;
  try {
    row = await save(lead.id, { pageId: page.page_id, formId, adId: metaId(lead.ad_id), via: "backup", lead: normaliseLead(lead, formName), payload: { lead: rawLead(lead) } });
  } catch (error) {
    logFailure("Meta lead not saved", lead.id, error);
    const stub = (await receive([{ leadgenId: lead.id, pageId: page.page_id, formId, adId: metaId(lead.ad_id), raw: {} }], "backup"))[0];
    if (stub) await markFailed(stub.id, shownMessage(error, "Couldn't save the lead."));
    return "failed" as const;
  }
  if (!row || row.filed) return "skipped" as const;
  if (!row.workspace_id) return "held" as const;
  const filed = await fileAndAlert(row.id, row.workspace_id, row.linked_by ?? page.linked_by, options);
  return filed ? ("imported" as const) : ("failed" as const);
}

function outOfTime(deadline: number | undefined) {
  return Boolean(deadline) && deadline! - Date.now() <= 600;
}

async function backupForm(page: DuePage, form: { id: string; name: string | null }, cursor: FormCursor | undefined, floor: number, run: PageRun, options: RunContext) {
  const base = { fetchImpl: options.fetchImpl, deadline: options.deadline };
  const resuming = Boolean(cursor?.list_after && cursor.list_since && cursor.list_started_at);
  const listStarted = resuming ? new Date(cursor!.list_started_at!) : new Date();
  const fromCursor = cursor?.last_run_at ? new Date(cursor.last_run_at).getTime() - OVERLAP_MS : floor;
  const since = resuming ? new Date(cursor!.list_since!) : new Date(Math.max(fromCursor, floor));
  let after = resuming ? cursor!.list_after : null;
  for (;;) {
    if (!timeLeft(options.deadline)) {
      run.complete = false;
      return;
    }
    let listed: { leads: MetaLead[]; after: string | null };
    try {
      listed = await listMetaLeadsPage(form.id, since, after, { ...base, token: options.token });
    } catch (error) {
      if (outOfTime(options.deadline)) {
        run.complete = false;
        return;
      }
      const message = shownMessage(error, "Couldn't read the form's leads.");
      run.errors.push(message);
      await query("select private.meta_lead_form_ran($1, $2, $3, $4, false, $5)", [page.page_id, form.id, form.name, listStarted.toISOString(), message]);
      return;
    }
    for (const lead of listed.leads) {
      if (!timeLeft(options.deadline)) {
        run.complete = false;
        return;
      }
      const outcome = await backupLead(page, form.id, form.name, lead, options);
      if (outcome === "imported") run.imported += 1;
      if (outcome === "skipped") run.skipped += 1;
    }
    if (!listed.after) {
      await query("select private.meta_lead_form_ran($1, $2, $3, $4, true, null)", [page.page_id, form.id, form.name, listStarted.toISOString()]);
      return;
    }
    after = listed.after;
    await query("select private.meta_lead_form_progress($1, $2, $3, $4, $5, $6)", [page.page_id, form.id, form.name, since.toISOString(), after, listStarted.toISOString()]);
  }
}

async function backupPage(page: DuePage, options: RunContext): Promise<PageRun> {
  const started = new Date();
  const base = { fetchImpl: options.fetchImpl, deadline: options.deadline };
  const info = await fetchMetaPage(page.page_id, base).catch(() => ({ name: null, accessToken: null }));
  const run: PageRun = { imported: 0, skipped: 0, complete: true, errors: [], name: info.name, started };
  let forms: { id: string; name: string | null }[];
  try {
    forms = await listMetaForms(page.page_id, { ...base, token: info.accessToken ?? undefined });
  } catch (error) {
    if (outOfTime(options.deadline)) {
      run.complete = false;
      return run;
    }
    throw error;
  }
  const cursors = new Map((await query<FormCursor>("select * from private.meta_lead_form_cursors($1)", [page.page_id])).rows.map((row) => [row.form_id, row]));
  const ordered = [...forms].sort((left, right) => {
    const a = cursors.get(left.id)?.last_attempt_at ? new Date(cursors.get(left.id)!.last_attempt_at!).getTime() : 0;
    const b = cursors.get(right.id)?.last_attempt_at ? new Date(cursors.get(right.id)!.last_attempt_at!).getTime() : 0;
    return a - b;
  });
  const linkedAt = new Date(page.created_at).getTime();
  const floor = page.full_history ? linkedAt - FIRST_LOOK_BACK_MS : linkedAt;
  const scoped: RunContext = { ...options, token: info.accessToken ?? undefined };
  for (const form of ordered) {
    if (!timeLeft(options.deadline)) {
      run.complete = false;
      break;
    }
    await backupForm(page, form, cursors.get(form.id), floor, run, scoped);
    if (!run.complete) break;
  }
  return run;
}

export async function metaLeadWorkDue() {
  if (!metaAccessToken()) return false;
  const result = await query<{ due: boolean }>("select private.meta_lead_work_due($1::interval) as due", [BACKUP_EVERY]);
  return Boolean(result.rows[0]?.due);
}

export async function runMetaLeadBackup(options: MetaLeadOptions = {}) {
  const empty = { pages: [] as { pageId: string; imported?: number; skipped?: number; complete?: boolean; error?: string }[], retried: { waiting: 0, filed: 0 } };
  if (!metaAccessToken()) return { skipped: "Meta lead ads isn't set up.", ...empty };
  const deadline = Math.floor(options.deadline ?? Date.now() + 10_000);
  const context: RunContext = { ...options, deadline, heldAlerted: new Set() };
  const due = await query<DuePage>("select * from private.meta_lead_pages_due($1::interval)", [BACKUP_EVERY]);
  const retryUntil = due.rows.length === 0 ? deadline : Math.floor(Date.now() + Math.max(0, deadline - Date.now()) * RETRY_SHARE);
  const retried = await fileWaitingLeads({ ...context, deadline: retryUntil }).catch((error) => {
    logFailure("Meta lead retry failed", null, error);
    return { waiting: 0, filed: 0 };
  });
  const pages = empty.pages;
  for (const page of due.rows) {
    if (!timeLeft(deadline, PAGE_RESERVE_MS)) break;
    try {
      const run = await backupPage(page, context);
      const ok = run.errors.length === 0 && run.complete;
      const error = run.errors[0] ?? (run.complete ? null : "Not finished. Orbit carries on in the next run.");
      await query("select private.meta_lead_page_ran($1, $2, $3, $4, $5, $6)", [page.id, run.started.toISOString(), ok, run.complete, error, run.name]);
      pages.push({ pageId: page.page_id, imported: run.imported, skipped: run.skipped, complete: run.complete, ...(error ? { error } : {}) });
    } catch (error) {
      const message = shownMessage(error, "Couldn't check the Page for leads.");
      await query("select private.meta_lead_page_ran($1, now(), false, true, $2, null)", [page.id, message]);
      pages.push({ pageId: page.page_id, error: message });
    }
  }
  return { pages, retried };
}

type MetaLeadPageView = {
  id: string;
  pageId: string;
  pageName: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  leads: number | null;
};

type HeldPageView = { pageId: string; leads: number; lastAt: string | null; linkedHere: boolean; linkedTo: string | null };

export type MetaLeadSettingsView = {
  endpoint: string;
  configured: boolean;
  setupMessage: string | null;
  pages: MetaLeadPageView[];
  held: HeldPageView[];
};

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

export async function getMetaLeadSettings(actor: UserActor, origin: string): Promise<MetaLeadSettingsView> {
  const canAdmin = actor.role === "owner" || actor.role === "admin";
  const configured = metaConfigured();
  const missing = metaEnvStatus()
    .filter((item) => !item.set)
    .map((item) => item.name);
  const [pages, held] = await Promise.all([
    withActor(actor, async (db) => {
      const result = await db.query<{ id: string; page_id: string; page_name: string | null; last_run_at: Date | null; last_error: string | null; leads: number }>(
        `select p.id, p.page_id, p.page_name, p.last_run_at, p.last_error,
                (select count(*) from crm.meta_leads l where l.workspace_id = p.workspace_id and l.page_id = p.page_id)::integer as leads
         from crm.meta_lead_pages p
         where p.workspace_id = $1
         order by p.created_at`,
        [actor.workspaceId],
      );
      return result.rows;
    }),
    actor.role === "owner"
      ? query<{ page_id: string; leads: number; last_at: Date | null; linked_workspace_id: string | null }>("select * from private.meta_held_pages($1)", [actor.userId]).then((result) => result.rows)
      : Promise.resolve([]),
  ]);
  const names = held.some((row) => row.linked_workspace_id && row.linked_workspace_id !== actor.workspaceId)
    ? new Map((await workspaceActors(actor)).map((item) => [item.workspaceId, item.workspaceName]))
    : new Map<string, string>();
  return {
    endpoint: `${origin.replace(/\/+$/, "")}${META_WEBHOOK_PATH}`,
    configured,
    setupMessage: configured ? null : canAdmin ? notSetUp("Meta lead ads", missing.join(", "), actor) : notSetUp("Meta lead ads"),
    pages: pages.map((row) => ({
      id: row.id,
      pageId: row.page_id,
      pageName: row.page_name,
      lastRunAt: iso(row.last_run_at),
      lastError: row.last_error,
      leads: canAdmin ? row.leads : null,
    })),
    held: held.map((row) => ({
      pageId: row.page_id,
      leads: row.leads,
      lastAt: iso(row.last_at),
      linkedHere: row.linked_workspace_id === actor.workspaceId,
      linkedTo: row.linked_workspace_id && row.linked_workspace_id !== actor.workspaceId ? (names.get(row.linked_workspace_id) ?? null) : null,
    })),
  };
}

function assertAdmin(actor: UserActor) {
  if (actor.role !== "owner" && actor.role !== "admin") {
    throw new CrmError("forbidden", "Only owners and admins can change Meta lead ads.", 403);
  }
}

function readPageId(value: unknown) {
  const id = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  const parsed = metaId(id);
  if (!parsed) throw new CrmError("invalid_input", "Enter the Page ID, digits only.", 400, { field: "pageId" });
  return parsed;
}

async function release(actor: UserActor, pageId: string) {
  const result = await query<{ count: number }>("select private.meta_release_held($1, $2, $3) as count", [actor.userId, pageId, actor.workspaceId]);
  return result.rows[0]?.count ?? 0;
}

function fileSoon(pageId: string, options: MetaLeadOptions) {
  (options.schedule ?? background)(async () => {
    await fileWaitingLeads({ ...options, pageId, deadline: options.deadline ?? Date.now() + 40_000 });
  });
}

export async function linkMetaPage(actor: UserActor, value: unknown, options: MetaLeadOptions = {}) {
  assertAdmin(actor);
  const pageId = readPageId(value);
  try {
    await withActor(actor, async (db) => {
      await db.query("insert into crm.meta_lead_pages (workspace_id, page_id, linked_by) values ($1, $2, $3)", [actor.workspaceId, pageId, actor.userId]);
      await recordAudit(db, actor, "integration.connected", "integration", actor.workspaceId, { operation: "link_meta_page", source: "web" }, { integration: "meta_lead_ads", pageId });
    });
  } catch (error) {
    if (isPgError(error) && error.code === "23505" && error.constraint === "meta_lead_pages_unique") {
      const visible = await withActor(actor, (db) =>
        db.query<{ here: boolean }>("select workspace_id = $2 as here from crm.meta_lead_pages where page_id = $1", [pageId, actor.workspaceId]),
      );
      const row = visible.rows[0];
      if (row?.here) throw new CrmError("conflict", "This Page is already linked.", 409, { field: "pageId" });
      if (row) throw new CrmError("conflict", "Couldn't link this Page. It's already linked to another workspace.", 409, { field: "pageId" });
      throw new CrmError("conflict", "Couldn't link this Page.", 409, { field: "pageId" });
    }
    throw error;
  }
  let released = 0;
  try {
    await query("select private.meta_lead_page_linked($1, $2, $3)", [actor.userId, pageId, actor.workspaceId]);
    released = await release(actor, pageId);
  } catch (error) {
    logFailure("Meta held leads not released", pageId, error);
  }
  fileSoon(pageId, options);
  return { pageId, released };
}

export async function addHeldLeads(actor: UserActor, value: unknown, options: MetaLeadOptions = {}) {
  assertAdmin(actor);
  const pageId = readPageId(value);
  const released = await release(actor, pageId);
  if (released === 0) throw new CrmError("not_found", "No held leads to add.", 404);
  fileSoon(pageId, options);
  return { pageId, released };
}

export async function unlinkMetaPage(actor: UserActor, id: unknown) {
  assertAdmin(actor);
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new CrmError("invalid_input", "Choose a Page.", 400);
  await withActor(actor, async (db) => {
    const removed = await db.query<{ page_id: string }>("delete from crm.meta_lead_pages where id = $1 and workspace_id = $2 returning page_id", [id, actor.workspaceId]);
    if (!removed.rows[0]) throw new CrmError("not_found", "Page not found.", 404);
    await recordAudit(db, actor, "integration.disconnected", "integration", actor.workspaceId, { operation: "unlink_meta_page", source: "web" }, {
      integration: "meta_lead_ads",
      pageId: removed.rows[0].page_id,
    });
  });
}
