import { after } from "next/server";
import { clientIp } from "@/lib/booking/book";
import { withActor } from "@/lib/crm/context";
import { createActivityInDb } from "@/lib/crm/activities";
import { createCompanyInDb, readCompanyInDb, updateCompanyInDb } from "@/lib/crm/companies";
import { isFreeMailDomain } from "@/lib/crm/communications";
import { readContactInDb, updateContactInDb, upsertContactInDb } from "@/lib/crm/contacts";
import { memberActor } from "@/lib/crm/conversations";
import { CrmError, errorText, isPgError, notSetUp } from "@/lib/crm/errors";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { lockNamespace, recordAudit } from "@/lib/crm/mutate";
import { canonicalDomain, canonicalEmail, normalizeCompanyName, normalizeTag, TAG_LIMIT } from "@/lib/crm/normalize";
import type { Company, Contact, ContactWrite, Provenance, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query, type Db } from "@/lib/db/pool";
import {
  fetchMetaForm,
  fetchMetaLead,
  fetchMetaPage,
  listMetaForms,
  listMetaLeads,
  metaAccessToken,
  metaConfigured,
  metaEnvStatus,
  metaGraphVersion,
  metaId,
  verifyMetaChallenge,
  verifyMetaSignature,
  type MetaLead,
} from "@/lib/meta";
import { pushToUser, type PushSender } from "@/lib/push";
import { redactedError } from "@/lib/upstream";

const META_LEAD_SOURCE = "Meta Lead Ad";
const META_LEAD_TAG = "Meta lead";
const META_WEBHOOK_PATH = "/api/webhooks/meta-leads";
const META_SETTINGS_HREF = "/settings/tools#meta-leads";

const PROVENANCE: Provenance = { operation: "meta_lead_ad", source: "meta_lead_ad", automatic: true };
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CHANGES = 200;
const RATE_LIMIT = 300;
const RATE_WINDOW_SECONDS = 60;
const WEBHOOK_BUDGET_MS = 50_000;
const BACKUP_EVERY = "1 hour";
const OVERLAP_MS = 2 * 60 * 60 * 1000;
const FIRST_LOOK_BACK_MS = 24 * 60 * 60 * 1000;
const STEP_RESERVE_MS = 4_000;
const MAX_VALUE = 1000;
const MAX_ANSWERS = 100;

type LeadChange = { leadgenId: string; pageId: string | null; formId: string | null; adId: string | null; raw: Record<string, unknown> };

type Answer = { name: string; label: string; values: string[] };

export type MetaLeadOptions = {
  fetchImpl?: typeof fetch;
  deadline?: number;
  send?: PushSender;
  schedule?: (work: () => Promise<void>) => void;
  rateLimit?: boolean;
};

type MemberRow = {
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

type StoredLead = { id: string; workspace_id: string | null; fetched: boolean; filed: boolean; linked_by: string | null };

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
  workspaceId: string;
  contact: Contact | null;
  company: Company | null;
  contactCreated: boolean;
  companyCreated: boolean;
  activityId: string | null;
  name: string;
  campaign: string | null;
  form: string | null;
};

function background(work: () => Promise<void>) {
  const guarded = () => work().catch((error) => console.error("Meta lead job failed", redactedError(error)));
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

function timeLeft(deadline: number | undefined, reserve = STEP_RESERVE_MS) {
  return !deadline || deadline - Date.now() > reserve;
}

function plain(value: string, max = MAX_VALUE) {
  return value
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
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

export function readAnswers(fieldData: unknown): Answer[] {
  if (!Array.isArray(fieldData)) return [];
  const answers: Answer[] = [];
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
    answers.push({ name, label: answerLabel(name), values });
  }
  return answers;
}

function answer(answers: Answer[], ...names: string[]) {
  for (const name of names) {
    const found = answers.find((item) => item.name.toLowerCase() === name);
    const value = found?.values.join(", ").trim();
    if (value) return value;
  }
  return null;
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
  return value ? value.slice(0, max).trim() || null : null;
}

export function leadPerson(answers: Answer[]): LeadPerson {
  const full = answer(answers, "full_name");
  let firstName = answer(answers, "first_name");
  let lastName = answer(answers, "last_name");
  if (!firstName && !lastName && full) {
    const parts = full.split(" ").filter(Boolean);
    firstName = parts[0] ?? null;
    lastName = parts.slice(1).join(" ") || null;
  }
  const rawEmail = answer(answers, "email", "work_email");
  const email = rawEmail ? canonicalEmail(rawEmail) : null;
  const rawPhone = answer(answers, "phone_number", "work_phone_number", "user_provided_phone_number");
  const phone = rawPhone && /\d/.test(rawPhone) ? clip(rawPhone, 40) : null;
  return {
    firstName: clip(firstName, 80),
    lastName: clip(lastName, 80),
    email,
    phone,
    jobTitle: clip(answer(answers, "job_title"), 120),
    companyName: clip(answer(answers, "company_name"), 200),
    city: clip(answer(answers, "city"), 200),
  };
}

function platformLabel(value: unknown) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "fb" || key === "facebook") return "Facebook";
  if (key === "ig" || key === "instagram") return "Instagram";
  if (key === "msg" || key === "messenger") return "Messenger";
  const text = plain(value, 40);
  return text || null;
}

function isoTime(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = typeof value === "number" ? value * 1000 : new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function text(value: unknown, max = 300) {
  return typeof value === "string" ? plain(value, max) || null : null;
}

function normaliseLead(lead: MetaLead, formName: string | null) {
  return {
    form_id: metaId(lead.form_id),
    form_name: formName ? plain(formName, 300) : null,
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

function rawLead(lead: MetaLead) {
  const raw = JSON.stringify(lead);
  return raw.length <= 200_000 ? (JSON.parse(raw) as Record<string, unknown>) : { id: lead.id, truncated: true };
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
      const adgroupId = metaId(fields.adgroup_id);
      changes.push({
        leadgenId,
        pageId,
        formId,
        adId,
        raw: { leadgen_id: leadgenId, page_id: pageId, form_id: formId, ad_id: adId, adgroup_id: adgroupId, created_time: isoTime(fields.created_time) },
      });
      if (changes.length >= MAX_CHANGES) return changes;
    }
  }
  return changes;
}

async function readCapped(request: Request, max: number) {
  if (!request.body) return "";
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
  return Buffer.concat(chunks).toString("utf8");
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

export async function handleMetaLeadsWebhook(request: Request, options: MetaLeadOptions = {}) {
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
    const changes = parseMetaWebhook(raw);
    if (changes === null) return Response.json({ error: "Invalid body." }, { status: 400, headers: NO_STORE });
    if (changes.length > 0) {
      const deadline = options.deadline ?? Date.now() + WEBHOOK_BUDGET_MS;
      (options.schedule ?? background)(() => receiveLeadChanges(changes, { ...options, deadline }));
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    console.error("Meta lead webhook failed", redactedError(error));
    return Response.json({ error: "Try again later." }, { status: 503, headers: NO_STORE });
  }
}

async function store(
  leadgenId: string,
  input: { pageId: string | null; formId: string | null; adId: string | null; via: "webhook" | "backup"; lead?: ReturnType<typeof normaliseLead> | null; payload: Record<string, unknown>; error?: string | null },
) {
  const result = await query<StoredLead>("select * from private.meta_lead_store($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)", [
    leadgenId,
    input.pageId,
    input.formId,
    input.adId,
    input.via,
    input.lead ? JSON.stringify(input.lead) : null,
    JSON.stringify(input.payload),
    input.error ?? null,
  ]);
  return result.rows[0] ?? null;
}

async function markFailed(id: string, message: string) {
  await query("select private.meta_lead_failed($1, $2)", [id, message.slice(0, 500)]).catch((error) => console.error("Meta lead failure not saved", redactedError(error)));
}

async function receiveLeadChanges(changes: LeadChange[], options: MetaLeadOptions = {}) {
  const stored: { change: LeadChange; row: StoredLead }[] = [];
  for (const change of changes) {
    try {
      const row = await store(change.leadgenId, { pageId: change.pageId, formId: change.formId, adId: change.adId, via: "webhook", payload: { webhook: change.raw } });
      if (row && !row.filed) stored.push({ change, row });
    } catch (error) {
      console.error("Meta lead not stored", redactedError(error));
    }
  }
  const forms = new Map<string, string | null>();
  for (const { change, row } of stored) {
    if (!timeLeft(options.deadline)) break;
    await processLead({ id: row.id, leadgenId: change.leadgenId, pageId: change.pageId, formId: change.formId, adId: change.adId, fetched: row.fetched, workspaceId: row.workspace_id, linkedBy: row.linked_by }, forms, options);
  }
}

type Pending = { id: string; leadgenId: string; pageId: string | null; formId: string | null; adId: string | null; fetched: boolean; workspaceId: string | null; linkedBy: string | null };

async function formName(formId: string | null, forms: Map<string, string | null>, options: MetaLeadOptions) {
  if (!formId) return null;
  if (forms.has(formId)) return forms.get(formId) ?? null;
  const name = await fetchMetaForm(formId, { fetchImpl: options.fetchImpl, deadline: options.deadline })
    .then((form) => form.name)
    .catch(() => null);
  forms.set(formId, name);
  return name;
}

async function processLead(pending: Pending, forms: Map<string, string | null>, options: MetaLeadOptions) {
  let workspaceId = pending.workspaceId;
  let linkedBy = pending.linkedBy;
  if (!pending.fetched) {
    let lead: MetaLead;
    try {
      lead = await fetchMetaLead(pending.leadgenId, { fetchImpl: options.fetchImpl, deadline: options.deadline });
    } catch (error) {
      await markFailed(pending.id, errorText(error, "Couldn't fetch the lead from Meta."));
      if (!pending.workspaceId && pending.pageId) await alertUnlinked(pending.pageId, options).catch((failure) => console.error("Meta unlinked alert failed", redactedError(failure)));
      return null;
    }
    const formId = metaId(lead.form_id) ?? pending.formId;
    const normalised = normaliseLead(lead, await formName(formId, forms, options));
    const row = await store(pending.leadgenId, { pageId: pending.pageId, formId, adId: metaId(lead.ad_id) ?? pending.adId, via: "webhook", lead: normalised, payload: { lead: rawLead(lead) } });
    if (!row || row.filed) return null;
    workspaceId = row.workspace_id;
    linkedBy = row.linked_by;
  }
  if (!workspaceId) {
    if (pending.pageId) await alertUnlinked(pending.pageId, options).catch((error) => console.error("Meta unlinked alert failed", redactedError(error)));
    return null;
  }
  return fileAndAlert(pending.id, workspaceId, linkedBy, options);
}

async function workspaceMembers(workspaceId?: string) {
  const result = await query<MemberRow>("select workspace_id, workspace_name, user_id, role, email, full_name from private.background_members()");
  return workspaceId ? result.rows.filter((row) => row.workspace_id === workspaceId) : result.rows;
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
    await markFailed(leadId, errorText(error, "Couldn't save the lead."));
    return null;
  }
  if (filed) await alertNewLead(filed, members, linkedBy, options).catch((error) => console.error("Meta lead alert failed", redactedError(error)));
  return filed;
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
  return body.length > 9_500 ? `${body.slice(0, 9_500).trim()}\n…` : body;
}

async function matchCompany(db: Db, actor: UserActor, person: LeadPerson, leadgenId: string) {
  if (!person.companyName) return { company: null, created: false };
  const normalized = normalizeCompanyName(person.companyName);
  const emailDomain = person.email?.split("@")[1] ?? null;
  const domain = emailDomain && !isFreeMailDomain(emailDomain) ? canonicalDomain(emailDomain) : null;
  await lockNamespace(db, actor.workspaceId, "companies");
  if (domain) {
    const byDomain = await db.query<{ id: string }>(
      "select id from crm.companies where workspace_id = $1 and archived_at is null and domain = $2 order by updated_at desc limit 1",
      [actor.workspaceId, domain],
    );
    if (byDomain.rows[0]) return { company: await readCompanyInDb(db, byDomain.rows[0].id, actor.workspaceId), created: false };
  }
  if (normalized) {
    const byName = await db.query<{ id: string; domain: string | null }>(
      `select id, domain from crm.companies
       where workspace_id = $1 and archived_at is null and normalized_name = $2 and ($3::text is null or domain is null)
       order by (domain is null) desc, updated_at desc limit 1`,
      [actor.workspaceId, normalized, domain],
    );
    const found = byName.rows[0];
    if (found) {
      if (domain && !found.domain) {
        const updated = await updateCompanyInDb(db, actor, found.id, { domain }, PROVENANCE);
        return { company: updated.company, created: false };
      }
      return { company: await readCompanyInDb(db, found.id, actor.workspaceId), created: false };
    }
  }
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

async function matchContact(db: Db, actor: UserActor, person: LeadPerson, companyId: string | null, leadgenId: string) {
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
    const answers = readAnswers(Array.isArray(row.answers) ? (row.answers as { name?: unknown; values?: unknown }[]) : []);
    const person = leadPerson(answers);
    const company = await matchCompany(db, actor, person, row.leadgen_id);
    const contact = await matchContact(db, actor, person, company.company?.id ?? null, row.leadgen_id);
    let activityId: string | null = null;
    if (contact.contact || company.company) {
      const activity = await createActivityInDb(
        db,
        actor,
        {
          type: "note",
          title: `Meta lead: ${row.form_name ?? "Lead form"}`.slice(0, 200),
          body: activityBody(row, answers) || "No answers.",
          occurredAt: row.lead_created_at ? new Date(row.lead_created_at).toISOString() : undefined,
          contactId: contact.contact?.id ?? null,
          companyId: company.company?.id ?? contact.contact?.companyId ?? null,
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
      await recordAudit(db, actor, "lead.created", "lead", contact.contact?.id ?? company.company!.id, PROVENANCE, {
        companyId: company.company?.id ?? null,
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
    await db.query(
      "update crm.meta_leads set contact_id = $2, company_id = $3, activity_id = $4, filed_at = now(), error = $5 where id = $1",
      [row.id, contact.contact?.id ?? null, company.company?.id ?? null, activityId, activityId ? null : "The lead has no name, email, phone or company."],
    );
    if (!activityId) return null;
    const name = personName(person) || contact.contact?.name || person.email || company.company?.name || "Unnamed lead";
    return {
      leadId: row.id,
      leadgenId: row.leadgen_id,
      workspaceId: actor.workspaceId,
      contact: contact.contact,
      company: company.company,
      contactCreated: contact.created,
      companyCreated: company.created,
      activityId,
      name,
      campaign: row.campaign_name,
      form: row.form_name,
    };
  });
}

async function alert(actor: UserActor, input: { key: string; title: string; body: string; href: string }, send?: PushSender) {
  const fresh = await withActor(actor, async (db) => {
    const result = await db.query(
      "insert into crm.push_log (workspace_id, user_id, key) values ($1, $2, $3) on conflict (user_id, key) do nothing returning id",
      [actor.workspaceId, actor.userId, input.key.slice(0, 500)],
    );
    return (result.rowCount ?? 0) > 0;
  });
  if (!fresh) return false;
  const { notify } = await import("@/lib/workflows/engine");
  await notify(actor, actor.userId, { title: input.title.slice(0, 200), body: input.body || null, href: input.href, source: "meta_lead" }).catch((error) =>
    console.error("Meta lead notification failed", redactedError(error)),
  );
  await pushToUser(actor, { title: input.title, body: input.body, url: input.href, tag: input.key }, { send }).catch((error) =>
    console.error("Meta lead push failed", redactedError(error)),
  );
  return true;
}

async function alertNewLead(filed: FiledLead, members: MemberRow[], linkedBy: string | null, options: MetaLeadOptions) {
  const recipients = members.filter((member) => member.role === "owner" || member.role === "admin" || member.user_id === linkedBy);
  const href = filed.contact ? contactHref(filed.contact.id) : filed.company ? companyHref(filed.company.id) : META_SETTINGS_HREF;
  const body = filed.campaign ?? filed.form ?? META_LEAD_SOURCE;
  for (const member of recipients) {
    await alert(memberActor(member), { key: `meta-lead:${filed.leadgenId}`, title: `New lead: ${filed.name}`, body, href }, options.send);
  }
}

async function alertUnlinked(pageId: string, options: MetaLeadOptions) {
  const owners = new Map<string, MemberRow>();
  for (const member of await workspaceMembers()) {
    if (member.role === "owner" && !owners.has(member.user_id)) owners.set(member.user_id, member);
  }
  const day = new Date().toISOString().slice(0, 10);
  for (const owner of owners.values()) {
    await alert(
      memberActor(owner),
      { key: `meta-unlinked:${pageId}:${day}`, title: "Lead from a Page that isn't linked", body: `Page ${pageId}`, href: META_SETTINGS_HREF },
      options.send,
    );
  }
}

async function fileWaitingLeads(options: MetaLeadOptions & { minAgeSeconds?: number; limit?: number } = {}) {
  const waiting = await query<{ id: string; workspace_id: string | null; leadgen_id: string; page_id: string | null; form_id: string | null; ad_id: string | null; fetched: boolean; linked_by: string | null }>(
    "select * from private.meta_leads_waiting($1, $2)",
    [options.limit ?? 50, options.minAgeSeconds ?? 120],
  );
  const forms = new Map<string, string | null>();
  let filed = 0;
  for (const row of waiting.rows) {
    if (!timeLeft(options.deadline)) break;
    if (!row.fetched && !metaAccessToken()) continue;
    const result = await processLead(
      { id: row.id, leadgenId: row.leadgen_id, pageId: row.page_id, formId: row.form_id, adId: row.ad_id, fetched: row.fetched, workspaceId: row.workspace_id, linkedBy: row.linked_by },
      forms,
      options,
    );
    if (result) filed += 1;
  }
  return { waiting: waiting.rows.length, filed };
}

type DuePage = { id: string; workspace_id: string; page_id: string; page_name: string | null; linked_by: string | null; last_run_at: Date | null; created_at: Date };

async function backupPage(page: DuePage, options: MetaLeadOptions) {
  const started = new Date();
  const since = page.last_run_at
    ? new Date(new Date(page.last_run_at).getTime() - OVERLAP_MS)
    : new Date(new Date(page.created_at).getTime() - FIRST_LOOK_BACK_MS);
  const base = { fetchImpl: options.fetchImpl, deadline: options.deadline };
  const info = await fetchMetaPage(page.page_id, base).catch(() => ({ name: null, accessToken: null }));
  const token = info.accessToken ?? undefined;
  const report = { imported: 0, skipped: 0 };
  const forms = await listMetaForms(page.page_id, { ...base, token });
  for (const form of forms) {
    if (!timeLeft(options.deadline)) return { ...report, complete: false, name: info.name, started };
    const leads = await listMetaLeads(form.id, since, { ...base, token });
    for (const lead of leads) {
      if (!timeLeft(options.deadline)) return { ...report, complete: false, name: info.name, started };
      const normalised = normaliseLead(lead, form.name);
      const row = await store(lead.id, { pageId: page.page_id, formId: form.id, adId: metaId(lead.ad_id), via: "backup", lead: normalised, payload: { lead: rawLead(lead) } });
      if (!row || row.filed) {
        report.skipped += 1;
        continue;
      }
      if (!row.workspace_id) continue;
      const filed = await fileAndAlert(row.id, row.workspace_id, row.linked_by ?? page.linked_by, options);
      if (filed) report.imported += 1;
    }
  }
  return { ...report, complete: true, name: info.name, started };
}

export async function runMetaLeadBackup(options: MetaLeadOptions = {}) {
  if (!metaAccessToken()) return { skipped: "Meta lead ads isn't set up.", pages: [], retried: { waiting: 0, filed: 0 } };
  const deadline = options.deadline ?? Date.now() + 12_000;
  const scoped = { ...options, deadline };
  const due = await query<DuePage>("select * from private.meta_lead_pages_due($1::interval)", [BACKUP_EVERY]);
  const pages: { pageId: string; imported?: number; skipped?: number; error?: string }[] = [];
  for (const page of due.rows) {
    if (!timeLeft(deadline)) break;
    try {
      const result = await backupPage(page, scoped);
      if (result.complete) {
        await query("select private.meta_lead_page_ran($1, $2, true, null, $3)", [page.id, result.started.toISOString(), result.name]);
      }
      pages.push({ pageId: page.page_id, imported: result.imported, skipped: result.skipped });
    } catch (error) {
      const message = errorText(error, "Couldn't check the Page for leads.");
      await query("select private.meta_lead_page_ran($1, now(), false, $2, null)", [page.id, message]);
      pages.push({ pageId: page.page_id, error: message });
    }
  }
  const retried = timeLeft(deadline) ? await fileWaitingLeads(scoped) : { waiting: 0, filed: 0 };
  return { pages, retried };
}

type MetaLeadPageView = {
  id: string;
  pageId: string;
  pageName: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  leads: number;
  lastLeadAt: string | null;
};

export type MetaLeadSettingsView = {
  endpoint: string;
  configured: boolean;
  setupMessage: string | null;
  graphVersion: string;
  pages: MetaLeadPageView[];
  unlinked: { pageId: string; leads: number; lastAt: string | null }[];
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
  const pages = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string; page_id: string; page_name: string | null; last_run_at: Date | null; last_error: string | null; leads: number; last_lead_at: Date | null }>(
      `select p.id, p.page_id, p.page_name, p.last_run_at, p.last_error,
              coalesce(s.leads, 0)::integer as leads, s.last_lead_at
       from crm.meta_lead_pages p
       left join lateral (
         select count(*) as leads, max(l.created_at) as last_lead_at
         from crm.meta_leads l
         where l.workspace_id = p.workspace_id and l.page_id = p.page_id
       ) s on true
       where p.workspace_id = $1
       order by p.created_at`,
      [actor.workspaceId],
    );
    return result.rows;
  });
  const unlinked =
    actor.role === "owner"
      ? (await query<{ page_id: string; leads: number; last_at: Date | null }>("select * from private.meta_unlinked_pages()")).rows.map((row) => ({
          pageId: row.page_id,
          leads: row.leads,
          lastAt: iso(row.last_at),
        }))
      : [];
  return {
    endpoint: `${origin.replace(/\/+$/, "")}${META_WEBHOOK_PATH}`,
    configured,
    setupMessage: configured ? null : canAdmin ? notSetUp("Meta lead ads", missing.join(", "), actor) : notSetUp("Meta lead ads"),
    graphVersion: metaGraphVersion(),
    pages: pages.map((row) => ({
      id: row.id,
      pageId: row.page_id,
      pageName: row.page_name,
      lastRunAt: iso(row.last_run_at),
      lastError: row.last_error,
      leads: row.leads,
      lastLeadAt: iso(row.last_lead_at),
    })),
    unlinked,
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

export async function linkMetaPage(actor: UserActor, value: unknown, options: MetaLeadOptions = {}) {
  assertAdmin(actor);
  const pageId = readPageId(value);
  try {
    await withActor(actor, async (db) => {
      await db.query("insert into crm.meta_lead_pages (workspace_id, page_id, linked_by) values ($1, $2, $3)", [actor.workspaceId, pageId, actor.userId]);
      await recordAudit(db, actor, "integration.connected", "integration", actor.workspaceId, { operation: "link_meta_page", source: "web" }, { integration: "meta_lead_ads", pageId });
    });
  } catch (error) {
    if (isPgError(error) && error.code === "23505") {
      const here = await withActor(actor, (db) =>
        db.query<{ workspace_name: string; here: boolean }>(
          `select w.name as workspace_name, p.workspace_id = $2 as here
           from crm.meta_lead_pages p join crm.workspaces w on w.id = p.workspace_id
           where p.page_id = $1`,
          [pageId, actor.workspaceId],
        ),
      );
      const row = here.rows[0];
      if (row?.here) throw new CrmError("conflict", "This Page is already linked.", 409, { field: "pageId" });
      if (row) throw new CrmError("conflict", `This Page is linked to ${row.workspace_name}.`, 409, { field: "pageId" });
      throw new CrmError("conflict", "This Page is already linked.", 409, { field: "pageId" });
    }
    throw error;
  }
  const scheduled = options.schedule ?? background;
  scheduled(async () => {
    await fileWaitingLeads({ ...options, minAgeSeconds: 0, deadline: options.deadline ?? Date.now() + 40_000 });
  });
  return { pageId };
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
