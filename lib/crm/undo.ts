import type { Db } from "@/lib/db/pool";
import { formatDate, HEALTH_LABELS, lifecycleLabel } from "@/lib/companies";
import {
  archiveActivityInDb,
  readActivityState,
  restoreActivityInDb,
  undoActivityEditInDb,
  type ActivitySummary,
  type ClearedHealth,
} from "@/lib/crm/activities";
import { ACTIVITY_FIELD_LABELS, type ActivityEdit } from "@/lib/crm/activity-edit";
import { archiveCompanyInDb, readCompanyInDb, unarchiveCompanyInDb, updateCompanyInDb } from "@/lib/crm/companies";
import { archiveContactInDb, readContactInDb, unarchiveContactInDb, updateContactInDb } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid, lockNamespace, recordAudit } from "@/lib/crm/mutate";
import { stableStringify } from "@/lib/crm/normalize";
import { archiveOpportunityInDb, readOpportunityInDb, unarchiveOpportunityInDb, updateOpportunityInDb } from "@/lib/crm/opportunities";
import { readRelationshipOverride, setRelationshipOverrideInDb } from "@/lib/crm/relationship-override";
import { isRelationshipLabel, RELATIONSHIP_META } from "@/lib/crm/relationship-score";
import { REMINDER_OPTIONS } from "@/lib/crm/reminder-options";
import { hasScope, type Scope } from "@/lib/crm/scopes";
import { archiveTaskInDb, readTaskInDb, restoreTaskInDb, unarchiveTaskInDb } from "@/lib/crm/tasks";
import { formatDateTimeLabel } from "@/lib/date-input";
import { dateTimeInputValue } from "@/lib/time";
import type { AccountHealth, Actor, CompanyWrite, ContactWrite, OpportunityWrite, Provenance, TaskWrite } from "@/lib/crm/types";

type EntityType = "company" | "contact" | "opportunity" | "task" | "activity";
type RecordType = Exclude<EntityType, "activity">;

const NOUNS: Record<EntityType, string> = {
  company: "company",
  contact: "person",
  opportunity: "opportunity",
  task: "task",
  activity: "activity",
};

const ENTITY_TYPES = Object.keys(NOUNS) as EntityType[];

const TABLES: Record<EntityType, string> = {
  company: "companies",
  contact: "contacts",
  opportunity: "opportunities",
  task: "tasks",
  activity: "activities",
};

const LOCKS: Partial<Record<EntityType, string>> = { company: "companies", contact: "contacts", opportunity: "opportunities" };

const SCOPES: Record<EntityType, Scope> = {
  company: "companies:write",
  contact: "contacts:write",
  opportunity: "opportunities:write",
  task: "tasks:write",
  activity: "activities:write",
};

const FIELDS: Record<EntityType, Record<string, string>> = {
  activity: ACTIVITY_FIELD_LABELS,
  company: {
    name: "Name",
    domain: "Domain",
    website: "Website",
    description: "About",
    industry: "Industry",
    sizeCategory: "Size",
    linkedinUrl: "LinkedIn",
    phone: "Phone",
    address: "Address",
    logoUrl: "Logo",
    lifecycle: "Lifecycle",
    health: "Health",
    healthReason: "Health reason",
    ownerId: "Owner",
    source: "Source",
    sourceReference: "Source reference",
    tags: "Tags",
    relationshipOverride: "Relationship",
    relationshipOverrideReason: "Relationship reason",
  },
  contact: {
    firstName: "First name",
    lastName: "Last name",
    email: "Email",
    phone: "Phone",
    jobTitle: "Job title",
    linkedinUrl: "LinkedIn",
    ownerId: "Owner",
    source: "Source",
    sourceReference: "Source reference",
    notes: "Notes",
    companyId: "Company",
    tags: "Tags",
    relationshipOverride: "Relationship",
    relationshipOverrideReason: "Relationship reason",
  },
  opportunity: {
    companyId: "Company",
    primaryContactId: "Main contact",
    name: "Name",
    value: "Value",
    currency: "Currency",
    probability: "Probability",
    expectedCloseDate: "Close date",
    ownerId: "Owner",
    source: "Source",
  },
  task: {
    title: "Title",
    description: "Description",
    dueAt: "Due",
    remindMinutes: "Reminder",
    priority: "Priority",
    ownerId: "Owner",
    companyId: "Company",
    contactId: "Person",
    opportunityId: "Opportunity",
    completedAt: "Done",
  },
};

const UPDATE_EVENTS: Record<string, EntityType> = {
  "activity.updated": "activity",
  "company.updated": "company",
  "contact.updated": "contact",
  "opportunity.updated": "opportunity",
  "task.updated": "task",
  "task.completed": "task",
  "task.reopened": "task",
};

const RELATIONSHIP_FIELDS = new Set(["relationshipOverride", "relationshipOverrideReason"]);
const ID_FIELDS = new Set(["ownerId", "companyId", "contactId", "primaryContactId", "opportunityId"]);
const DATE_FIELDS = new Set(["dueAt", "completedAt", "archivedAt", "expectedCloseDate"]);
const DATE_TIME_FIELDS = new Set(["occurredAt"]);
const AUTOMATIC_SOURCES = ["microsoft", "microsoft_teams", "granola", "communication"];
const ACTIVITY_LABELS: Record<string, string> = { email: "Email", meeting: "Meeting", call: "Call", note: "Note", research: "Research", linkedin: "LinkedIn", agent_update: "Agent update", other: "Activity" };

type AuditRow = {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_type: string;
  actor_user_id: string | null;
  actor_agent_id: string | null;
  operation: string;
  source: string | null;
  changes: Record<string, unknown> | null;
  created_at: Date | string;
};

type Snapshot = { name: string; values: Record<string, unknown>; archivedAt: string | null };

type Plan = { ok: false; reason: string } | { ok: true; restores: string; run: () => Promise<unknown> };

type Described = { entityName: string; summary: string; plan: Plan };

export type RecentChange = {
  id: string;
  at: string | null;
  type: string;
  entityType: string;
  entityId: string;
  entityName: string;
  summary: string;
  canUndo: boolean;
  restores?: string;
  reason?: string;
};

const AUDIT_SQL = `select e.id, e.event_type, e.entity_type, e.entity_id, e.actor_type, e.actor_user_id, e.actor_agent_id,
    e.operation, e.source, e.changes, e.created_at
  from crm.audit_events e`;

function isEntity(value: string): value is EntityType {
  return value in NOUNS;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function same(left: unknown, right: unknown) {
  const shape = (value: unknown) => {
    if (value === undefined || value === "") return null;
    if (Array.isArray(value)) return [...value].map(String).sort();
    return value;
  };
  return stableStringify(shape(left)) === stableStringify(shape(right));
}

function clip(text: string) {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function activityName(summary: ActivitySummary | undefined) {
  if (!summary) return "an activity";
  const kind = ACTIVITY_LABELS[summary.type] ?? "Activity";
  const title = summary.title ? ` "${clip(summary.title)}"` : "";
  return `${kind}${title}${summary.occurredAt ? ` on ${formatDate(summary.occurredAt)}` : ""}`;
}

function shownValue(field: string, value: unknown, names: Map<string, string>) {
  const empty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  if (empty) {
    if (field === "relationshipOverride") return "Automatic";
    if (field === "completedAt") return "not done";
    if (field === "ownerId") return "Unassigned";
    return "empty";
  }
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (field === "relationshipOverride" && isRelationshipLabel(value)) return RELATIONSHIP_META[value].label;
  if (field === "health" && typeof value === "string" && value in HEALTH_LABELS) return HEALTH_LABELS[value as AccountHealth];
  if (field === "lifecycle" && typeof value === "string") return lifecycleLabel(value);
  if (field === "remindMinutes") return REMINDER_OPTIONS.find((option) => option.minutes === value)?.label ?? String(value);
  if (ID_FIELDS.has(field) && typeof value === "string") return names.get(value) ?? "a record that no longer exists";
  if (DATE_FIELDS.has(field) && typeof value === "string") return formatDate(value);
  if (DATE_TIME_FIELDS.has(field) && typeof value === "string") return formatDateTimeLabel(dateTimeInputValue(value));
  if (field === "type" && typeof value === "string") return ACTIVITY_LABELS[value] ?? value;
  return clip(String(value));
}

function idsIn(changes: Record<string, unknown> | null, into: Set<string>) {
  for (const side of [record(changes?.before), record(changes?.after)]) {
    if (!side) continue;
    for (const [field, value] of Object.entries(side)) {
      if (ID_FIELDS.has(field) && typeof value === "string" && isUuid(value)) into.add(value);
    }
  }
}

async function namesFor(db: Db, workspaceId: string, ids: Set<string>) {
  const names = new Map<string, string>();
  if (ids.size === 0) return names;
  const result = await db.query<{ id: string; name: string | null }>(
    `select id, name from crm.companies where workspace_id = $2 and id = any($1::uuid[])
     union all
     select id, coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email) from crm.contacts where workspace_id = $2 and id = any($1::uuid[])
     union all
     select id, name from crm.opportunities where workspace_id = $2 and id = any($1::uuid[])
     union all
     select p.id, coalesce(nullif(trim(p.full_name), ''), p.email) from crm.profiles p
       join crm.workspace_members m on m.user_id = p.id and m.workspace_id = $2
       where p.id = any($1::uuid[])`,
    [[...ids], workspaceId],
  );
  for (const row of result.rows) if (row.name) names.set(row.id, row.name);
  return names;
}

async function snapshot(db: Db, actor: Actor, entity: EntityType, id: string): Promise<Snapshot | null> {
  const workspaceId = actor.workspaceId;
  if (entity === "company") {
    const company = await readCompanyInDb(db, id, workspaceId);
    if (!company) return null;
    const override = await readRelationshipOverride(db, workspaceId, "company", id);
    return {
      name: company.name,
      values: { ...company, relationshipOverride: override?.label ?? null, relationshipOverrideReason: override?.reason ?? null },
      archivedAt: company.archivedAt,
    };
  }
  if (entity === "contact") {
    const contact = await readContactInDb(db, id, workspaceId);
    if (!contact) return null;
    const override = await readRelationshipOverride(db, workspaceId, "contact", id);
    return {
      name: contact.name,
      values: { ...contact, relationshipOverride: override?.label ?? null, relationshipOverrideReason: override?.reason ?? null },
      archivedAt: contact.archivedAt,
    };
  }
  if (entity === "opportunity") {
    const opportunity = await readOpportunityInDb(db, id);
    if (!opportunity || opportunity.workspaceId !== workspaceId) return null;
    return { name: opportunity.name, values: { ...opportunity }, archivedAt: opportunity.archivedAt };
  }
  if (entity === "task") {
    const task = await readTaskInDb(db, id);
    if (!task || task.workspaceId !== workspaceId) return null;
    return { name: task.title, values: { ...task }, archivedAt: task.archivedAt };
  }
  const activity = await readActivityState(db, workspaceId, id);
  if (!activity) return null;
  const { type, title, occurredAt } = activity.values;
  return {
    name: activityName({ type, title, occurredAt, archivedAt: activity.archivedAt }),
    values: { ...activity.values, archivedAt: activity.archivedAt },
    archivedAt: activity.archivedAt,
  };
}

function ownedBy(actor: Actor, event: AuditRow) {
  return actor.type === "user"
    ? event.actor_type === "user" && event.actor_user_id === actor.userId
    : event.actor_type === "agent" && event.actor_agent_id === actor.agentId;
}

function eventName(event: AuditRow, entity: EntityType | null) {
  const after = record(event.changes?.after);
  const activity = record(event.changes?.activity);
  if (entity === "activity" && activity) {
    return activityName({
      type: String(activity.type ?? "other") as ActivitySummary["type"],
      title: typeof activity.title === "string" ? activity.title : null,
      occurredAt: typeof activity.occurredAt === "string" ? activity.occurredAt : null,
      archivedAt: null,
    });
  }
  const name = after?.name ?? after?.title;
  return typeof name === "string" && name ? name : `this ${entity ? NOUNS[entity] : "record"}`;
}

function fieldList(changes: Record<string, unknown> | null) {
  const fields = changes?.fields;
  if (!Array.isArray(fields) || fields.length === 0 || !fields.every((field) => typeof field === "string")) return null;
  const before = record(changes?.before);
  const after = record(changes?.after);
  if (!before || !after) return null;
  const unique = [...new Set(fields as string[])];
  if (!unique.every((field) => field in before && field in after)) return null;
  return { fields: unique, before, after };
}

function changedSince(label: string, value: unknown, field: string, names: Map<string, string>) {
  return `This can't be undone because it has changed again since: ${label} is now ${shownValue(field, value, names)}.`;
}

function restoreFields(db: Db, actor: Actor, entity: RecordType, id: string, before: Record<string, unknown>, fields: string[], provenance: Provenance) {
  const plain = fields.filter((field) => !RELATIONSHIP_FIELDS.has(field) && field !== "completedAt");
  const write = Object.fromEntries(plain.map((field) => [field, before[field] ?? null]));
  return async () => {
    if (plain.length > 0) {
      if (entity === "company") await updateCompanyInDb(db, actor, id, write as CompanyWrite, provenance);
      if (entity === "contact") await updateContactInDb(db, actor, id, write as ContactWrite, provenance);
      if (entity === "opportunity") await updateOpportunityInDb(db, actor, id, write as OpportunityWrite, provenance);
    }
    if (entity === "task" && (plain.length > 0 || fields.includes("completedAt"))) {
      const completedAt = fields.includes("completedAt") ? ((before.completedAt as string | null) ?? null) : undefined;
      await restoreTaskInDb(db, actor, id, write as TaskWrite, completedAt, provenance);
    }
    if ((entity === "company" || entity === "contact") && fields.some((field) => RELATIONSHIP_FIELDS.has(field))) {
      const label = before.relationshipOverride;
      await setRelationshipOverrideInDb(
        db,
        actor,
        entity,
        id,
        { label: isRelationshipLabel(label) ? label : null, reason: typeof before.relationshipOverrideReason === "string" ? before.relationshipOverrideReason : null },
        provenance,
      );
    }
  };
}

function restoreActivityFields(
  db: Db,
  actor: Actor,
  id: string,
  before: Record<string, unknown>,
  fields: string[],
  changes: Record<string, unknown> | null,
  provenance: Provenance,
) {
  const write = Object.fromEntries(fields.map((field) => [field, before[field] ?? null])) as ActivityEdit;
  return () => undoActivityEditInDb(db, actor, id, write, clearedHealthIn(changes), provenance);
}

function archiveRun(db: Db, actor: Actor, entity: EntityType, id: string, provenance: Provenance) {
  return async () => {
    if (entity === "company") return archiveCompanyInDb(db, actor, id, provenance);
    if (entity === "contact") return archiveContactInDb(db, actor, id, provenance);
    if (entity === "opportunity") return archiveOpportunityInDb(db, actor, id, provenance);
    if (entity === "task") return archiveTaskInDb(db, actor, id, provenance);
    return archiveActivityInDb(db, actor, id, provenance);
  };
}

function clearedHealthIn(changes: Record<string, unknown> | null): ClearedHealth[] {
  const list = changes?.clearedHealth;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const entry = record(item);
    if (!entry || typeof entry.companyId !== "string" || typeof entry.health !== "string" || !(entry.health in HEALTH_LABELS)) return [];
    return [
      {
        companyId: entry.companyId,
        health: entry.health,
        healthReason: typeof entry.healthReason === "string" ? entry.healthReason : null,
        healthAt: typeof entry.healthAt === "string" ? entry.healthAt : null,
      },
    ];
  });
}

function unarchiveRun(db: Db, actor: Actor, entity: EntityType, id: string, provenance: Provenance, changes: Record<string, unknown> | null) {
  return async () => {
    if (entity === "company") return unarchiveCompanyInDb(db, actor, id, provenance);
    if (entity === "contact") return unarchiveContactInDb(db, actor, id, provenance);
    if (entity === "opportunity") return unarchiveOpportunityInDb(db, actor, id, provenance);
    if (entity === "task") return unarchiveTaskInDb(db, actor, id, provenance);
    return restoreActivityInDb(db, actor, id, provenance, clearedHealthIn(changes));
  };
}

async function describeEvent(
  db: Db,
  actor: Actor,
  event: AuditRow,
  names: Map<string, string>,
  undone: boolean,
  provenance: Provenance,
): Promise<Described> {
  const entity = isEntity(event.entity_type) ? event.entity_type : null;
  if (!entity || event.event_type.endsWith(".merged")) {
    const name = eventName(event, entity);
    return { entityName: name, summary: `${event.event_type.replace(/[._]/g, " ")}: ${name}`, plan: { ok: false, reason: "Orbit can't undo this kind of change." } };
  }
  const noun = NOUNS[entity];
  const plain = (reason: string): Described => ({ entityName: `this ${noun}`, summary: `A change to this ${noun}`, plan: { ok: false, reason } });
  if (!ownedBy(actor, event)) return plain("You can only undo your own changes.");
  const current = await snapshot(db, actor, entity, event.entity_id);
  if (!current && entity === "task") return plain("You can't see that task any more.");
  const entityName = current?.name ?? eventName(event, entity);
  const refuse = (summary: string, reason: string): Described => ({ entityName, summary, plan: { ok: false, reason } });
  const fallback = `${event.event_type.replace(/[._]/g, " ")}: ${entityName}`;

  if (event.event_type.endsWith(".undone")) return refuse(`Undid a change to ${entityName}`, "This is already an undo.");

  const changes = record(event.changes);
  const before = record(changes?.before);
  const after = record(changes?.after);
  const updateEntity = UPDATE_EVENTS[event.event_type];
  const fields = updateEntity ? fieldList(changes) : null;
  let summary = fallback;
  let restores = "";
  let check: string | null = null;
  let run: (() => Promise<unknown>) | null = null;

  if (updateEntity && fields && fields.fields.length === 1 && fields.fields[0] === "archivedAt") {
    summary = entity === "activity" ? `Brought back ${entityName}` : `Restored ${noun} ${entityName} from the archive`;
    restores = entity === "activity" ? `Deletes ${entityName} again.` : `Archives ${entityName} again.`;
    if (current && current.archivedAt) check = `This can't be undone because ${entityName} is ${entity === "activity" ? "deleted" : "archived"} again.`;
    run = archiveRun(db, actor, entity, event.entity_id, provenance);
  } else if (updateEntity === "activity" && fields && fields.fields.every((field) => field in FIELDS.activity)) {
    const labels = FIELDS.activity;
    const parts = fields.fields.map(
      (field) => `${labels[field]} from ${shownValue(field, fields.before[field], names)} to ${shownValue(field, fields.after[field], names)}`,
    );
    summary = `Edited ${entityName}: ${parts.join("; ")}`;
    restores = `Puts back ${fields.fields.map((field) => `${labels[field]}: ${shownValue(field, fields.before[field], names)}`).join("; ")}.`;
    if (current) {
      const moved = fields.fields.find((field) => !same(current.values[field], fields.after[field]));
      if (moved) check = changedSince(labels[moved], current.values[moved], moved, names);
      else if (current.archivedAt) check = `This can't be undone while ${entityName} is deleted.`;
    }
    run = restoreActivityFields(db, actor, event.entity_id, fields.before, fields.fields, changes, provenance);
  } else if (updateEntity && updateEntity !== "activity" && fields && fields.fields.every((field) => field in FIELDS[updateEntity])) {
    const labels = FIELDS[updateEntity];
    const onlyCompletion = updateEntity === "task" && fields.fields.length === 1 && fields.fields[0] === "completedAt";
    if (onlyCompletion) {
      const done = Boolean(fields.after.completedAt);
      summary = done ? `Marked task ${entityName} done` : `Reopened task ${entityName}`;
      restores = done ? `Reopens ${entityName}.` : `Marks ${entityName} done again.`;
    } else {
      const parts = fields.fields.map(
        (field) => `${labels[field]} from ${shownValue(field, fields.before[field], names)} to ${shownValue(field, fields.after[field], names)}`,
      );
      summary = `Changed ${noun} ${entityName}: ${parts.join("; ")}`;
      restores = `Puts back ${fields.fields.map((field) => `${labels[field]}: ${shownValue(field, fields.before[field], names)}`).join("; ")}.`;
    }
    if (current) {
      const moved = fields.fields.find((field) => !same(current.values[field], fields.after[field]));
      if (moved) check = changedSince(labels[moved], current.values[moved], moved, names);
      else if (current.archivedAt) check = `This can't be undone while ${entityName} is archived.`;
    }
    run = restoreFields(db, actor, updateEntity, event.entity_id, fields.before, fields.fields, provenance);
  } else if (updateEntity) {
    return refuse(`Changed ${noun} ${entityName}`, "This change isn't in a shape Orbit can safely reverse.");
  } else if (event.event_type === "opportunity.stage_changed" && before && after && typeof before.stageId === "string") {
    const from = typeof before.stageName === "string" ? before.stageName : "the earlier stage";
    const to = typeof after.stageName === "string" ? after.stageName : "a new stage";
    summary = `Moved opportunity ${entityName} from ${from} to ${to}`;
    restores = `Moves ${entityName} back to ${from}.`;
    if (current && (current.values.stageId !== after.stageId || current.values.status !== after.status)) {
      check = `This can't be undone because ${entityName} has moved stage again since.`;
    } else if (current?.archivedAt) {
      check = `This can't be undone while ${entityName} is archived.`;
    }
    const stageId = before.stageId;
    run = () => updateOpportunityInDb(db, actor, event.entity_id, { stageId }, provenance, { wonEffects: false });
  } else if (event.event_type === `${entity}.archived` && before && after && before.archivedAt === null && typeof after.archivedAt === "string") {
    summary = entity === "activity" ? `Deleted ${entityName}` : `Archived ${noun} ${entityName}`;
    restores = entity === "activity" ? `Brings back ${entityName}.` : `Restores ${noun} ${entityName} from the archive.`;
    if (current && !current.archivedAt) check = `This can't be undone because ${entityName} has been restored already.`;
    else if (current && !same(current.archivedAt, iso(after.archivedAt))) check = `This can't be undone because ${entityName} has changed again since.`;
    run = unarchiveRun(db, actor, entity, event.entity_id, provenance, changes);
  } else if (event.event_type === `${entity}.created`) {
    summary = entity === "activity" ? `Logged ${entityName}` : `Created ${noun} ${entityName}`;
    restores = entity === "activity" ? `Deletes ${entityName}.` : `Archives ${noun} ${entityName}.`;
    if (current?.archivedAt) check = `This can't be undone because ${entityName} is already ${entity === "activity" ? "deleted" : "archived"}.`;
    run = archiveRun(db, actor, entity, event.entity_id, provenance);
  } else {
    return refuse(fallback, "Orbit can't undo this kind of change.");
  }

  if (undone) return refuse(summary, "This change has already been undone.");
  if (!current) return refuse(summary, `That ${noun} no longer exists.`);
  if (!hasScope(actor.scopes, SCOPES[entity])) return refuse(summary, `You don't have permission to change this ${noun}.`);
  if (check) return refuse(summary, check);
  return { entityName, summary, plan: { ok: true, restores, run } };
}

async function undoneAmong(db: Db, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  const result = await db.query<{ id: string }>(
    `select changes->>'undoes' as id from crm.audit_events
     where workspace_id = $1 and event_type like '%.undone' and changes->>'undoes' = any($2::text[])`,
    [workspaceId, ids],
  );
  return new Set(result.rows.map((row) => row.id));
}

async function readEvent(db: Db, workspaceId: string, id: string) {
  const result = await db.query<AuditRow>(`${AUDIT_SQL} where e.id = $1 and e.workspace_id = $2`, [id, workspaceId]);
  return result.rows[0] ?? null;
}

async function describeById(db: Db, actor: Actor, id: string, provenance: Provenance) {
  if (!isUuid(id)) throw new CrmError("not_found", "That change wasn't found. Use list_recent_changes to find it.", 404);
  const event = await readEvent(db, actor.workspaceId, id);
  if (!event) throw new CrmError("not_found", "That change wasn't found. Use list_recent_changes to find it.", 404);
  const ids = new Set<string>();
  idsIn(event.changes, ids);
  const names = await namesFor(db, actor.workspaceId, ids);
  const undone = (await undoneAmong(db, actor.workspaceId, [event.id])).has(event.id);
  return { event, described: await describeEvent(db, actor, event, names, undone, provenance) };
}

export async function describeUndo(actor: Actor, auditEventId: string) {
  return withActor(actor, async (db) => {
    const { described } = await describeById(db, actor, auditEventId, { operation: "undo_change" });
    return described.plan.ok
      ? { summary: described.summary, canUndo: true, restores: described.plan.restores }
      : { summary: described.summary, canUndo: false, reason: described.plan.reason };
  });
}

async function lockEntity(db: Db, workspaceId: string, entity: EntityType, id: string) {
  const namespace = LOCKS[entity];
  if (namespace) await lockNamespace(db, workspaceId, namespace);
  await db.query(`select 1 from crm.${TABLES[entity]} where id = $1 and workspace_id = $2 for update`, [id, workspaceId]);
}

export async function undoAuditEvent(actor: Actor, auditEventId: string, provenance: Provenance) {
  return withActor(actor, async (db) => {
    await lockNamespace(db, actor.workspaceId, `undo:${auditEventId}`);
    const target = isUuid(auditEventId) ? await readEvent(db, actor.workspaceId, auditEventId) : null;
    if (target && isEntity(target.entity_type) && isUuid(target.entity_id)) {
      await lockEntity(db, actor.workspaceId, target.entity_type, target.entity_id);
    }
    const { event, described } = await describeById(db, actor, auditEventId, provenance);
    if (!described.plan.ok) throw new CrmError("cannot_undo", described.plan.reason, 409);
    await described.plan.run();
    await recordAudit(db, actor, `${event.entity_type}.undone`, event.entity_type, event.entity_id, provenance, {
      undoes: event.id,
      undoneEventType: event.event_type,
      restored: described.plan.restores,
    });
    return { undone: event.id, entityType: event.entity_type, entityId: event.entity_id, summary: described.summary, restored: described.plan.restores };
  });
}

export async function listRecentChanges(actor: Actor, options: { limit?: number; entityType?: string } = {}): Promise<RecentChange[]> {
  const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20) || 20));
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId, actor.type === "user" ? actor.userId : actor.agentId, AUTOMATIC_SOURCES, ENTITY_TYPES];
    const where = [
      "e.workspace_id = $1",
      actor.type === "user" ? "e.actor_user_id = $2" : "e.actor_agent_id = $2",
      "e.entity_type = any($4::text[])",
      "e.event_type not like '%.undone'",
      "e.event_type not like '%.merged'",
      "not (e.event_type = 'activity.created' and coalesce(e.source, '') = any($3::text[]))",
    ];
    if (options.entityType && isEntity(options.entityType)) {
      values.push(options.entityType);
      where.push(`e.entity_type = $${values.length}`);
    }
    values.push(limit);
    const events = await db.query<AuditRow>(
      `${AUDIT_SQL} where ${where.join(" and ")} order by e.created_at desc, e.id desc limit $${values.length}`,
      values,
    );
    const ids = new Set<string>();
    for (const event of events.rows) idsIn(event.changes, ids);
    const names = await namesFor(db, actor.workspaceId, ids);
    const undone = await undoneAmong(db, actor.workspaceId, events.rows.map((event) => event.id));
    const changes: RecentChange[] = [];
    for (const event of events.rows) {
      const described = await describeEvent(db, actor, event, names, undone.has(event.id), { operation: "undo_change" });
      changes.push({
        id: event.id,
        at: iso(event.created_at),
        type: event.event_type,
        entityType: event.entity_type,
        entityId: event.entity_id,
        entityName: described.entityName,
        summary: described.summary,
        canUndo: described.plan.ok,
        ...(described.plan.ok ? { restores: described.plan.restores } : { reason: described.plan.reason }),
      });
    }
    return changes;
  });
}
