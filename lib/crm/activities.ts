import type { Db } from "@/lib/db/pool";
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

function mayArchive(actor: Actor, row: ArchiveRow) {
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

export async function archiveActivityInDb(db: Db, actor: Actor, id: string, provenance: Provenance) {
  const row = await readForArchive(db, actor, id);
  if (row.archived_at) return { id, archivedAt: iso(row.archived_at), changed: false };
  const archivedAt = await setArchived(db, actor, row, true);
  await recordAudit(db, actor, "activity.archived", "activity", id, provenance, {
    before: { archivedAt: null },
    after: { archivedAt },
    activity: archiveSummary(row),
  });
  return { id, archivedAt, changed: true };
}

export async function restoreActivityInDb(db: Db, actor: Actor, id: string) {
  const row = await readForArchive(db, actor, id);
  if (!row.archived_at) return { id, archivedAt: null, changed: false };
  await setArchived(db, actor, row, false);
  return { id, archivedAt: null, changed: true, activity: archiveSummary(row) };
}

export async function archiveActivity(actor: Actor, id: string, provenance: Provenance) {
  assertScope(actor.scopes, "activities:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Activity not found.", 404);
  return withActor(actor, (db) => archiveActivityInDb(db, actor, id, provenance));
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
