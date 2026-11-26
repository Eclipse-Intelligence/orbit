import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { isUuid, recordAudit } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Provenance } from "@/lib/crm/types";

export async function linkActivityContactsInDb(db: Db, workspaceId: string, activityId: string, contactIds: string[]) {
  const wanted = [...new Set(contactIds.filter(isUuid))];
  if (wanted.length === 0) return [];
  const result = await db.query<{ contact_id: string }>(
    `insert into crm.activity_contacts (activity_id, contact_id, implicit)
     select $1, c.id, false
     from crm.contacts c
     where c.id = any($2::uuid[]) and c.workspace_id = $3 and c.archived_at is null
     on conflict (activity_id, contact_id) do update set implicit = false
     returning contact_id`,
    [activityId, wanted, workspaceId],
  );
  return result.rows.map((row) => row.contact_id);
}

type AttendeeState = {
  id: string;
  type: string;
  title: string | null;
  occurred_at: Date | string;
  company_id: string | null;
  contact_id: string | null;
  archived_at: Date | string | null;
};

async function lockedActivity(db: Db, actor: Actor, activityId: string) {
  if (!isUuid(activityId)) throw notFound("activity");
  const result = await db.query<AttendeeState>(
    `select id, type, title, occurred_at, company_id, contact_id, archived_at
     from crm.activities where id = $1 and workspace_id = $2`,
    [activityId, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row || row.archived_at) throw notFound("activity");
  const locked = await db.query<AttendeeState>(
    `select id, type, title, occurred_at, company_id, contact_id, archived_at
     from crm.activities where id = $1 and workspace_id = $2
     for update`,
    [activityId, actor.workspaceId],
  );
  if (!locked.rows[0]) throw new CrmError("forbidden", "Only its author, owners and admins can change who is on this.", 403);
  if (locked.rows[0].archived_at) throw notFound("activity");
  return locked.rows[0];
}

async function currentIds(db: Db, activityId: string) {
  const result = await db.query<{ contact_id: string }>(
    "select contact_id from crm.activity_contacts where activity_id = $1 order by created_at, contact_id",
    [activityId],
  );
  return result.rows.map((row) => row.contact_id);
}

async function auditAttendees(db: Db, actor: Actor, row: AttendeeState, before: string[], after: string[], provenance: Provenance) {
  await recordAudit(db, actor, "activity.updated", "activity", row.id, provenance, {
    fields: ["attendees"],
    before: { attendees: before },
    after: { attendees: after },
    activity: {
      type: row.type,
      title: row.title,
      occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
      companyId: row.company_id,
      contactId: row.contact_id,
    },
  });
}

export async function addActivityContactInDb(db: Db, actor: Actor, activityId: string, contactId: string, provenance: Provenance) {
  const row = await lockedActivity(db, actor, activityId);
  if (!isUuid(contactId)) throw notFound("contact");
  const found = await db.query(
    "select 1 from crm.contacts where id = $1 and workspace_id = $2 and archived_at is null",
    [contactId, actor.workspaceId],
  );
  if (!found.rowCount) throw notFound("contact");
  const before = await currentIds(db, activityId);
  if (before.includes(contactId)) return { changed: false, contactIds: before };
  await linkActivityContactsInDb(db, actor.workspaceId, activityId, [contactId]);
  const after = await currentIds(db, activityId);
  await auditAttendees(db, actor, row, before, after, provenance);
  return { changed: true, contactIds: after };
}

export async function removeActivityContactInDb(db: Db, actor: Actor, activityId: string, contactId: string, provenance: Provenance) {
  const row = await lockedActivity(db, actor, activityId);
  if (!isUuid(contactId)) throw notFound("contact");
  if (row.contact_id === contactId) {
    throw new CrmError("invalid_input", "Change the person on the activity to remove them.", 400, { field: "contactId" });
  }
  const before = await currentIds(db, activityId);
  if (!before.includes(contactId)) return { changed: false, contactIds: before };
  await db.query("delete from crm.activity_contacts where activity_id = $1 and contact_id = $2", [activityId, contactId]);
  const after = await currentIds(db, activityId);
  await auditAttendees(db, actor, row, before, after, provenance);
  return { changed: true, contactIds: after };
}

export async function addActivityContact(actor: Actor, activityId: string, contactId: string, provenance: Provenance) {
  assertScope(actor.scopes, "activities:write");
  return withActor(actor, (db) => addActivityContactInDb(db, actor, activityId, contactId, provenance));
}

export async function removeActivityContact(actor: Actor, activityId: string, contactId: string, provenance: Provenance) {
  assertScope(actor.scopes, "activities:write");
  return withActor(actor, (db) => removeActivityContactInDb(db, actor, activityId, contactId, provenance));
}
