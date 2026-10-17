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
  normalizeTag,
  normalizeTags,
  sameTags,
} from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import { DEFAULT_CONTACT_SORT, defaultContactOrder } from "@/lib/sorting";
import type {
  Actor,
  Contact,
  ContactListQuery,
  ContactPresence,
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
    c.tags,
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
  tags: string[] | null;
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
  tags?: string[];
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
    tags: row.tags ?? [],
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
  if (input.tags !== undefined) next.tags = normalizeTags(input.tags);

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

async function readContact(db: Db, id: string, workspaceId?: string) {
  const result = workspaceId
    ? await db.query<ContactRow>(`${CONTACT_SQL} where c.id = $1 and c.workspace_id = $2`, [
        id,
        workspaceId,
      ])
    : await db.query<ContactRow>(`${CONTACT_SQL} where c.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function readContactInDb(db: Db, id: string, workspaceId?: string) {
  const row = await readContact(db, id, workspaceId);
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

function differs<T>(value: T | null | undefined, existing: T | null) {
  return value !== undefined && (value ?? null) !== existing;
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
  const companyChanged = differs(write.companyId, current.company_id);
  if (companyChanged && write.companyId) {
    await requireCompany(db, actor.workspaceId, write.companyId);
  }
  const emailChanged =
    differs(write.email, current.email) ||
    differs(write.normalizedEmail, current.normalized_email);
  const linkedinChanged =
    differs(write.linkedinUrl, current.linkedin_url) ||
    differs(write.normalizedLinkedin, current.normalized_linkedin);
  const change = assignColumns([
    [companyChanged, "company_id", "companyId", write.companyId ?? null],
    [differs(write.firstName, current.first_name), "first_name", "firstName", write.firstName ?? null],
    [differs(write.lastName, current.last_name), "last_name", "lastName", write.lastName ?? null],
    [emailChanged, "email", "email", write.email ?? null],
    [emailChanged, "normalized_email", "email", write.normalizedEmail ?? null],
    [differs(write.phone, current.phone), "phone", "phone", write.phone ?? null],
    [differs(write.jobTitle, current.job_title), "job_title", "jobTitle", write.jobTitle ?? null],
    [linkedinChanged, "linkedin_url", "linkedinUrl", write.linkedinUrl ?? null],
    [linkedinChanged, "normalized_linkedin", "linkedinUrl", write.normalizedLinkedin ?? null],
    [differs(write.ownerId, current.owner_id), "owner_id", "ownerId", write.ownerId ?? null],
    [differs(write.source, current.source), "source", "source", write.source ?? null],
    [
      differs(write.sourceReference, current.source_reference),
      "source_reference",
      "sourceReference",
      write.sourceReference ?? null,
    ],
    [differs(write.notes, current.notes), "notes", "notes", write.notes ?? null],
    [
      write.tags !== undefined && !sameTags(write.tags, current.tags ?? []),
      "tags",
      "tags",
      write.tags ?? [],
    ],
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
  const saved = await readContact(db, current.id, actor.workspaceId);
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
        source_reference, notes, tags, created_by_user_id, created_by_agent_id
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
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
        write.tags ?? [],
        actorRef.userId,
        actorRef.agentId,
      ],
    );
    const saved = await readContact(db, inserted.rows[0].id, actor.workspaceId);
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

const CONTACT_NAME_SQL =
  "lower(coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.email, c.phone, ''))";

const CONTACT_PRESENCE_SQL: Record<ContactPresence, string> = {
  email: "c.email is not null",
  phone: "c.phone is not null",
  linkedin: "c.linkedin_url is not null",
  company: "c.company_id is not null",
};

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
    const tag = query.tag ? normalizeTag(query.tag) : "";
    if (tag) {
      values.push([tag]);
      where.push(`c.tags @> $${values.length}::text[]`);
    }
    const text = query.query?.trim();
    if (text) {
      values.push(likePattern(text.slice(0, 200)));
      const ref = `$${values.length}`;
      where.push(`(
        lower(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) ilike ${ref} escape '\\'
        or coalesce(c.email, '') ilike ${ref} escape '\\'
        or coalesce(c.job_title, '') ilike ${ref} escape '\\'
        or coalesce(c.phone, '') ilike ${ref} escape '\\'
        or coalesce(co.name, '') ilike ${ref} escape '\\'
      )`);
    }
    for (const field of query.has ?? []) where.push(CONTACT_PRESENCE_SQL[field]);
    for (const field of query.missing ?? []) where.push(`not (${CONTACT_PRESENCE_SQL[field]})`);
    const whereSql = where.join(" and ");
    const count = await db.query<{ total: number }>(
      `select count(*)::int as total
       from crm.contacts c
       left join crm.companies co on co.id = c.company_id
       where ${whereSql}`,
      values,
    );
    const sort = query.sort ?? DEFAULT_CONTACT_SORT;
    const direction = (query.order ?? defaultContactOrder(sort)) === "asc" ? "asc" : "desc";
    const ordering =
      sort === "company"
        ? `lower(co.name) ${direction} nulls last, ${CONTACT_NAME_SQL} asc`
        : sort === "name"
          ? `${CONTACT_NAME_SQL} ${direction}`
          : `c.${sort === "created" ? "created_at" : "updated_at"} ${direction}`;
    const listed = [...values, page.limit, page.offset];
    const rows = await db.query<ContactRow>(
      `${CONTACT_SQL}
       where ${whereSql}
       order by ${ordering}, c.id asc
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

export async function findContactsToLink(
  actor: Actor,
  companyId: string | null,
  query = "",
  limit = 8,
) {
  assertScope(actor.scopes, "crm:read");
  if (companyId !== null && !isUuid(companyId)) {
    throw new CrmError("not_found", "Company not found.", 404);
  }
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["c.workspace_id = $1", "c.archived_at is null"];
    if (companyId) {
      values.push(companyId);
      where.push(`c.company_id is distinct from $${values.length}`);
    }
    const text = query.trim();
    if (text) {
      values.push(likePattern(text.slice(0, 200)));
      const ref = `$${values.length}`;
      where.push(`(
        (coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) ilike ${ref} escape '\\'
        or coalesce(c.email, '') ilike ${ref} escape '\\'
      )`);
    }
    values.push(Math.min(Math.max(Math.trunc(limit) || 8, 1), 20));
    const rows = await db.query<ContactRow>(
      `${CONTACT_SQL}
       where ${where.join(" and ")}
       order by c.updated_at desc, c.id asc
       limit $${values.length}`,
      values,
    );
    return rows.rows.map(mapContact);
  });
}

export async function getContact(actor: Actor, id: string) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw new CrmError("not_found", "Contact not found.", 404);
  return withActor(actor, async (db) => {
    const row = await readContact(db, id, actor.workspaceId);
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
      const current = await readContact(db, id, actor.workspaceId);
      if (!current) throw new CrmError("not_found", "Contact not found.", 404);
      const write = prepareContact(input, "patch");
      const updated = await applyContact(db, actor, current, write, provenance);
      return { contact: updated.contact };
    }),
  );
}

export async function editContactTagsInDb(
  db: Db,
  actor: Actor,
  id: string,
  edit: (tags: string[]) => string[],
  provenance: Provenance,
) {
  const current = await readContact(db, id, actor.workspaceId);
  if (!current) throw new CrmError("not_found", "Contact not found.", 404);
  const write = prepareContact({ tags: edit(current.tags ?? []) }, "patch");
  return applyContact(db, actor, current, write, provenance);
}

export async function editContactTags(
  actor: Actor,
  id: string,
  edit: (tags: string[]) => string[],
  provenance: Provenance,
) {
  assertScope(actor.scopes, "contacts:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Contact not found.", 404);
  return withActor(actor, async (db) => {
    await lockNamespace(db, actor.workspaceId, "contacts");
    const updated = await editContactTagsInDb(db, actor, id, edit, provenance);
    return updated.contact;
  });
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
      const current = await readContact(db, id, actor.workspaceId);
      if (!current) throw new CrmError("not_found", "Contact not found.", 404);
      if (current.archived_at) return { contact: mapContact(current) };
      await db.query(
        "update crm.contacts set archived_at = now() where id = $1 and workspace_id = $2",
        [id, actor.workspaceId],
      );
      const saved = await readContact(db, id, actor.workspaceId);
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

export async function unarchiveContact(
  actor: Actor,
  id: string,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ contact: Contact }>> {
  assertScope(actor.scopes, "contacts:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Contact not found.", 404);
  const provenance = options.provenance ?? { operation: "unarchive_contact" };
  const hash = requestHash("unarchive_contact", { id, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      await lockNamespace(db, actor.workspaceId, "contacts");
      const current = await readContact(db, id, actor.workspaceId);
      if (!current) throw new CrmError("not_found", "Contact not found.", 404);
      if (!current.archived_at) return { contact: mapContact(current) };
      try {
        await db.query(
          "update crm.contacts set archived_at = null where id = $1 and workspace_id = $2",
          [id, actor.workspaceId],
        );
      } catch (error) {
        constraintError(
          error,
          "duplicate_contact",
          "Another contact already uses this email or LinkedIn profile.",
        );
      }
      const saved = await readContact(db, id, actor.workspaceId);
      if (!saved) throw new CrmError("not_found", "Contact not found.", 404);
      const contact = mapContact(saved);
      await recordAudit(db, actor, "contact.updated", "contact", contact.id, provenance, {
        fields: ["archivedAt"],
        before: { archivedAt: iso(current.archived_at) },
        after: { archivedAt: null },
      });
      return { contact };
    }),
  );
}

export async function getContactsByIds(actor: Actor, ids: string[]) {
  assertScope(actor.scopes, "crm:read");
  const wanted = [...new Set(ids.filter(isUuid))].slice(0, 100);
  if (wanted.length === 0) return [];
  return withActor(actor, async (db) => {
    const rows = await db.query<ContactRow>(
      `${CONTACT_SQL} where c.workspace_id = $1 and c.id = any($2::uuid[])`,
      [actor.workspaceId, wanted],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, mapContact(row)]));
    return wanted.flatMap((id) => byId.get(id) ?? []);
  });
}

export async function listContactsAtCompanies(actor: Actor, companyIds: string[]) {
  assertScope(actor.scopes, "crm:read");
  const wanted = [...new Set(companyIds.filter(isUuid))].slice(0, 100);
  if (wanted.length === 0) return [];
  return withActor(actor, async (db) => {
    const rows = await db.query<ContactRow>(
      `${CONTACT_SQL}
       where c.workspace_id = $1
         and c.archived_at is null
         and c.company_id = any($2::uuid[])
       order by co.name asc, c.first_name asc nulls last, c.last_name asc nulls last, c.id asc
       limit 500`,
      [actor.workspaceId, wanted],
    );
    return rows.rows.map(mapContact);
  });
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
