import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { requireCompany } from "@/lib/crm/links";
import {
  actorIds,
  assertOwner,
  assignColumns,
  changedFields,
  constraintError,
  iso,
  isUuid,
  lockNamespace,
  pageWindow,
  recordAudit,
  replayOrRun,
  requestHash,
  type MutationOptions,
  type MutationOutcome,
} from "@/lib/crm/mutate";
import {
  canonicalEmail,
  canonicalLinkedin,
  cleanText,
  likePattern,
  normalizedLinkedin,
  normalizePersonName,
} from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type {
  Actor,
  Contact,
  ContactListQuery,
  ContactMatch,
  ContactWrite,
  Provenance,
} from "@/lib/crm/types";

const CONTACT_SQL = `
  select
    c.id,
    c.workspace_id,
    c.company_id,
    co.name as company_name,
    c.first_name,
    c.last_name,
    c.email,
    c.normalized_email,
    c.phone,
    c.job_title,
    c.linkedin_url,
    c.normalized_linkedin,
    c.owner_id,
    p.full_name as owner_name,
    c.source,
    c.source_reference,
    c.notes,
    c.created_by_user_id,
    c.created_by_agent_id,
    c.archived_at,
    c.created_at,
    c.updated_at
  from crm.contacts c
  left join crm.companies co on co.id = c.company_id
  left join crm.profiles p on p.id = c.owner_id
`;

type ContactRow = {
  id: string;
  workspace_id: string;
  company_id: string | null;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  normalized_email: string | null;
  phone: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  normalized_linkedin: string | null;
  owner_id: string | null;
  owner_name: string | null;
  source: string | null;
  source_reference: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type PreparedContact = {
  companyId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  normalizedEmail?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  linkedinUrl?: string | null;
  normalizedLinkedin?: string | null;
  ownerId?: string | null;
  source?: string | null;
  sourceReference?: string | null;
  notes?: string | null;
  personKey: string | null;
};

function label(first: string | null, last: string | null, email: string | null, phone: string | null) {
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name || email || phone || "Contact";
}

function mapContact(row: ContactRow): Contact {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    companyName: row.company_name,
    firstName: row.first_name,
    lastName: row.last_name,
    name: label(row.first_name, row.last_name, row.email, row.phone),
    email: row.email,
    phone: row.phone,
    jobTitle: row.job_title,
    linkedinUrl: row.linkedin_url,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    source: row.source,
    sourceReference: row.source_reference,
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    createdByAgentId: row.created_by_agent_id,
    archivedAt: iso(row.archived_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function personKey(first: string | null | undefined, last: string | null | undefined) {
  const key = normalizePersonName(`${first ?? ""} ${last ?? ""}`);
  return key || null;
}

function prepareContact(input: ContactWrite, mode: "create" | "patch" | "upsert"): PreparedContact {
  const next: PreparedContact = { personKey: null };
  if (input.firstName !== undefined) next.firstName = cleanText(input.firstName, 80, "firstName");
  if (input.lastName !== undefined) next.lastName = cleanText(input.lastName, 80, "lastName");
  if (input.email !== undefined) {
    if (input.email === null || input.email.trim() === "") {
      next.email = null;
      next.normalizedEmail = null;
    } else {
      const email = canonicalEmail(input.email);
      if (!email) {
        throw new CrmError("invalid_input", "Enter a valid email address.", 400, {
          field: "email",
        });
      }
      next.email = email;
      next.normalizedEmail = email;
    }
  }
  if (input.phone !== undefined) {
    const phone = cleanText(input.phone, 40, "phone");
    if (phone && !/\d/.test(phone)) {
      throw new CrmError("invalid_input", "Enter a phone number.", 400, { field: "phone" });
    }
    next.phone = phone;
  }
  if (input.jobTitle !== undefined) next.jobTitle = cleanText(input.jobTitle, 120, "jobTitle");
  if (input.linkedinUrl !== undefined) {
    if (input.linkedinUrl === null || input.linkedinUrl.trim() === "") {
      next.linkedinUrl = null;
      next.normalizedLinkedin = null;
    } else {
      const url = canonicalLinkedin(input.linkedinUrl);
      if (!url) {
        throw new CrmError(
          "invalid_input",
          "Enter a LinkedIn profile like linkedin.com/in/name.",
          400,
          { field: "linkedinUrl" },
        );
      }
      next.linkedinUrl = url;
      next.normalizedLinkedin = normalizedLinkedin(url);
    }
  }
  if (input.ownerId !== undefined) next.ownerId = input.ownerId || null;
  if (input.source !== undefined) next.source = cleanText(input.source, 120, "source");
  if (input.sourceReference !== undefined) {
    next.sourceReference = cleanText(input.sourceReference, 500, "sourceReference");
  }
  if (input.notes !== undefined) next.notes = cleanText(input.notes, 10000, "notes");
  if (input.companyId !== undefined) next.companyId = input.companyId || null;

  const named =
    input.firstName !== undefined || input.lastName !== undefined
      ? personKey(next.firstName, next.lastName)
      : null;
  next.personKey = named;

  const identifiable =
    Boolean(next.firstName || next.lastName) ||
    Boolean(next.email) ||
    Boolean(next.phone) ||
    Boolean(next.linkedinUrl);
  if (mode === "create" && !identifiable) {
    throw new CrmError(
      "invalid_input",
      "Enter a name, email, phone, or LinkedIn profile.",
      400,
      { field: "email" },
    );
  }
  if (mode === "upsert") {
    const canMatch =
      Boolean(next.email) ||
      Boolean(next.normalizedLinkedin) ||
      Boolean(next.personKey && next.companyId);
    if (!canMatch) {
      throw new CrmError(
        "invalid_input",
        "Provide an email, LinkedIn profile, or a name and company.",
        400,
        { field: "email" },
      );
    }
  }
  return next;
}

async function readContact(db: Db, id: string) {
  const result = await db.query<ContactRow>(`${CONTACT_SQL} where c.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function readContactInDb(db: Db, id: string) {
  const row = await readContact(db, id);
  return row ? mapContact(row) : null;
}

async function findMatch(db: Db, workspaceId: string, write: PreparedContact) {
  if (write.normalizedEmail) {
    const byEmail = await db.query<ContactRow>(
      `${CONTACT_SQL}
       where c.workspace_id = $1 and c.archived_at is null and c.normalized_email = $2
       limit 1`,
      [workspaceId, write.normalizedEmail],
    );
    if (byEmail.rows[0]) return { row: byEmail.rows[0], matchedOn: "email" as const };
  }
  if (write.normalizedLinkedin) {
    const byLinkedin = await db.query<ContactRow>(
      `${CONTACT_SQL}
       where c.workspace_id = $1 and c.archived_at is null and c.normalized_linkedin = $2
       limit 1`,
      [workspaceId, write.normalizedLinkedin],
    );
    if (byLinkedin.rows[0]) return { row: byLinkedin.rows[0], matchedOn: "linkedin" as const };
  }
  if (!write.personKey || !write.companyId) return null;
  const named = await db.query<ContactRow>(
    `${CONTACT_SQL}
     where c.workspace_id = $1
       and c.company_id = $2
       and c.archived_at is null
     order by c.updated_at desc
     limit 200`,
    [workspaceId, write.companyId],
  );
  const row = named.rows.find((candidate) => {
    if (personKey(candidate.first_name, candidate.last_name) !== write.personKey) return false;
    if (
      write.normalizedEmail &&
      candidate.normalized_email &&
      candidate.normalized_email !== write.normalizedEmail
    ) {
      return false;
    }
    if (
      write.normalizedLinkedin &&
      candidate.normalized_linkedin &&
      candidate.normalized_linkedin !== write.normalizedLinkedin
    ) {
      return false;
    }
    return true;
  });
  return row ? { row, matchedOn: "name" as const } : null;
}

function hasIdentity(row: ContactRow, write: PreparedContact) {
  const first = write.firstName === undefined ? row.first_name : write.firstName;
  const last = write.lastName === undefined ? row.last_name : write.lastName;
  const email = write.email === undefined ? row.email : write.email;
  const phone = write.phone === undefined ? row.phone : write.phone;
  const linkedin = write.linkedinUrl === undefined ? row.linkedin_url : write.linkedinUrl;
  return Boolean(first || last || email || phone || linkedin);
}

async function applyContact(
  db: Db,
  actor: Actor,
  current: ContactRow,
  write: PreparedContact,
  provenance: Provenance | undefined,
) {
  if (!hasIdentity(current, write)) {
    throw new CrmError(
      "invalid_input",
      "A contact needs a name, email, phone, or LinkedIn profile.",
      400,
      { field: "email" },
    );
  }
  await assertOwner(db, actor.workspaceId, write.ownerId);
  if (write.companyId) await requireCompany(db, actor.workspaceId, write.companyId);
  const change = assignColumns([
    [write.companyId !== undefined, "company_id", "companyId", write.companyId ?? null],
    [write.firstName !== undefined, "first_name", "firstName", write.firstName ?? null],
    [write.lastName !== undefined, "last_name", "lastName", write.lastName ?? null],
    [write.email !== undefined, "email", "email", write.email ?? null],
    [write.email !== undefined, "normalized_email", "email", write.normalizedEmail ?? null],
    [write.phone !== undefined, "phone", "phone", write.phone ?? null],
    [write.jobTitle !== undefined, "job_title", "jobTitle", write.jobTitle ?? null],
    [write.linkedinUrl !== undefined, "linkedin_url", "linkedinUrl", write.linkedinUrl ?? null],
    [
      write.linkedinUrl !== undefined,
      "normalized_linkedin",
      "linkedinUrl",
      write.normalizedLinkedin ?? null,
    ],
    [write.ownerId !== undefined, "owner_id", "ownerId", write.ownerId ?? null],
    [write.source !== undefined, "source", "source", write.source ?? null],
    [
      write.sourceReference !== undefined,
      "source_reference",
      "sourceReference",
      write.sourceReference ?? null,
    ],
    [write.notes !== undefined, "notes", "notes", write.notes ?? null],
  ]);
  const before = mapContact(current);
  if (change.sets.length === 0) return { contact: before, changed: false };
  change.values.push(current.id);
  try {
    await db.query(
      `update crm.contacts set ${change.sets.join(", ")} where id = $${change.values.length}`,
      change.values,
    );
  } catch (error) {
    constraintError(error, "duplicate_contact", "A matching contact already exists.");
  }
  const saved = await readContact(db, current.id);
  if (!saved) throw new CrmError("not_found", "Contact not found.", 404);
  const contact = mapContact(saved);
  await recordAudit(
    db,
    actor,
    "contact.updated",
    "contact",
    contact.id,
    provenance,
    changedFields(
      before as unknown as Record<string, unknown>,
      contact as unknown as Record<string, unknown>,
      change.fields,
    ),
  );
  return { contact, changed: true };
}

async function insertContact(
  db: Db,
  actor: Actor,
  write: PreparedContact,
  provenance?: Provenance,
) {
  await assertOwner(db, actor.workspaceId, write.ownerId);
  if (write.companyId) await requireCompany(db, actor.workspaceId, write.companyId);
  const actorRef = actorIds(actor);
  try {
    const inserted = await db.query<{ id: string }>(
      `insert into crm.contacts (
        workspace_id, company_id, first_name, last_name, email, normalized_email,
        phone, job_title, linkedin_url, normalized_linkedin, owner_id, source,
        source_reference, notes, created_by_user_id, created_by_agent_id
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      ) returning id`,
      [
        actor.workspaceId,
        write.companyId ?? null,
        write.firstName ?? null,
        write.lastName ?? null,
        write.email ?? null,
        write.normalizedEmail ?? null,
        write.phone ?? null,
        write.jobTitle ?? null,
        write.linkedinUrl ?? null,
        write.normalizedLinkedin ?? null,
        write.ownerId ?? null,
        write.source ?? null,
        write.sourceReference ?? null,
        write.notes ?? null,
        actorRef.userId,
        actorRef.agentId,
      ],
    );
    const saved = await readContact(db, inserted.rows[0].id);
    if (!saved) throw new CrmError("internal_error", "Contact was not saved.", 500);
    const contact = mapContact(saved);
    await recordAudit(db, actor, "contact.created", "contact", contact.id, provenance, {
      after: contact,
    });
    return contact;
  } catch (error) {
    constraintError(error, "duplicate_contact", "A matching contact already exists.");
  }
}

export async function upsertContactInDb(
  db: Db,
  actor: Actor,
  input: ContactWrite,
  provenance?: Provenance,
): Promise<{ contact: Contact; created: boolean; matchedOn: ContactMatch | null; changed: boolean }> {
  const write = prepareContact(input, "upsert");
  await lockNamespace(db, actor.workspaceId, "contacts");
  const match = await findMatch(db, actor.workspaceId, write);
  if (!match) {
    const contact = await insertContact(db, actor, write, provenance);
    return { contact, created: true, matchedOn: null, changed: true };
  }
  const updated = await applyContact(db, actor, match.row, write, provenance);
  return {
    contact: updated.contact,
    created: false,
    matchedOn: match.matchedOn,
    changed: updated.changed,
  };
}

async function createContactInDb(
  db: Db,
  actor: Actor,
  input: ContactWrite,
  provenance?: Provenance,
) {
  const write = prepareContact(input, "create");
  await lockNamespace(db, actor.workspaceId, "contacts");
  const match = await findMatch(db, actor.workspaceId, write);
  if (match) {
    throw new CrmError("duplicate_contact", "A matching contact already exists.", 409, {
      existingId: match.row.id,
      matchedOn: match.matchedOn,
    });
  }
  return insertContact(db, actor, write, provenance);
}

export async function listContacts(actor: Actor, query: ContactListQuery = {}) {
  assertScope(actor.scopes, "crm:read");
  const page = pageWindow(query.limit, query.offset);
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["c.workspace_id = $1"];
    if (!query.includeArchived) where.push("c.archived_at is null");
    if (query.companyId) {
      values.push(query.companyId);
      where.push(`c.company_id = $${values.length}`);
    }
    if (query.ownerId === "unassigned") where.push("c.owner_id is null");
    else if (query.ownerId) {
      values.push(query.ownerId);
      where.push(`c.owner_id = $${values.length}`);
    }
    const text = query.query?.trim();
    if (text) {
      values.push(likePattern(text.slice(0, 200)));
      const ref = `$${values.length}`;
      where.push(`(
        coalesce(c.first_name, '') ilike ${ref} escape '\\'
        or coalesce(c.last_name, '') ilike ${ref} escape '\\'
        or coalesce(c.email, '') ilike ${ref} escape '\\'
        or coalesce(c.job_title, '') ilike ${ref} escape '\\'
        or coalesce(c.phone, '') ilike ${ref} escape '\\'
        or coalesce(co.name, '') ilike ${ref} escape '\\'
      )`);
    }
    const whereSql = where.join(" and ");
    const count = await db.query<{ total: number }>(
      `select count(*)::int as total
       from crm.contacts c
       left join crm.companies co on co.id = c.company_id
       where ${whereSql}`,
      values,
    );
    const listed = [...values, page.limit, page.offset];
    const rows = await db.query<ContactRow>(
      `${CONTACT_SQL}
       where ${whereSql}
       order by c.updated_at desc, c.id asc
       limit $${listed.length - 1} offset $${listed.length}`,
      listed,
    );
    return {
      data: rows.rows.map(mapContact),
      total: count.rows[0]?.total ?? 0,
      limit: page.limit,
      offset: page.offset,
    };
  });
}

export async function getContact(actor: Actor, id: string) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw new CrmError("not_found", "Contact not found.", 404);
  return withActor(actor, async (db) => {
    const row = await readContact(db, id);
    if (!row) throw new CrmError("not_found", "Contact not found.", 404);
    return mapContact(row);
  });
}

export async function createContact(
  actor: Actor,
  input: ContactWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ contact: Contact }>> {
  assertScope(actor.scopes, "contacts:write");
  const provenance = options.provenance ?? { operation: "create_contact" };
  const hash = requestHash("create_contact", { input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 201, async () => ({
      contact: await createContactInDb(db, actor, input, provenance),
    })),
  );
}

export async function updateContact(
  actor: Actor,
  id: string,
  input: ContactWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ contact: Contact }>> {
  assertScope(actor.scopes, "contacts:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Contact not found.", 404);
  const provenance = options.provenance ?? { operation: "update_contact" };
  const hash = requestHash("update_contact", { id, input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      await lockNamespace(db, actor.workspaceId, "contacts");
      const current = await readContact(db, id);
      if (!current) throw new CrmError("not_found", "Contact not found.", 404);
      const write = prepareContact(input, "patch");
      const updated = await applyContact(db, actor, current, write, provenance);
      return { contact: updated.contact };
    }),
  );
}

export async function archiveContact(
  actor: Actor,
  id: string,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ contact: Contact }>> {
  assertScope(actor.scopes, "contacts:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Contact not found.", 404);
  const provenance = options.provenance ?? { operation: "archive_contact" };
  const hash = requestHash("archive_contact", { id, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const current = await readContact(db, id);
      if (!current) throw new CrmError("not_found", "Contact not found.", 404);
      if (current.archived_at) return { contact: mapContact(current) };
      await db.query("update crm.contacts set archived_at = now() where id = $1", [id]);
      const saved = await readContact(db, id);
      if (!saved) throw new CrmError("not_found", "Contact not found.", 404);
      const contact = mapContact(saved);
      await recordAudit(db, actor, "contact.archived", "contact", contact.id, provenance, {
        before: { archivedAt: null },
        after: { archivedAt: contact.archivedAt },
      });
      return { contact };
    }),
  );
}

export async function upsertContact(
  actor: Actor,
  input: ContactWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ contact: Contact; created: boolean; matchedOn: ContactMatch | null; changed: boolean }>> {
  assertScope(actor.scopes, "contacts:write");
  const provenance = options.provenance ?? { operation: "upsert_contact" };
  const hash = requestHash("upsert_contact", { input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const result = await upsertContactInDb(db, actor, input, provenance);
      return {
        contact: result.contact,
        created: result.created,
        matchedOn: result.matchedOn,
        changed: result.changed,
      };
    }),
  );
}
