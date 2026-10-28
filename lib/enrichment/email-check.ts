import { getContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import { enrichmentAllowed } from "@/lib/enrichment/limits";
import { PROVIDER_BY_ID, configuredVerifiers, verifyWith, type ProviderId, type Verdict } from "@/lib/enrichment/providers";

const CHECK_BUDGET_MS = 60_000;
const DAY_MS = 86_400_000;
const KEEP_MS: Record<Verdict, number> = { valid: 30 * DAY_MS, invalid: 30 * DAY_MS, unknown: DAY_MS };

export const NO_EMAIL_CHECKER = "No email checker is set up.";

export type EmailCheck = {
  email: string;
  verdict: Verdict;
  source: "check" | "find";
  provider: ProviderId | null;
  providerName: string | null;
  checkedAt: string;
  stale: boolean;
  cached: boolean;
  contactId: string | null;
};

export type EmailCheckOptions = {
  contactId?: string | null;
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  pollMs?: number;
  deadline?: number;
  now?: number;
};

type CheckRow = {
  field: string;
  status: string;
  provider: string | null;
  verified_by: string | null;
  record_id: string;
  created_at: Date | string;
};

function cleanAddress(value: unknown) {
  const email = typeof value === "string" ? canonicalEmail(value) : null;
  if (!email) throw new CrmError("invalid_input", "Enter a valid email address.", 400, { field: "email" });
  return email;
}

function providerOf(value: string | null) {
  const provider = value ? PROVIDER_BY_ID.get(value as ProviderId) : undefined;
  return provider ? { provider: provider.id, providerName: provider.name } : { provider: null, providerName: null };
}

function fromRow(email: string, row: CheckRow, now: number): EmailCheck {
  const found = row.field === "email";
  const verdict: Verdict = found ? "valid" : (row.status as Verdict);
  const checkedAt = iso(row.created_at) ?? "";
  return {
    email,
    verdict,
    source: found ? "find" : "check",
    ...providerOf(found ? row.verified_by : row.provider),
    checkedAt,
    stale: !(now - new Date(checkedAt).getTime() < KEEP_MS[verdict]),
    cached: true,
    contactId: row.record_id,
  };
}

async function latestRow(actor: UserActor, email: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<CheckRow>(
      `select l.field, l.status, l.provider, l.record_id, l.created_at, verified.by as verified_by
       from crm.enrichment_lookups l
       left join lateral (
         select attempt->>'verifiedBy' as by
         from jsonb_array_elements(l.attempts) attempt
         where attempt->>'outcome' = 'found' and attempt->>'verifiedBy' is not null
         limit 1
       ) verified on true
       where l.workspace_id = $1 and l.record_type = 'contact' and l.value = $2
         and (l.field = 'email_check' or (l.field = 'email' and l.status = 'found' and verified.by is not null))
       order by l.created_at desc
       limit 1`,
      [actor.workspaceId, email],
    );
    return result.rows[0] ?? null;
  });
}

export async function latestEmailCheck(actor: UserActor, email: string | null | undefined, now = Date.now()): Promise<EmailCheck | null> {
  const address = email ? canonicalEmail(email) : null;
  if (!address) return null;
  const row = await latestRow(actor, address);
  return row ? fromRow(address, row, now) : null;
}

async function contactFor(actor: UserActor, email: string, contactId: string | null | undefined) {
  if (contactId) {
    if (!isUuid(contactId)) throw new CrmError("not_found", "Contact not found.", 404);
    const contact = await getContact(actor, contactId);
    if (!contact.email) throw new CrmError("invalid_input", `${contact.name} has no email address.`, 400, { field: "email" });
    if (canonicalEmail(contact.email) !== email) {
      throw new CrmError("invalid_input", `${contact.name}'s email is ${contact.email}, not ${email}.`, 400, { field: "email" });
    }
    return contact.id;
  }
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(
      `select id from crm.contacts
       where workspace_id = $1 and archived_at is null and normalized_email = $2
       order by created_at, id
       limit 1`,
      [actor.workspaceId, email],
    );
    return result.rows[0]?.id ?? null;
  });
}

export async function verifyEmail(actor: UserActor, email: unknown, options: EmailCheckOptions = {}): Promise<EmailCheck> {
  const address = cleanAddress(email);
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const contactId = await contactFor(actor, address, options.contactId);
  if (!options.refresh) {
    const row = await latestRow(actor, address);
    if (row) {
      const check = fromRow(address, row, now);
      if (!check.stale) return check;
    }
  }
  if (configuredVerifiers(env).length === 0) throw new CrmError("not_configured", NO_EMAIL_CHECKER, 400);
  if (!(await enrichmentAllowed(actor.userId, 1))) {
    throw new CrmError("rate_limited", "That's a lot of lookups this hour. Try again later.", 429);
  }
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + CHECK_BUDGET_MS);
  const result = await verifyWith(address, { env, fetchImpl: options.fetchImpl ?? fetch, deadline, pollMs: options.pollMs });
  if (result.attempts.every((attempt) => attempt.outcome === "failed")) {
    const details = [...new Set(result.attempts.map((attempt) => attempt.detail).filter(Boolean))].join(" ");
    throw new CrmError("upstream_error", `Couldn't check ${address}. ${details}`.trim(), 502);
  }
  const by = result.by ?? [...result.attempts].reverse().find((attempt) => attempt.outcome === "unknown")?.provider ?? null;
  let checkedAt = new Date(now).toISOString();
  if (contactId) {
    checkedAt = await withActor(actor, async (db) => {
      const saved = await db.query<{ created_at: Date | string }>(
        `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value, attempts, created_by_user_id)
         values ($1, 'contact', $2, 'email_check', $3, $4, $5, $6::jsonb, $7)
         returning created_at`,
        [actor.workspaceId, contactId, result.verdict, by, address, JSON.stringify(result.attempts), actor.userId],
      );
      return iso(saved.rows[0].created_at) ?? checkedAt;
    });
  }
  return { email: address, verdict: result.verdict, source: "check", ...providerOf(by), checkedAt, stale: false, cached: false, contactId };
}

export async function verifyContactEmail(actor: UserActor, contactId: string, options: Omit<EmailCheckOptions, "contactId"> = {}) {
  if (!isUuid(contactId)) throw new CrmError("not_found", "Contact not found.", 404);
  const contact = await getContact(actor, contactId);
  if (!contact.email) throw new CrmError("invalid_input", `${contact.name} has no email address.`, 400, { field: "email" });
  return verifyEmail(actor, contact.email, { ...options, contactId });
}
