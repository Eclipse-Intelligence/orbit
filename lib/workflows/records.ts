import { upsertCompany } from "@/lib/crm/companies";
import { createContact, updateContactInDb, upsertContact, upsertContactInDb } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid, lockNamespace } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { canonicalDomain, canonicalEmail, canonicalLinkedin, likePattern, normalizedLinkedin, normalizeCompanyName, normalizeTag, normalizeTags } from "@/lib/crm/normalize";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { FIND_LIMIT, FIND_LIMIT_PARALLEL } from "@/lib/workflows/definition";
import { render, type Vars } from "@/lib/workflows/variables";

type RecordItem = {
  type: "company" | "contact";
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  lastContactedAt: string | null;
};

type FindRecordsConfig = {
  object: "company" | "contact";
  lifecycles: string[];
  tag: string | null;
  ownerId: string | null;
  openOpportunity: "any" | "yes" | "no";
  quietDays: number | null;
  search: string | null;
  order: "least_contacted" | "oldest" | "newest" | "name";
  limit: number;
  skipDays: number | null;
};

function integer(value: unknown, min: number, max: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (value === "" || value === null || value === undefined || !Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readFindConfig(config: Record<string, unknown>, ownerId: string, options: { feedsParallel?: boolean } = {}): FindRecordsConfig {
  const owner = text(config.owner);
  const order = text(config.order);
  return {
    object: config.object === "company" ? "company" : "contact",
    lifecycles: (Array.isArray(config.lifecycles) ? config.lifecycles : typeof config.lifecycles === "string" ? config.lifecycles.split(",") : [])
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 20),
    tag: text(config.tag) ? normalizeTag(text(config.tag)!) : null,
    ownerId: owner === "owner" ? ownerId : owner && isUuid(owner) ? owner : null,
    openOpportunity: config.openOpportunity === "yes" || config.openOpportunity === "no" ? config.openOpportunity : "any",
    quietDays: integer(config.quietDays, 1, 3650),
    search: text(config.search)?.slice(0, 200) ?? null,
    order: order === "oldest" || order === "newest" || order === "name" ? order : "least_contacted",
    limit: integer(config.limit, 1, options.feedsParallel ? FIND_LIMIT_PARALLEL : FIND_LIMIT) ?? 25,
    skipDays: integer(config.skipDays, 1, 365),
  };
}

export async function findRecords(actor: UserActor, workflowId: string, config: FindRecordsConfig, options: { mark: boolean }) {
  const contact = config.object === "contact";
  const alias = contact ? "c" : "co";
  const values: unknown[] = [actor.workspaceId];
  const where = [`${alias}.workspace_id = $1`, `${alias}.archived_at is null`];
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (config.lifecycles.length) where.push(`lower(co.lifecycle) = any(${add(config.lifecycles.map((item) => item.toLowerCase()))}::text[])`);
  if (config.tag) where.push(`${add(config.tag)} = any(${alias}.tags)`);
  if (config.ownerId) where.push(`${alias}.owner_id = ${add(config.ownerId)}`);
  const openDeal = contact
    ? "exists (select 1 from crm.opportunities o where o.workspace_id = $1 and o.archived_at is null and o.status = 'open' and (o.primary_contact_id = c.id or (c.company_id is not null and o.company_id = c.company_id)))"
    : "exists (select 1 from crm.opportunities o where o.workspace_id = $1 and o.archived_at is null and o.status = 'open' and o.company_id = co.id)";
  if (config.openOpportunity === "yes") where.push(openDeal);
  if (config.openOpportunity === "no") where.push(`not ${openDeal}`);
  if (config.quietDays) where.push(`(act.last is null or act.last < now() - make_interval(days => ${add(config.quietDays)}))`);
  if (config.search) {
    const pattern = add(likePattern(config.search));
    where.push(
      contact
        ? `(concat_ws(' ', c.first_name, c.last_name) ilike ${pattern} or coalesce(c.normalized_email, '') ilike ${pattern} or coalesce(c.job_title, '') ilike ${pattern})`
        : `(co.name ilike ${pattern} or coalesce(co.domain, '') ilike ${pattern})`,
    );
  }
  if (config.skipDays) {
    where.push(
      `not exists (select 1 from crm.workflow_record_marks mk where mk.workflow_id = ${add(workflowId)} and mk.record_id = ${alias}.id and mk.marked_at > now() - make_interval(days => ${add(config.skipDays)}))`,
    );
  }
  const order = {
    least_contacted: "last_contacted_at asc nulls first, created_at asc",
    oldest: "created_at asc",
    newest: "created_at desc",
    name: "name asc",
  }[config.order];
  const sql = contact
    ? `select c.id, nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') as name, c.normalized_email as email, co.name as company,
         act.last as last_contacted_at, c.created_at
       from crm.contacts c
       left join crm.companies co on co.id = c.company_id and co.archived_at is null
       left join lateral (select max(a.occurred_at) as last from crm.activity_contacts l join crm.activities a on a.id = l.activity_id where l.contact_id = c.id and a.workspace_id = $1 and a.archived_at is null) act on true`
    : `select co.id, co.name, null::text as email, null::text as company, act.last as last_contacted_at, co.created_at
       from crm.companies co
       left join lateral (select max(a.occurred_at) as last from crm.activities a where a.workspace_id = $1 and a.company_id = co.id and a.archived_at is null) act on true`;
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string | null; email: string | null; company: string | null; last_contacted_at: Date | null }>(
      `select * from (${sql} where ${where.join(" and ")}) found order by ${order} limit ${add(config.limit)}`,
      values,
    );
    const records: RecordItem[] = result.rows.map((row) => ({
      type: config.object,
      id: row.id,
      name: row.name ?? row.email ?? "Unnamed",
      email: row.email,
      company: row.company,
      lastContactedAt: row.last_contacted_at ? new Date(row.last_contacted_at).toISOString() : null,
    }));
    if (options.mark && config.skipDays && records.length) {
      await db.query(
        `insert into crm.workflow_record_marks (workflow_id, record_id, workspace_id, owner_id)
         select $1, unnest($2::uuid[]), $3, $4
         on conflict (workflow_id, record_id) do update set marked_at = now()`,
        [workflowId, records.map((record) => record.id), actor.workspaceId, actor.userId],
      );
    }
    return records;
  });
}

export function tagsFrom(template: unknown, vars: Vars) {
  const pieces = (typeof template === "string" ? template : "")
    .split(",")
    .flatMap((piece) => render(piece, vars).split("\n"))
    .map((tag) => tag.replace(/^\s*-\s+/, "").trim())
    .filter(Boolean);
  return normalizeTags(pieces);
}

export function isRecordItem(value: unknown): value is { type: "company" | "contact"; id: string } {
  const item = value as { type?: unknown; id?: unknown } | null;
  return Boolean(item && (item.type === "company" || item.type === "contact") && typeof item.id === "string" && isUuid(item.id));
}

type UpsertInput = {
  object: "company" | "contact";
  name: string;
  domain: string;
  website: string;
  email: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  companyId: string;
  linkedinUrl?: string;
  create: boolean;
};

async function findCompany(actor: UserActor, name: string, domain: string | null) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string }>(
      `select id, name from crm.companies
       where workspace_id = $1 and archived_at is null
         and (($2::text is not null and lower(domain) = $2) or ($3::text is not null and normalized_name = $3))
       order by (lower(domain) = $2) desc nulls last
       limit 1`,
      [actor.workspaceId, domain, name ? normalizeCompanyName(name) : null],
    );
    return result.rows[0] ?? null;
  });
}

async function findContact(actor: UserActor, email: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string | null }>(
      `select id, nullif(trim(concat_ws(' ', first_name, last_name)), '') as name from crm.contacts
       where workspace_id = $1 and archived_at is null and normalized_email = $2 limit 1`,
      [actor.workspaceId, email],
    );
    return result.rows[0] ?? null;
  });
}

function linkedinOf(value: string | undefined) {
  if (!value) return null;
  const url = canonicalLinkedin(value);
  if (!url) throw new CrmError("invalid_input", "Give the contact a valid LinkedIn profile.", 400);
  return { url, normalized: normalizedLinkedin(url) };
}

async function contactWithLinkedin(actor: UserActor, input: UpsertInput, email: string | null, linkedin: { url: string; normalized: string }, provenance: Provenance) {
  assertScope(actor.scopes, "contacts:write");
  return withActor(actor, async (db) => {
    await lockNamespace(db, actor.workspaceId, "contacts");
    const byProfile = await db.query<{ id: string; name: string | null }>(
      `select id, nullif(trim(concat_ws(' ', first_name, last_name)), '') as name from crm.contacts
       where workspace_id = $1 and archived_at is null and normalized_linkedin = $2 order by created_at, id limit 1`,
      [actor.workspaceId, linkedin.normalized],
    );
    const profile = byProfile.rows[0];
    if (profile) return { id: profile.id, name: profile.name ?? email ?? linkedin.url, found: true, created: false };
    const byEmail = email
      ? (
          await db.query<{ id: string; name: string | null; normalized_linkedin: string | null }>(
            `select id, nullif(trim(concat_ws(' ', first_name, last_name)), '') as name, normalized_linkedin from crm.contacts
             where workspace_id = $1 and archived_at is null and normalized_email = $2 order by created_at, id limit 1`,
            [actor.workspaceId, email],
          )
        ).rows[0]
      : undefined;
    if (byEmail && !byEmail.normalized_linkedin) return { id: byEmail.id, name: byEmail.name ?? email, found: true, created: false };
    const clash = byEmail ? { note: emailClashNote(byEmail.name) } : {};
    if (!input.create) return { id: null, name: null, found: false, created: false, ...clash };
    const saved = await upsertContactInDb(
      db,
      actor,
      {
        ...(email && !byEmail ? { email } : {}),
        linkedinUrl: linkedin.url,
        firstName: input.firstName || null,
        lastName: input.lastName || null,
        jobTitle: input.jobTitle || null,
        companyId: isUuid(input.companyId) ? input.companyId : null,
      },
      provenance,
      { nameMatch: false },
    );
    return { id: saved.contact.id, name: saved.contact.name, found: !saved.created, created: saved.created, ...clash };
  });
}

export function emailClashNote(name: string | null) {
  return `Email belongs to ${name || "another contact"}, left off.`;
}

async function findContactByName(actor: UserActor, firstName: string, lastName: string, companyId: string | null) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string | null }>(
      `select id, nullif(trim(concat_ws(' ', first_name, last_name)), '') as name from crm.contacts
       where workspace_id = $1 and archived_at is null
         and lower(trim(coalesce(first_name, ''))) = lower($2) and lower(trim(coalesce(last_name, ''))) = lower($3)
         and company_id is not distinct from $4::uuid
       order by created_at limit 1`,
      [actor.workspaceId, firstName, lastName, companyId],
    );
    return result.rows[0] ?? null;
  });
}

async function contactWithoutEmail(actor: UserActor, input: UpsertInput, provenance: Provenance) {
  if (!input.firstName && !input.lastName) throw new CrmError("invalid_input", "Give the contact an email address or a name.", 400);
  const companyId = isUuid(input.companyId) ? input.companyId : null;
  const existing = await findContactByName(actor, input.firstName, input.lastName, companyId);
  if (existing) return { id: existing.id, name: existing.name, found: true, created: false };
  if (!input.create) return { id: null, name: null, found: false, created: false };
  const outcome = await createContact(
    actor,
    { firstName: input.firstName || null, lastName: input.lastName || null, jobTitle: input.jobTitle || null, companyId },
    { provenance },
  );
  return { id: outcome.body.contact.id, name: outcome.body.contact.name, found: false, created: true };
}

export async function upsertRecord(actor: UserActor, input: UpsertInput, provenance: Provenance) {
  const result = await findOrCreateRecord(actor, input, provenance);
  if (input.object === "contact" && result.id && result.found && isUuid(input.companyId)) await fillCompany(actor, result.id, input.companyId, provenance);
  return result;
}

async function fillCompany(actor: UserActor, contactId: string, companyId: string, provenance: Provenance) {
  await withActor(actor, async (db) => {
    await lockNamespace(db, actor.workspaceId, "contacts");
    const current = await db.query<{ company_id: string | null }>("select company_id from crm.contacts where id = $1 and workspace_id = $2", [contactId, actor.workspaceId]);
    if (current.rows[0] && !current.rows[0].company_id) await updateContactInDb(db, actor, contactId, { companyId }, provenance);
  });
}

async function findOrCreateRecord(actor: UserActor, input: UpsertInput, provenance: Provenance) {
  if (input.object === "company") {
    const domain = input.domain ? canonicalDomain(input.domain) : input.website ? canonicalDomain(input.website) : null;
    if (!input.name && !domain) throw new CrmError("invalid_input", "Give the company a name or a domain.", 400);
    const existing = await findCompany(actor, input.name, domain);
    if (existing) return { id: existing.id, name: existing.name, found: true, created: false };
    if (!input.create) return { id: null, name: null, found: false, created: false };
    const outcome = await upsertCompany(
      actor,
      { name: input.name || domain!, domain, website: input.website || (domain ? `https://${domain}` : null) },
      { provenance },
    );
    return { id: outcome.body.company.id, name: outcome.body.company.name, found: !outcome.body.created, created: outcome.body.created };
  }
  const email = canonicalEmail(input.email);
  if (!email && input.email) throw new CrmError("invalid_input", "Give the contact a valid email address.", 400);
  const linkedin = linkedinOf(input.linkedinUrl);
  if (linkedin) return contactWithLinkedin(actor, input, email, linkedin, provenance);
  const existing = email ? await findContact(actor, email) : null;
  if (existing) return { id: existing.id, name: existing.name ?? email, found: true, created: false };
  if (!email) return contactWithoutEmail(actor, input, provenance);
  if (!input.create) return { id: null, name: null, found: false, created: false };
  const outcome = await upsertContact(
    actor,
    {
      email,
      firstName: input.firstName || null,
      lastName: input.lastName || null,
      jobTitle: input.jobTitle || null,
      companyId: isUuid(input.companyId) ? input.companyId : null,
    },
    { provenance },
  );
  return { id: outcome.body.contact.id, name: outcome.body.contact.name, found: !outcome.body.created, created: outcome.body.created };
}
