import type { Db } from "@/lib/db/pool";
import {
  ACTIVITY_EDIT_FIELDS,
  ACTIVITY_FIELD_LABELS,
  activityOrigin,
  editableFields,
  ORIGIN_LIMITS,
  type ActivityEdit,
  type ActivityEditField,
  type ActivityOrigin,
} from "@/lib/crm/activity-edit";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { resolveLinks } from "@/lib/crm/links";
import {
  actorIds,
  constraintError,
  iso,
  isUuid,
  pageWindow,
  recordAudit,
  replayOrRun,
  requestHash,
  type MutationOptions,
  type MutationOutcome,
} from "@/lib/crm/mutate";
import { cleanText, likePattern } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import {
  ACTIVITY_TYPES,
  type Activity,
  type ActivityListQuery,
  type ActivityType,
  type ActivityWrite,
  type Actor,
  type Provenance,
} from "@/lib/crm/types";
import { parseDateTime } from "@/lib/time";

const ACTOR_NAME_SQL = `coalesce(
      nullif(trim(pr.full_name), ''),
      nullif(trim(pr.email), ''),
      nullif(trim(ag.name), '')
    )`;

const ACTOR_JOIN_SQL = `left join crm.profiles pr on pr.id = a.actor_user_id
  left join crm.agents ag on ag.id = a.actor_agent_id`;

const ACTIVITY_SQL = `
  select
    a.id,
    a.workspace_id,
    a.type,
    a.title,
    a.body,
    a.occurred_at,
    a.company_id,
    co.name as company_name,
    a.contact_id,
    coalesce(
      nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''),
      ct.email,
      ct.phone
    ) as contact_name,
    a.opportunity_id,
    op.name as opportunity_name,
    a.actor_user_id,
    a.actor_agent_id,
    ${ACTOR_NAME_SQL} as actor_name,
    a.metadata,
    a.created_at
  from crm.activities a
  left join crm.companies co on co.id = a.company_id
  left join crm.contacts ct on ct.id = a.contact_id
  left join crm.opportunities op on op.id = a.opportunity_id
  ${ACTOR_JOIN_SQL}
`;

type ActivityRow = {
  id: string;
  workspace_id: string;
  type: ActivityType;
  title: string | null;
  body: string | null;
  occurred_at: Date | string;
  company_id: string | null;
  company_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  opportunity_id: string | null;
  opportunity_name: string | null;
  actor_user_id: string | null;
  actor_agent_id: string | null;
  actor_name: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
};

function mapActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    title: row.title,
    body: row.body,
    occurredAt: iso(row.occurred_at) ?? new Date(0).toISOString(),
    companyId: row.company_id,
    companyName: row.company_name,
    contactId: row.contact_id,
    contactName: row.contact_name,
    opportunityId: row.opportunity_id,
    opportunityName: row.opportunity_name,
    actorUserId: row.actor_user_id,
    actorAgentId: row.actor_agent_id,
    actorName: row.actor_name,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function prepareActivity(input: ActivityWrite): {
  type: ActivityType;
  title: string | null;
  body: string | null;
  occurredAt: string | null;
  companyId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  metadata: Record<string, unknown>;
} {
  const type = input.type ?? "note";
  if (!(ACTIVITY_TYPES as readonly string[]).includes(type)) {
    throw new CrmError(
      "invalid_input",
      "Activity type is not recognised.",
      400,
      { field: "type" },
    );
  }
  const title =
    input.title === undefined ? null : cleanText(input.title, 200, "title");
  const body =
    input.body === undefined ? null : cleanText(input.body, 10000, "body");
  if (!title && !body) {
    throw new CrmError("invalid_input", "Enter a title or a note.", 400, {
      field: "body",
    });
  }
  let occurredAt: string | null = null;
  if (input.occurredAt) {
    const date = parseDateTime(input.occurredAt);
    if (!date) {
      throw new CrmError("invalid_input", "Enter a valid date and time.", 400, {
        field: "occurredAt",
      });
    }
    occurredAt = date.toISOString();
  }
  let metadata: Record<string, unknown> = {};
  if (input.metadata) {
    if (typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
      throw new CrmError(
        "invalid_input",
        "Activity metadata must be an object.",
        400,
        {
          field: "metadata",
        },
      );
    }
    const encoded = JSON.stringify(input.metadata);
    if (encoded.length > 8000) {
      throw new CrmError(
        "invalid_input",
        "Activity metadata is too large.",
        400,
        {
          field: "metadata",
        },
      );
    }
    metadata = input.metadata;
  }
  return {
    type,
    title,
    body,
    occurredAt,
    companyId: input.companyId,
    contactId: input.contactId,
    opportunityId: input.opportunityId,
    metadata,
  };
}

export async function createActivityInDb(
  db: Db,
  actor: Actor,
  input: ActivityWrite,
  provenance?: Provenance,
) {
  const write = prepareActivity(input);
  const links = await resolveLinks(db, actor.workspaceId, write);
  if (!links.companyId && !links.contactId && !links.opportunityId) {
    throw new CrmError(
      "invalid_input",
      "Attach the activity to a company, contact, or opportunity.",
      400,
      { field: "companyId" },
    );
  }
  const actorRef = actorIds(actor);
  try {
    const inserted = await db.query<{ id: string }>(
      `insert into crm.activities (
        workspace_id, type, title, body, occurred_at, company_id, contact_id,
        opportunity_id, actor_user_id, actor_agent_id, metadata
      ) values (
        $1, $2, $3, $4, coalesce($5::timestamptz, now()), $6, $7, $8, $9, $10, $11::jsonb
      ) returning id`,
      [
        actor.workspaceId,
        write.type,
        write.title,
        write.body,
        write.occurredAt,
        links.companyId,
        links.contactId,
        links.opportunityId,
        actorRef.userId,
        actorRef.agentId,
        JSON.stringify(write.metadata),
      ],
    );
    const saved = await db.query<ActivityRow>(
      `${ACTIVITY_SQL} where a.id = $1`,
      [inserted.rows[0].id],
    );
    const row = saved.rows[0];
    if (!row)
      throw new CrmError("internal_error", "Activity was not saved.", 500);
    const activity = mapActivity(row);
    await recordAudit(
      db,
      actor,
      "activity.created",
      "activity",
      activity.id,
      provenance,
      {
        after: activity,
      },
    );
    return activity;
  } catch (error) {
    constraintError(
      error,
      "duplicate_activity",
      "That activity already exists.",
    );
  }
}

export async function listActivities(
  actor: Actor,
  query: ActivityListQuery = {},
) {
  assertScope(actor.scopes, "crm:read");
  const page = pageWindow(query.limit, query.offset);
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["a.workspace_id = $1", "a.archived_at is null"];
    if (query.companyId) {
      values.push(query.companyId);
      where.push(`a.company_id = $${values.length}`);
    }
    if (query.contactId) {
      values.push(query.contactId);
      where.push(`a.contact_id = $${values.length}`);
    }
    if (query.opportunityId) {
      values.push(query.opportunityId);
      where.push(`a.opportunity_id = $${values.length}`);
    }
    if (query.type) {
      values.push(query.type);
      where.push(`a.type = $${values.length}`);
    }
    const text = query.query?.trim();
    if (text) {
      values.push(likePattern(text.slice(0, 200)));
      const ref = `$${values.length}`;
      where.push(`(
        coalesce(a.title, '') ilike ${ref} escape '\\'
        or coalesce(a.body, '') ilike ${ref} escape '\\'
        or coalesce(co.name, '') ilike ${ref} escape '\\'
      )`);
    }
    const whereSql = where.join(" and ");
    const count = await db.query<{ total: number }>(
      `select count(*)::int as total
       from crm.activities a
       left join crm.companies co on co.id = a.company_id
       where ${whereSql}`,
      values,
    );
    const listed = [...values, page.limit, page.offset];
    const rows = await db.query<ActivityRow>(
      `${ACTIVITY_SQL}
       where ${whereSql}
       order by a.occurred_at desc, a.id desc
       limit $${listed.length - 1} offset $${listed.length}`,
      listed,
    );
    return {
      data: rows.rows.map(mapActivity),
      total: count.rows[0]?.total ?? 0,
      limit: page.limit,
      offset: page.offset,
    };
  });
}

export async function listActivitiesByContact(
  actor: Actor,
  contactIds: string[],
) {
  assertScope(actor.scopes, "crm:read");
  const ids = [...new Set(contactIds.filter((id) => isUuid(id)))];
  const grouped: Record<string, Activity[]> = {};
  for (const id of ids) grouped[id] = [];
  if (ids.length === 0) return grouped;
  return withActor(actor, async (db) => {
    const rows = await db.query<ActivityRow>(
      `select
         id, workspace_id, type, title, body, occurred_at, company_id, company_name,
         contact_id, contact_name, opportunity_id, opportunity_name,
         actor_user_id, actor_agent_id, actor_name, metadata, created_at
       from (
         select
           a.id,
           a.workspace_id,
           a.type,
           a.title,
           a.body,
           a.occurred_at,
           a.company_id,
           co.name as company_name,
           a.contact_id,
           coalesce(
             nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''),
             ct.email,
             ct.phone
           ) as contact_name,
           a.opportunity_id,
           op.name as opportunity_name,
           a.actor_user_id,
           a.actor_agent_id,
           ${ACTOR_NAME_SQL} as actor_name,
           a.metadata,
           a.created_at,
           row_number() over (
             partition by a.contact_id
             order by a.occurred_at desc, a.id desc
           ) as rn
         from crm.activities a
         left join crm.companies co on co.id = a.company_id
         left join crm.contacts ct on ct.id = a.contact_id
         left join crm.opportunities op on op.id = a.opportunity_id
         ${ACTOR_JOIN_SQL}
         where a.workspace_id = $1 and a.contact_id = any($2::uuid[]) and a.archived_at is null
       ) ranked
       where rn <= 40
       order by occurred_at desc, id desc`,
      [actor.workspaceId, ids],
    );
    for (const row of rows.rows) {
      const activity = mapActivity(row);
      if (activity.contactId) grouped[activity.contactId]?.push(activity);
    }
    return grouped;
  });
}

export async function listCompanyTimeline(
  actor: Actor,
  companyId: string,
  limit = 100,
) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(companyId)) return [];
  const rowLimit = Math.min(200, Math.max(1, Math.trunc(limit) || 100));
  return withActor(actor, async (db) => {
    const rows = await db.query<ActivityRow>(
      `${ACTIVITY_SQL}
       where a.workspace_id = $1
         and a.archived_at is null
         and (
           a.company_id = $2
           or a.contact_id in (
             select c.id
             from crm.contacts c
             where c.workspace_id = $1
               and c.company_id = $2
               and c.archived_at is null
           )
         )
       order by a.occurred_at desc, a.id desc
       limit $3`,
      [actor.workspaceId, companyId, rowLimit],
    );
    return rows.rows.map(mapActivity);
  });
}

export type LoggedActivityType = "note" | "call" | "email";

export async function logActivity(
  actor: Actor,
  target: { companyId?: string | null; contactId?: string | null },
  type: LoggedActivityType,
  title: string,
  body: string,
  options: MutationOptions = {},
) {
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (type === "note" && !trimmedBody) {
    throw new CrmError("invalid_input", "Write the note.", 400, {
      field: "body",
    });
  }
  if (type === "call" && !trimmedTitle && !trimmedBody) {
    throw new CrmError("invalid_input", "Describe the call.", 400, {
      field: "title",
    });
  }
  if (type === "email" && !trimmedTitle) {
    throw new CrmError("invalid_input", "Add a subject.", 400, {
      field: "title",
    });
  }
  if (type === "email" && !trimmedBody) {
    throw new CrmError("invalid_input", "Write the email.", 400, {
      field: "body",
    });
  }
  const companyId = target.companyId || null;
  const contactId = target.contactId || null;
  if (!companyId && !contactId) {
    throw new CrmError(
      "invalid_input",
      "Attach the activity to a company or contact.",
      400,
      { field: "contactId" },
    );
  }
  if ((companyId && !isUuid(companyId)) || (contactId && !isUuid(contactId))) {
    throw new CrmError("not_found", "Record not found.", 404);
  }
  const saved = await createActivity(
    actor,
    {
      type,
      title: trimmedTitle || null,
      body: trimmedBody || null,
      ...(companyId ? { companyId } : {}),
      contactId,
      metadata: type === "email" ? { source: "manual" } : { source: "web" },
    },
    options,
  );
  return saved.body.activity;
}

export async function getActivity(actor: Actor, id: string) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw new CrmError("not_found", "Activity not found.", 404);
  return withActor(actor, async (db) => {
    const result = await db.query<ActivityRow>(
      `${ACTIVITY_SQL} where a.id = $1 and a.archived_at is null`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new CrmError("not_found", "Activity not found.", 404);
    return mapActivity(row);
  });
}

export async function createActivity(
  actor: Actor,
  input: ActivityWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ activity: Activity }>> {
  assertScope(actor.scopes, "activities:write");
  const provenance = options.provenance ?? { operation: "create_activity" };
  const hash = requestHash("create_activity", { input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 201, async () => ({
      activity: await createActivityInDb(db, actor, input, provenance),
    })),
  );
}

type ArchiveRow = {
  id: string;
  type: ActivityType;
  title: string | null;
  occurred_at: Date | string;
  company_id: string | null;
  contact_id: string | null;
  actor_user_id: string | null;
  actor_agent_id: string | null;
  archived_at: Date | string | null;
};

const ARCHIVE_DENIED =
  "Only the person who logged this activity, or an owner or admin, can delete it.";

function mayArchive(actor: Actor, row: Pick<ArchiveRow, "actor_user_id" | "actor_agent_id">) {
  if (actor.type === "agent") return row.actor_agent_id === actor.agentId;
  return row.actor_user_id === actor.userId || actor.role === "owner" || actor.role === "admin";
}

async function readForArchive(db: Db, actor: Actor, id: string) {
  const result = await db.query<ArchiveRow>(
    `select id, type, title, occurred_at, company_id, contact_id, actor_user_id, actor_agent_id, archived_at
     from crm.activities where id = $1 and workspace_id = $2`,
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", "Activity not found.", 404);
  return row;
}

function archiveSummary(row: ArchiveRow) {
  return {
    type: row.type,
    title: row.title,
    occurredAt: iso(row.occurred_at),
    companyId: row.company_id,
    contactId: row.contact_id,
  };
}

async function setArchived(db: Db, actor: Actor, row: ArchiveRow, archived: boolean) {
  if (!mayArchive(actor, row)) throw new CrmError("forbidden", ARCHIVE_DENIED, 403);
  const updated = await db.query<{ archived_at: Date | string | null }>(
    `update crm.activities set archived_at = ${archived ? "now()" : "null"}
     where id = $1 and workspace_id = $2 returning archived_at`,
    [row.id, actor.workspaceId],
  );
  if (updated.rowCount === 0) throw new CrmError("forbidden", ARCHIVE_DENIED, 403);
  return iso(updated.rows[0].archived_at);
}

export type ClearedHealth = { companyId: string; health: string; healthReason: string | null; healthAt: string | null };

async function clearHealthFrom(db: Db, actor: Actor, activityId: string, provenance: Provenance, keepCompanyId: string | null = null) {
  const rows = await db.query<{ id: string; health: string | null; health_reason: string | null; health_at: Date | string | null }>(
    `select id, health, health_reason, health_at from crm.companies
     where workspace_id = $1 and health_activity_id = $2 and id is distinct from $3::uuid
     for update`,
    [actor.workspaceId, activityId, keepCompanyId],
  );
  const cleared: ClearedHealth[] = [];
  for (const row of rows.rows) {
    await db.query(
      "update crm.companies set health = null, health_reason = null, health_at = null, health_activity_id = null where id = $1",
      [row.id],
    );
    if (!row.health) continue;
    cleared.push({ companyId: row.id, health: row.health, healthReason: row.health_reason, healthAt: iso(row.health_at) });
    await recordAudit(db, actor, "company.updated", "company", row.id, provenance, {
      fields: row.health_reason === null ? ["health"] : ["health", "healthReason"],
      before: { health: row.health, healthReason: row.health_reason },
      after: { health: null, healthReason: null },
      activityId,
    });
  }
  return cleared;
}

async function restoreHealthFrom(db: Db, actor: Actor, activityId: string, cleared: ClearedHealth[], provenance: Provenance) {
  for (const item of cleared) {
    if (!isUuid(item.companyId)) continue;
    const restored = await db.query<{ id: string }>(
      `update crm.companies
       set health = $3, health_reason = $4, health_at = $5, health_activity_id = $6
       where id = $1 and workspace_id = $2 and health is null and health_at is null and health_activity_id is null
       returning id`,
      [item.companyId, actor.workspaceId, item.health, item.healthReason, item.healthAt, activityId],
    );
    if (restored.rowCount === 0) continue;
    await recordAudit(db, actor, "company.updated", "company", item.companyId, provenance, {
      fields: item.healthReason === null ? ["health"] : ["health", "healthReason"],
      before: { health: null, healthReason: null },
      after: { health: item.health, healthReason: item.healthReason },
      activityId,
    });
  }
}

export async function archiveActivityInDb(db: Db, actor: Actor, id: string, provenance: Provenance) {
  const row = await readForArchive(db, actor, id);
  if (row.archived_at) return { id, archivedAt: iso(row.archived_at), changed: false };
  const archivedAt = await setArchived(db, actor, row, true);
  const clearedHealth = await clearHealthFrom(db, actor, id, provenance);
  await recordAudit(db, actor, "activity.archived", "activity", id, provenance, {
    before: { archivedAt: null },
    after: { archivedAt },
    activity: archiveSummary(row),
    ...(clearedHealth.length > 0 ? { clearedHealth } : {}),
  });
  return { id, archivedAt, changed: true };
}

export async function restoreActivityInDb(
  db: Db,
  actor: Actor,
  id: string,
  provenance: Provenance,
  clearedHealth: ClearedHealth[] = [],
) {
  const row = await readForArchive(db, actor, id);
  if (!row.archived_at) return { id, archivedAt: null, changed: false };
  await setArchived(db, actor, row, false);
  await recordAudit(db, actor, "activity.updated", "activity", id, provenance, {
    fields: ["archivedAt"],
    before: { archivedAt: iso(row.archived_at) },
    after: { archivedAt: null },
    activity: archiveSummary(row),
  });
  await restoreHealthFrom(db, actor, id, clearedHealth, provenance);
  return { id, archivedAt: null, changed: true, activity: archiveSummary(row) };
}

export async function archiveActivity(actor: Actor, id: string, provenance: Provenance) {
  assertScope(actor.scopes, "activities:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Activity not found.", 404);
  return withActor(actor, (db) => archiveActivityInDb(db, actor, id, provenance));
}

type EditRow = ArchiveRow & {
  body: string | null;
  opportunity_id: string | null;
  metadata: Record<string, unknown> | null;
};

export type ActivityEditValues = {
  type: ActivityType;
  title: string | null;
  body: string | null;
  occurredAt: string | null;
  companyId: string | null;
  contactId: string | null;
  opportunityId: string | null;
};

const EDIT_DENIED = "Only the person who logged this activity, or an owner or admin, can edit it.";

const EDIT_COLUMNS: Record<ActivityEditField, string> = {
  type: "type",
  title: "title",
  body: "body",
  occurredAt: "occurred_at",
  companyId: "company_id",
  contactId: "contact_id",
  opportunityId: "opportunity_id",
};

const LINK_FIELDS: ActivityEditField[] = ["companyId", "contactId", "opportunityId"];

const EDIT_ROW_SQL = `select id, type, title, body, occurred_at, company_id, contact_id, opportunity_id,
    actor_user_id, actor_agent_id, metadata, archived_at
  from crm.activities where id = $1 and workspace_id = $2`;

function editValues(row: EditRow): ActivityEditValues {
  return {
    type: row.type,
    title: row.title,
    body: row.body,
    occurredAt: iso(row.occurred_at),
    companyId: row.company_id,
    contactId: row.contact_id,
    opportunityId: row.opportunity_id,
  };
}

export async function readActivityState(db: Db, workspaceId: string, id: string) {
  if (!isUuid(id)) return null;
  const result = await db.query<EditRow>(EDIT_ROW_SQL, [id, workspaceId]);
  const row = result.rows[0];
  if (!row) return null;
  return { values: editValues(row), archivedAt: iso(row.archived_at) };
}

function linkId(value: unknown, field: ActivityEditField) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !isUuid(value)) {
    const noun = field === "companyId" ? "Company" : field === "contactId" ? "Contact" : "Opportunity";
    throw new CrmError("not_found", `${noun} not found.`, 404, { field });
  }
  return value;
}

function editedValue(field: ActivityEditField, value: unknown): unknown {
  if (field === "type") {
    if (typeof value !== "string" || !(ACTIVITY_TYPES as readonly string[]).includes(value)) {
      throw new CrmError("invalid_input", "Activity type is not recognised.", 400, { field: "type" });
    }
    return value;
  }
  if (field === "title" || field === "body") {
    if (value !== null && typeof value !== "string") {
      throw new CrmError("invalid_input", `Enter the ${field === "title" ? "title" : "text"} as text.`, 400, { field });
    }
    return cleanText(value, field === "title" ? 200 : 10000, field);
  }
  if (field === "occurredAt") {
    const date = typeof value === "string" ? parseDateTime(value) : null;
    if (!date) throw new CrmError("invalid_input", "Enter a valid date and time.", 400, { field: "occurredAt" });
    return date.toISOString();
  }
  return linkId(value, field);
}

async function linkedCompany(db: Db, workspaceId: string, values: ActivityEditValues) {
  if (values.companyId) return values.companyId;
  if (!values.contactId) return null;
  const result = await db.query<{ company_id: string | null }>(
    "select company_id from crm.contacts where id = $1 and workspace_id = $2",
    [values.contactId, workspaceId],
  );
  return result.rows[0]?.company_id ?? null;
}

function editSummary(values: ActivityEditValues) {
  return {
    type: values.type,
    title: values.title,
    occurredAt: values.occurredAt,
    companyId: values.companyId,
    contactId: values.contactId,
  };
}

function lockedField(field: ActivityEditField, origin: ActivityOrigin) {
  const limit = origin === "logged" ? "" : ` ${ORIGIN_LIMITS[origin]}`;
  return new CrmError("invalid_input", `${ACTIVITY_FIELD_LABELS[field]} can't be changed.${limit}`, 400, { field });
}

async function readForEdit(db: Db, actor: Actor, id: string) {
  const result = await db.query<EditRow>(EDIT_ROW_SQL, [id, actor.workspaceId]);
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", "Activity not found.", 404);
  if (!mayArchive(actor, row)) throw new CrmError("forbidden", EDIT_DENIED, 403);
  const locked = await db.query<EditRow>(`${EDIT_ROW_SQL} for update`, [id, actor.workspaceId]);
  if (!locked.rows[0]) throw new CrmError("forbidden", EDIT_DENIED, 403);
  return locked.rows[0];
}

export async function updateActivityInDb(db: Db, actor: Actor, id: string, input: ActivityEdit, provenance: Provenance) {
  if (!isUuid(id)) throw new CrmError("not_found", "Activity not found.", 404);
  const row = await readForEdit(db, actor, id);
  if (row.archived_at) {
    throw new CrmError("conflict", "This activity has been deleted. Undo the delete before editing it.", 409);
  }
  const before = editValues(row);
  const transcript = await db.query("select 1 from crm.call_insights where activity_id = $1 and workspace_id = $2", [id, actor.workspaceId]);
  const origin = activityOrigin({ type: row.type, metadata: row.metadata ?? {} }, (transcript.rowCount ?? 0) > 0);
  const allowed = editableFields(origin);
  const next: ActivityEditValues = { ...before };
  const asked: Partial<Record<ActivityEditField, unknown>> = {};
  for (const field of ACTIVITY_EDIT_FIELDS) {
    if (input[field] === undefined) continue;
    asked[field] = editedValue(field, input[field]);
  }
  for (const field of ACTIVITY_EDIT_FIELDS) {
    if (field in asked && asked[field] !== before[field] && !allowed.includes(field)) throw lockedField(field, origin);
  }
  for (const [field, value] of Object.entries(asked)) {
    if (!LINK_FIELDS.includes(field as ActivityEditField)) Object.assign(next, { [field]: value });
  }
  if (!next.title && !next.body) {
    throw new CrmError("invalid_input", "Enter a title or a note.", 400, { field: "body" });
  }
  if (LINK_FIELDS.some((field) => field in asked && asked[field] !== before[field])) {
    const links = await resolveLinks(
      db,
      actor.workspaceId,
      Object.fromEntries(LINK_FIELDS.filter((field) => field in asked).map((field) => [field, asked[field] as string | null])),
      { companyId: before.companyId, contactId: before.contactId, opportunityId: before.opportunityId },
    );
    if (!links.companyId && !links.contactId && !links.opportunityId) {
      throw new CrmError("invalid_input", "Keep the activity on a company, person or opportunity.", 400, { field: "companyId" });
    }
    Object.assign(next, links);
    for (const field of LINK_FIELDS) {
      if (next[field] !== before[field] && !allowed.includes(field)) throw lockedField(field, origin);
    }
  }
  const fields = ACTIVITY_EDIT_FIELDS.filter((field) => next[field] !== before[field]);
  if (fields.length === 0) {
    const current = await db.query<ActivityRow>(`${ACTIVITY_SQL} where a.id = $1`, [id]);
    return { activity: mapActivity(current.rows[0]), changed: false, fields: [] as ActivityEditField[] };
  }
  const values: unknown[] = [id, actor.workspaceId];
  const sets = fields.map((field) => {
    values.push(next[field]);
    return `${EDIT_COLUMNS[field]} = $${values.length}`;
  });
  const updated = await db.query(
    `update crm.activities set ${sets.join(", ")} where id = $1 and workspace_id = $2 returning id`,
    values,
  );
  if (updated.rowCount === 0) throw new CrmError("forbidden", EDIT_DENIED, 403);
  const linksChanged = fields.some((field) => LINK_FIELDS.includes(field));
  let clearedHealth: ClearedHealth[] = [];
  if (linksChanged) {
    if ((transcript.rowCount ?? 0) > 0) {
      await db.query(
        "update crm.call_insights set contact_id = $3, company_id = $4 where activity_id = $1 and workspace_id = $2",
        [id, actor.workspaceId, next.contactId, next.companyId],
      );
    }
    clearedHealth = await clearHealthFrom(db, actor, id, provenance, await linkedCompany(db, actor.workspaceId, next));
  }
  const saved = await db.query<ActivityRow>(`${ACTIVITY_SQL} where a.id = $1`, [id]);
  const activity = mapActivity(saved.rows[0]);
  await recordAudit(db, actor, "activity.updated", "activity", id, provenance, {
    fields,
    before: Object.fromEntries(fields.map((field) => [field, before[field]])),
    after: Object.fromEntries(fields.map((field) => [field, next[field]])),
    activity: editSummary(next),
    ...(clearedHealth.length > 0 ? { clearedHealth } : {}),
  });
  return { activity, changed: true, fields };
}

export async function undoActivityEditInDb(
  db: Db,
  actor: Actor,
  id: string,
  before: ActivityEdit,
  clearedHealth: ClearedHealth[],
  provenance: Provenance,
) {
  const result = await updateActivityInDb(db, actor, id, before, provenance);
  await restoreHealthFrom(db, actor, id, clearedHealth, provenance);
  return result;
}

export async function updateActivity(actor: Actor, id: string, input: ActivityEdit, provenance: Provenance) {
  assertScope(actor.scopes, "activities:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Activity not found.", 404);
  return withActor(actor, (db) => updateActivityInDb(db, actor, id, input, provenance));
}

export type ActivitySummary = { type: ActivityType; title: string | null; occurredAt: string | null; archivedAt: string | null };

export async function activitySummaries(db: Db, workspaceId: string, ids: string[]) {
  const wanted = [...new Set(ids.filter(isUuid))];
  const found = new Map<string, ActivitySummary>();
  if (wanted.length === 0) return found;
  const result = await db.query<{ id: string; type: ActivityType; title: string | null; occurred_at: Date | string; archived_at: Date | string | null }>(
    "select id, type, title, occurred_at, archived_at from crm.activities where workspace_id = $1 and id = any($2::uuid[])",
    [workspaceId, wanted],
  );
  for (const row of result.rows) {
    found.set(row.id, { type: row.type, title: row.title, occurredAt: iso(row.occurred_at), archivedAt: iso(row.archived_at) });
  }
  return found;
}
