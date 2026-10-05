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
    a.metadata,
    a.created_at
  from crm.activities a
  left join crm.companies co on co.id = a.company_id
  left join crm.contacts ct on ct.id = a.contact_id
  left join crm.opportunities op on op.id = a.opportunity_id
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
    throw new CrmError("invalid_input", "Activity type is not recognised.", 400, { field: "type" });
  }
  const title = input.title === undefined ? null : cleanText(input.title, 200, "title");
  const body = input.body === undefined ? null : cleanText(input.body, 10000, "body");
  if (!title && !body) {
    throw new CrmError("invalid_input", "Enter a title or a note.", 400, { field: "body" });
  }
  let occurredAt: string | null = null;
  if (input.occurredAt) {
    const date = new Date(input.occurredAt);
    if (Number.isNaN(date.getTime())) {
      throw new CrmError("invalid_input", "Enter a valid date and time.", 400, {
        field: "occurredAt",
      });
    }
    occurredAt = date.toISOString();
  }
  let metadata: Record<string, unknown> = {};
  if (input.metadata) {
    if (typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
      throw new CrmError("invalid_input", "Activity metadata must be an object.", 400, {
        field: "metadata",
      });
    }
    const encoded = JSON.stringify(input.metadata);
    if (encoded.length > 8000) {
      throw new CrmError("invalid_input", "Activity metadata is too large.", 400, {
        field: "metadata",
      });
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
    const saved = await db.query<ActivityRow>(`${ACTIVITY_SQL} where a.id = $1`, [
      inserted.rows[0].id,
    ]);
    const row = saved.rows[0];
    if (!row) throw new CrmError("internal_error", "Activity was not saved.", 500);
    const activity = mapActivity(row);
    await recordAudit(db, actor, "activity.created", "activity", activity.id, provenance, {
      after: activity,
    });
    return activity;
  } catch (error) {
    constraintError(error, "duplicate_activity", "That activity already exists.");
  }
}

export async function listActivities(actor: Actor, query: ActivityListQuery = {}) {
  assertScope(actor.scopes, "crm:read");
  const page = pageWindow(query.limit, query.offset);
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["a.workspace_id = $1"];
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

export async function getActivity(actor: Actor, id: string) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw new CrmError("not_found", "Activity not found.", 404);
  return withActor(actor, async (db) => {
    const result = await db.query<ActivityRow>(`${ACTIVITY_SQL} where a.id = $1`, [id]);
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
