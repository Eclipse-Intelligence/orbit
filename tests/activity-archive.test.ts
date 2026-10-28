import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import {
  archiveActivity,
  createActivity,
  getActivity,
  listActivities,
  listActivitiesByContact,
  listCompanyTimeline,
} from "@/lib/crm/activities";
import { createCompany, getCompany, listCompanies } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { relationshipsFor } from "@/lib/crm/relationship-signals";
import { findStaleRelationships, getCompanyContext } from "@/lib/crm/relationships";
import { scopesForRole } from "@/lib/crm/scopes";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { listRecentChanges, undoAuditEvent } from "@/lib/crm/undo";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

const WEB = { operation: "archive_activity", source: "web" };

function code(expected: string) {
  return (error: unknown) => error instanceof CrmError && error.code === expected;
}

describe("archiving activities", () => {
  let owner: UserActor;
  let colleague: UserActor;
  let agent: AgentActor;
  let acme: string;
  let jane: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("archive@orbit.test", "Mark Ridgeon");
    const admin = getAdminPool();
    const sam = (await admin.query<{ id: string }>("select private.create_local_user('sam@archive.test', 'password-123', 'Sam Taylor') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    colleague = { ...owner, userId: sam, email: "sam@archive.test", fullName: "Sam Taylor", role: "member", scopes: scopesForRole("member") };
    agent = (await createAgent(owner.workspaceId, ["crm:read", "activities:write"])).actor;
    acme = (await createCompany(owner, { name: "Acme Archive", domain: "acme-archive.test" })).body.company.id;
    jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme-archive.test", companyId: acme })).body.contact.id;
  });

  after(async () => {
    await getPool().end();
  });

  it("hides an archived activity from lists, timelines, last interaction and relationship signals", async () => {
    const reply = (
      await createActivity(owner, {
        type: "email",
        title: "Re: pricing",
        body: "Looks good, let's talk Thursday.",
        contactId: jane,
        companyId: acme,
        occurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        metadata: { direction: "inbound", source: "microsoft" },
      })
    ).body.activity;

    assert.equal((await relationshipsFor(owner, "contact", [jane]))[jane].label, "warm");
    assert.equal((await relationshipsFor(owner, "company", [acme]))[acme].label, "warm");
    assert.equal((await getCompany(owner, acme)).lastInteractionAt, reply.occurredAt);
    assert.equal((await listCompanies(owner, { has: ["interactions"] })).data.some((company) => company.id === acme), true);

    const archived = await archiveActivity(owner, reply.id, WEB);
    assert.equal(archived.changed, true);
    assert.ok(archived.archivedAt);

    assert.equal((await listActivities(owner, { companyId: acme })).total, 0);
    assert.equal((await listActivities(owner, { query: "pricing" })).data.length, 0);
    assert.equal((await listCompanyTimeline(owner, acme)).length, 0);
    assert.deepEqual((await listActivitiesByContact(owner, [jane]))[jane], []);
    await assert.rejects(getActivity(owner, reply.id), code("not_found"));

    const company = await getCompany(owner, acme);
    assert.equal(company.lastInteractionAt, null);
    assert.equal((await listCompanies(owner, { has: ["interactions"] })).data.some((item) => item.id === acme), false);
    const context = await getCompanyContext(owner, acme);
    assert.equal(context.lastInteraction, null);
    assert.equal(context.timeline.length, 0);
    assert.equal((await findStaleRelationships(owner, 21)).find((row) => row.company.id === acme)?.lastActivityAt, null);

    const contactRelationship = (await relationshipsFor(owner, "contact", [jane]))[jane];
    assert.equal(contactRelationship.label, "new");
    assert.equal(contactRelationship.reason, "No emails, calls or meetings yet.");
    assert.equal((await relationshipsFor(owner, "company", [acme]))[acme].label, "new");

    const stored = await getAdminPool().query("select archived_at from crm.activities where id = $1", [reply.id]);
    assert.ok(stored.rows[0].archived_at, "the row is kept, not deleted");

    const audit = await getAdminPool().query<{ actor_user_id: string; source: string; changes: { activity: { type: string; title: string } } }>(
      "select actor_user_id, source, changes from crm.audit_events where entity_id = $1 and event_type = 'activity.archived'",
      [reply.id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_user_id, owner.userId);
    assert.equal(audit.rows[0].source, "web");
    assert.deepEqual([audit.rows[0].changes.activity.type, audit.rows[0].changes.activity.title], ["email", "Re: pricing"]);

    const twice = await archiveActivity(owner, reply.id, WEB);
    assert.equal(twice.changed, false);
    assert.equal((await getAdminPool().query("select 1 from crm.audit_events where entity_id = $1 and event_type = 'activity.archived'", [reply.id])).rowCount, 1);
  });

  it("lets only the creator, an owner or an admin archive", async () => {
    const mine = (await createActivity(owner, { type: "note", body: "Owner note", companyId: acme })).body.activity;
    const theirs = (await createActivity(colleague, { type: "note", body: "Sam's note", companyId: acme })).body.activity;

    await assert.rejects(archiveActivity(colleague, mine.id, WEB), (error: unknown) => {
      return error instanceof CrmError && error.status === 403 && /Only the person who logged this activity/.test(error.message);
    });
    assert.equal((await listActivities(owner, { companyId: acme })).data.some((activity) => activity.id === mine.id), true);

    const own = await archiveActivity(colleague, theirs.id, WEB);
    assert.equal(own.changed, true);

    const another = (await createActivity(colleague, { type: "note", body: "Sam's second note", companyId: acme })).body.activity;
    const byOwner = await archiveActivity(owner, another.id, WEB);
    assert.equal(byOwner.changed, true);

    const stranger = await createUser("archive-stranger@orbit.test", "Stranger");
    await assert.rejects(archiveActivity(stranger, mine.id, WEB), code("not_found"));
  });

  it("enforces the same rule in the database, and keeps every other column read-only", async () => {
    const note = (await createActivity(owner, { type: "note", body: "Database check", companyId: acme })).body.activity;
    const blocked = await queryAsUser(colleague.userId, "update crm.activities set archived_at = now() where id = $1 returning id", [note.id]);
    assert.equal(blocked.length, 0);
    await assert.rejects(queryAsUser(owner.userId, "update crm.activities set title = 'Changed' where id = $1", [note.id]), /permission denied/);
    const allowed = await queryAsUser(owner.userId, "update crm.activities set archived_at = now() where id = $1 returning id", [note.id]);
    assert.equal(allowed.length, 1);
  });

  it("lets an agent archive only what it logged", async () => {
    const logged = (await createActivity(agent, { type: "research", title: "Agent research", companyId: acme })).body.activity;
    const human = (await createActivity(owner, { type: "note", body: "Human note", companyId: acme })).body.activity;
    await assert.rejects(archiveActivity(agent, human.id, { operation: "archive_activity", source: "api" }), code("forbidden"));
    const done = await archiveActivity(agent, logged.id, { operation: "archive_activity", source: "api" });
    assert.equal(done.changed, true);
    const reader = (await createAgent(owner.workspaceId, ["crm:read"], "Reader")).actor;
    await assert.rejects(archiveActivity(reader, human.id, { operation: "archive_activity" }));
  });

  it("clears health that came from a deleted call, and puts it back when the delete is undone", async () => {
    const globex = (await createCompany(owner, { name: "Globex Health", domain: "globex-archive.test" })).body.company.id;
    const call = (await createActivity(owner, { type: "call", title: "Renewal call", companyId: globex, occurredAt: "2026-10-21T10:00:00.000Z" })).body.activity;
    await getAdminPool().query(
      "update crm.companies set health = 'at_risk', health_reason = 'They are reviewing other vendors.', health_at = $2, health_activity_id = $3 where id = $1",
      [globex, call.occurredAt, call.id],
    );

    await archiveActivity(owner, call.id, WEB);
    const cleared = await getCompany(owner, globex);
    assert.deepEqual([cleared.health, cleared.healthReason, cleared.healthAt, cleared.healthActivityId], [null, null, null, null]);
    const audit = await getAdminPool().query<{ changes: { fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> }; source: string }>(
      "select changes, source from crm.audit_events where entity_id = $1 and event_type = 'company.updated'",
      [globex],
    );
    assert.equal(audit.rows.length, 1);
    assert.deepEqual(audit.rows[0].changes.fields, ["health", "healthReason"]);
    assert.deepEqual(audit.rows[0].changes.before, { health: "at_risk", healthReason: "They are reviewing other vendors." });
    assert.deepEqual(audit.rows[0].changes.after, { health: null, healthReason: null });
    assert.equal(audit.rows[0].source, "web");

    const deleted = (await listRecentChanges(owner, { entityType: "activity" })).find((item) => item.entityId === call.id && item.type === "activity.archived");
    assert.ok(deleted?.canUndo);
    await undoAuditEvent(owner, deleted.id, { operation: "undo_change", source: "web" });
    const restored = await getCompany(owner, globex);
    assert.deepEqual(
      [restored.health, restored.healthReason, restored.healthAt, restored.healthActivityId],
      ["at_risk", "They are reviewing other vendors.", call.occurredAt, call.id],
    );
  });

  it("archives from the assistant, with the title, type and date on the card", async () => {
    const call = (
      await createActivity(owner, { type: "call", title: "Intro call", contactId: jane, occurredAt: "2026-10-20T13:30:00.000Z" })
    ).body.activity;
    const args = { activityId: call.id };
    const card = describeAction("archive_activity", args, await recordNames(owner, [args], ["archive_activity"]));
    assert.equal(card.title, "Delete activity");
    assert.equal(card.lines[0], "Type: Call");
    assert.equal(card.lines[1], "Title: Intro call");
    assert.match(card.lines[2], /^Date: .*14:30$/);

    const result = (await runTool(owner, "archive_activity", args)) as { activity: { changed: boolean } };
    assert.equal(result.activity.changed, true);
    const listed = (await runTool(owner, "list_activities", { contactId: jane })) as { data: { id: string }[] };
    assert.equal(listed.data.some((activity) => activity.id === call.id), false);
  });
});
