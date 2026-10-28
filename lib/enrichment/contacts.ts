import { getCompany } from "@/lib/crm/companies";
import { FREE_MAIL_DOMAINS } from "@/lib/crm/communications";
import { getContact, updateContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import { canonicalDomain, canonicalLinkedin } from "@/lib/crm/normalize";
import type { Contact, ContactWrite, UserActor } from "@/lib/crm/types";
import {
  PROVIDER_BY_ID,
  ProviderFailure,
  providerKey,
  verifyWith,
  type ContactField,
  type Finding,
  type PersonQuery,
  type ProviderId,
  type Verdict,
} from "@/lib/enrichment/providers";
import { PHONE_ORDER, getEnrichmentSettings } from "@/lib/enrichment/settings";
import { normalizePhone } from "@/lib/phone";

const CONTACT_BUDGET_MS = 75_000;
const CONTEXT_MIN_SCORE = 70;
const BULK_MAX = 6;
const BULK_CONCURRENCY = 3;

type AttemptOutcome = "found" | "not_found" | "rejected" | "failed";

export type Attempt = { provider: ProviderId; outcome: AttemptOutcome; detail?: string };

export type ContactEnrichment = {
  contactId: string;
  field: ContactField;
  status: "found" | "not_found" | "failed" | "skipped";
  message: string;
  email: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  provider: ProviderId | null;
  attempts: Attempt[];
};

const NOUNS: Record<ContactField, string> = { email: "email", linkedin: "LinkedIn profile", phone: "phone number" };

export type LookupState = { status: "found" | "not_found" | "failed"; at: string; provider: string | null };

export type ContactLookups = Record<string, Partial<Record<ContactField, LookupState>>>;

type Options = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; pollMs?: number };

function emailDomain(email: string) {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function sameCompanyDomain(email: string, domains: (string | null)[]) {
  const host = emailDomain(email);
  return domains.some((domain) => domain && (host === domain || host.endsWith(`.${domain}`)));
}

function workEmail(email: string | null) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const clean = email.trim().toLowerCase();
  return FREE_MAIL_DOMAINS.has(emailDomain(clean)) ? null : clean;
}

function splitName(contact: Contact) {
  const first = contact.firstName?.trim() ?? "";
  const last = contact.lastName?.trim() ?? "";
  if (first && last) return { first, last };
  const parts = contact.name.trim().split(/\s+/);
  if (!contact.email && parts.length >= 2 && !parts[0].includes("@")) return { first: parts[0], last: parts.slice(1).join(" ") };
  return { first, last };
}

async function verify(email: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch, deadline: number, pollMs?: number): Promise<{ verdict: Verdict; by: ProviderId | null }> {
  const { verdict, by } = await verifyWith(email, { env, fetchImpl, deadline, pollMs });
  return { verdict, by };
}

async function recordLookup(actor: UserActor, contactId: string, field: ContactField, status: "found" | "not_found" | "failed", provider: ProviderId | null, value: string | null, attempts: Attempt[]) {
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value, attempts, created_by_user_id)
       values ($1, 'contact', $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [actor.workspaceId, contactId, field, status, provider, value, JSON.stringify(attempts), actor.userId],
    ),
  );
}

function skipped(contactId: string, field: ContactField, message: string): ContactEnrichment {
  return { contactId, field, status: "skipped", message, email: null, linkedinUrl: null, phone: null, provider: null, attempts: [] };
}

export async function enrichContact(actor: UserActor, contactId: string, field: ContactField, options: Options = {}): Promise<ContactEnrichment> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + CONTACT_BUDGET_MS;
  const contact = await getContact(actor, contactId);
  if (field === "email" && contact.email) return skipped(contactId, field, `${contact.name} already has an email.`);
  if (field === "linkedin" && contact.linkedinUrl) return skipped(contactId, field, `${contact.name} already has a LinkedIn profile.`);
  if (field === "phone" && contact.phone) return skipped(contactId, field, `${contact.name} already has a phone number.`);
  const { first, last } = splitName(contact);
  if (!first || !last) return skipped(contactId, field, `Add ${contact.name}'s first and last name first.`);

  const company = contact.companyId ? await getCompany(actor, contact.companyId).catch(() => null) : null;
  const ownEmail = workEmail(contact.email);
  const domain = company?.domain ?? (company?.website ? canonicalDomain(company.website) : null) ?? (ownEmail ? emailDomain(ownEmail) : null);
  const companyName = company?.name ?? contact.companyName ?? null;
  if (!domain && !companyName && !(field === "phone" && contact.linkedinUrl)) {
    return skipped(contactId, field, `Link ${contact.name} to a company with a website first.`);
  }

  const query: PersonQuery = { firstName: first, lastName: last, domain, companyName, linkedinUrl: contact.linkedinUrl };
  const settings = await getEnrichmentSettings(actor);
  const order = (field === "email" ? settings.emailOrder : field === "linkedin" ? settings.linkedinOrder : PHONE_ORDER).filter((id) => {
    const provider = PROVIDER_BY_ID.get(id);
    return provider?.fields.includes(field) && providerKey(id, env);
  });
  if (order.length === 0) return skipped(contactId, field, `No ${NOUNS[field]} finder is set up.`);

  const attempts: Attempt[] = [];
  let email: { value: string; provider: ProviderId } | null = null;
  let linkedin: { value: string; provider: ProviderId } | null = null;
  let phone: { value: string; provider: ProviderId } | null = null;

  for (const id of order) {
    if (Date.now() > deadline - 5_000) break;
    const provider = PROVIDER_BY_ID.get(id)!;
    let finding: Finding | null;
    try {
      finding = await provider.find(query, field, { key: providerKey(id, env)!, fetchImpl, deadline, pollMs: options.pollMs });
    } catch (error) {
      attempts.push({ provider: id, outcome: "failed", detail: error instanceof ProviderFailure ? error.message : "Lookup failed." });
      continue;
    }
    if (!finding) {
      attempts.push({ provider: id, outcome: "not_found" });
      continue;
    }

    const confident = id !== "context" || (finding.matchScore ?? 0) >= CONTEXT_MIN_SCORE;
    const profile = finding.linkedinUrl ? canonicalLinkedin(finding.linkedinUrl) : null;
    if (!linkedin && !contact.linkedinUrl && profile && confident) linkedin = { value: profile, provider: id };

    const candidate = workEmail(finding.email);
    let emailNote: string | undefined;
    if (!email && !contact.email && candidate) {
      if (id === "context") {
        if (!confident) emailNote = "Match score too low.";
        else if (!sameCompanyDomain(candidate, [domain, finding.companyDomain])) emailNote = "Email isn't on the company's domain.";
        else {
          const check = await verify(candidate, env, fetchImpl, deadline, options.pollMs);
          if (check.verdict === "valid") email = { value: candidate, provider: id };
          else emailNote = check.by ? `${PROVIDER_BY_ID.get(check.by)!.name} couldn't confirm the email.` : "No email checker is set up to confirm it.";
        }
      } else if (finding.emailVerified) {
        email = { value: candidate, provider: id };
      } else {
        emailNote = "Email wasn't verified.";
      }
    }

    const number = finding.phone ? normalizePhone(finding.phone) : null;
    if (!phone && !contact.phone && number && field === "phone") phone = { value: number, provider: id };

    const target = field === "email" ? email : field === "linkedin" ? linkedin : phone;
    if (target?.provider === id) {
      attempts.push({ provider: id, outcome: "found" });
      break;
    }
    attempts.push({ provider: id, outcome: emailNote && field === "email" ? "rejected" : "not_found", ...(emailNote && field === "email" ? { detail: emailNote } : {}) });
  }

  const write: ContactWrite = {};
  if (email) write.email = email.value;
  if (linkedin) write.linkedinUrl = linkedin.value;
  if (phone) write.phone = phone.value;
  const allFailed = attempts.length > 0 && attempts.every((attempt) => attempt.outcome === "failed");

  if (Object.keys(write).length > 0) {
    try {
      await updateContact(actor, contactId, write, {
        provenance: {
          operation: "enrich_contact",
          source: (field === "email" ? email : field === "linkedin" ? linkedin : phone)?.provider ?? email?.provider ?? linkedin?.provider ?? "enrichment",
        },
      });
    } catch (error) {
      const message =
        error instanceof CrmError && error.code === "duplicate_contact"
          ? `Another contact already has ${write.email ?? "that profile"}.`
          : error instanceof CrmError
            ? error.message
            : "Couldn't save what was found.";
      await recordLookup(actor, contactId, field, "failed", null, null, attempts);
      return { contactId, field, status: "failed", message, email: null, linkedinUrl: null, phone: null, provider: null, attempts };
    }
  }

  if (email && field !== "email") await recordLookup(actor, contactId, "email", "found", email.provider, email.value, []);
  if (linkedin && field !== "linkedin") await recordLookup(actor, contactId, "linkedin", "found", linkedin.provider, linkedin.value, []);
  const target = field === "email" ? email : field === "linkedin" ? linkedin : phone;
  const status = target ? "found" : allFailed ? "failed" : "not_found";
  await recordLookup(actor, contactId, field, status, target?.provider ?? null, target?.value ?? null, attempts);

  const noun = NOUNS[field];
  const message = target
    ? `Found ${contact.name}'s ${noun} with ${PROVIDER_BY_ID.get(target.provider)!.name}.`
    : allFailed
      ? `Couldn't search for ${contact.name}'s ${noun}: ${attempts.map((attempt) => attempt.detail).filter(Boolean).join(" ")}`
      : `No ${noun} found for ${contact.name}.`;
  return {
    contactId,
    field,
    status,
    message,
    email: email?.value ?? null,
    linkedinUrl: linkedin?.value ?? null,
    phone: phone?.value ?? null,
    provider: target?.provider ?? null,
    attempts,
  };
}

export async function enrichContacts(actor: UserActor, ids: unknown, field: ContactField, options: Options = {}) {
  const list = Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string" && isUuid(id)))] : [];
  if (list.length === 0) throw new CrmError("invalid_input", "Select at least one person.", 400);
  if (list.length > BULK_MAX) throw new CrmError("invalid_input", `Send up to ${BULK_MAX} people at a time.`, 400);
  const results: ContactEnrichment[] = [];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const id = list[next++];
      try {
        results.push(await enrichContact(actor, id, field, options));
      } catch (error) {
        results.push({
          ...skipped(id, field, error instanceof CrmError ? error.message : "That lookup failed."),
          status: "failed",
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, list.length) }, worker));
  return list.map((id) => results.find((result) => result.contactId === id)!);
}

export async function contactLookups(actor: UserActor, contactIds: string[]): Promise<ContactLookups> {
  const ids = contactIds.filter(isUuid);
  if (ids.length === 0) return {};
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<{ record_id: string; field: ContactField; status: LookupState["status"]; provider: string | null; created_at: Date | string }>(
      `select distinct on (record_id, field) record_id, field, status, provider, created_at
       from crm.enrichment_lookups
       where workspace_id = $1 and record_type = 'contact' and record_id = any($2::uuid[]) and field in ('email', 'linkedin', 'phone')
       order by record_id, field, created_at desc`,
      [actor.workspaceId, ids],
    );
    return result.rows;
  });
  const out: ContactLookups = {};
  for (const row of rows) {
    out[row.record_id] = { ...out[row.record_id], [row.field]: { status: row.status, provider: row.provider, at: iso(row.created_at) ?? "" } };
  }
  return out;
}
