import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { createBoard } from "@/lib/crm/boards";
import { archiveActivity, createActivity, listActivities, updateActivity } from "@/lib/crm/activities";
import { archiveCompany, createCompany, getCompany, unarchiveCompany, updateCompany } from "@/lib/crm/companies";
import { createContact, getContact, updateContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { archiveOpportunity, createOpportunity, getOpportunity, listPipeline, updateOpportunity } from "@/lib/crm/opportunities";
import { setRelationshipOverride } from "@/lib/crm/relationship-override";
import { relationshipsFor } from "@/lib/crm/relationship-signals";
import { scopesForRole } from "@/lib/crm/scopes";
import { addTags } from "@/lib/crm/tags";
import { completeTask, createTask, getTask, listTasks, updateTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { describeUndo, listRecentChanges, undoAuditEvent } from "@/lib/crm/undo";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

const UNDO = { operation: "undo_change", source: "web" };

function refused(pattern: RegExp) {
  return (error: unknown) => error instanceof CrmError && error.code === "cannot_undo" && pattern.test(error.message);
}

async function lockWaiter() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await getAdminPool().query<{ total: number }>(
      "select count(*)::int as total from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if (waiting.rows[0].total > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the undo never waited for the lock");
}

async function latest(actor: UserActor, entityId: string, eventType: string) {
  const changes = await listRecentChanges(actor, { limit: 50 });
  const change = changes.find((item) => item.entityId === entityId && item.type === eventType);
  assert.ok(change, `expected a ${eventType} change`);
  return change;
}

describe("undoing changes", () => {
  let owner: UserActor;
  let colleague: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("undo@orbit.test", "Mark Ridgeon");
    const admin = getAdminPool();
    const sam = (await admin.query<{ id: string }>("select private.create_local_user('sam@undo.test', 'password-123', 'Sam Taylor') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    colleague = { ...owner, userId: sam, email: "sam@undo.test", fullName: "Sam Taylor", role: "member", scopes: scopesForRole("member") };
  });

  after(async () => {
    await getPool().end();
  });

  it("restores company fields, records an undone event and refuses a second undo", async () => {
    const company = (await createCompany(owner, { name: "Pulse", domain: "pulse-undo.test", lifecycle: "lead", industry: "Media" })).body.company;
    await updateCompany(owner, company.id, { lifecycle: "customer", industry: "Software", ownerId: owner.userId }, { provenance: { operation: "update_company", source: "web" } });

    const change = await latest(owner, company.id, "company.updated");
    assert.equal(change.canUndo, true);
    assert.equal(change.entityName, "Pulse");
    assert.match(change.summary, /Lifecycle from Lead to Customer/);
    assert.match(change.summary, /Owner from Unassigned to Mark Ridgeon/);
    assert.match(change.restores ?? "", /Puts back Industry: Media; Lifecycle: Lead; Owner: Unassigned\./);

    const result = await undoAuditEvent(owner, change.id, UNDO);
    assert.equal(result.undone, change.id);
    const restored = await getCompany(owner, company.id);
    assert.deepEqual([restored.lifecycle, restored.industry, restored.ownerId], ["lead", "Media", null]);

    const undone = await getAdminPool().query<{ changes: { undoes: string; undoneEventType: string }; source: string }>(
      "select changes, source from crm.audit_events where entity_id = $1 and event_type = 'company.undone'",
      [company.id],
    );
    assert.equal(undone.rows.length, 1);
    assert.equal(undone.rows[0].changes.undoes, change.id);
    assert.equal(undone.rows[0].changes.undoneEventType, "company.updated");
    assert.equal(undone.rows[0].source, "web");

    const listed = (await listRecentChanges(owner)).find((item) => item.id === change.id);
    assert.equal(listed?.canUndo, false);
    assert.equal(listed?.reason, "This change has already been undone.");
    await assert.rejects(undoAuditEvent(owner, change.id, UNDO), refused(/already been undone/));
  });

  it("refuses when the record has changed again since", async () => {
    const company = (await createCompany(owner, { name: "Drift", domain: "drift-undo.test", industry: "Retail" })).body.company;
    await updateCompany(owner, company.id, { industry: "Fintech" });
    const first = await latest(owner, company.id, "company.updated");
    await updateCompany(owner, company.id, { industry: "Health" });
    await assert.rejects(undoAuditEvent(owner, first.id, UNDO), refused(/changed again since: Industry is now Health/));
    assert.equal((await getCompany(owner, company.id)).industry, "Health");
  });

  it("waits for an edit in progress and refuses rather than overwrite it", async () => {
    const company = (await createCompany(owner, { name: "Racer", domain: "racer-undo.test", industry: "Retail" })).body.company;
    await updateCompany(owner, company.id, { industry: "Fintech" });
    const change = await latest(owner, company.id, "company.updated");

    const editor = await getAdminPool().connect();
    try {
      await editor.query("begin");
      await editor.query("select 1 from crm.companies where id = $1 for update", [company.id]);
      const undo = undoAuditEvent(owner, change.id, UNDO).then(
        () => null,
        (error: unknown) => error,
      );
      await lockWaiter();
      await editor.query("update crm.companies set industry = 'Health' where id = $1", [company.id]);
      await editor.query("commit");
      const error = await undo;
      assert.ok(refused(/changed again since: Industry is now Health/)(error), `expected a refusal, got ${String(error)}`);
    } finally {
      editor.release();
    }
    assert.equal((await getCompany(owner, company.id)).industry, "Health");
  });

  it("undoes tag edits, archiving and unarchiving", async () => {
    const company = (await createCompany(owner, { name: "Tagged", domain: "tagged-undo.test", tags: ["vip"] })).body.company;
    await addTags(owner, "company", [company.id], ["renewal"]);
    const tagged = await latest(owner, company.id, "company.updated");
    assert.match(tagged.summary, /Tags from vip to vip, renewal/);
    await undoAuditEvent(owner, tagged.id, UNDO);
    assert.deepEqual((await getCompany(owner, company.id)).tags, ["vip"]);

    await archiveCompany(owner, company.id);
    const archived = await latest(owner, company.id, "company.archived");
    assert.match(archived.restores ?? "", /Restores company Tagged from the archive/);
    await undoAuditEvent(owner, archived.id, UNDO);
    assert.equal((await getCompany(owner, company.id)).archivedAt, null);

    await archiveCompany(owner, company.id);
    await unarchiveCompany(owner, company.id);
    const changes = await listRecentChanges(owner, { entityType: "company" });
    const unarchived = changes.find((item) => item.entityId === company.id && item.type === "company.updated" && /from the archive/.test(item.summary));
    assert.ok(unarchived?.canUndo);
    await undoAuditEvent(owner, unarchived.id, UNDO);
    assert.ok((await getCompany(owner, company.id)).archivedAt);
  });

  it("undoes a contact edit and a relationship override", async () => {
    const contact = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@undo.test", jobTitle: "CMO" })).body.contact;
    await updateContact(owner, contact.id, { jobTitle: "CEO", phone: "+44 20 7946 0000" });
    const edit = await latest(owner, contact.id, "contact.updated");
    await undoAuditEvent(owner, edit.id, UNDO);
    const restored = await getContact(owner, contact.id);
    assert.deepEqual([restored.jobTitle, restored.phone], ["CMO", null]);

    await setRelationshipOverride(owner, "contact", contact.id, { label: "cold", reason: "Left the company." }, { operation: "set_relationship" });
    const override = await latest(owner, contact.id, "contact.updated");
    assert.match(override.summary, /Relationship from Automatic to Cold/);
    await undoAuditEvent(owner, override.id, UNDO);
    const relationship = (await relationshipsFor(owner, "contact", [contact.id]))[contact.id];
    assert.equal(relationship.override, undefined);
    assert.equal(relationship.label, "new");
  });

  it("moves an opportunity back a stage and restores its value", async () => {
    const company = (await createCompany(owner, { name: "Dealer", domain: "dealer-undo.test" })).body.company;
    const deal = (await createOpportunity(owner, { companyId: company.id, name: "Dealer pilot", value: 1000 })).body.opportunity;
    const pipeline = await listPipeline(owner);
    const next = pipeline.stages.find((stage) => stage.id !== deal.stageId && !stage.isWon && !stage.isLost)!;
    await updateOpportunity(owner, deal.id, { stageId: next.id });
    const moved = await latest(owner, deal.id, "opportunity.stage_changed");
    assert.equal(moved.summary, `Moved opportunity Dealer pilot from ${deal.stageName} to ${next.name}`);
    await undoAuditEvent(owner, moved.id, UNDO);
    assert.equal((await getOpportunity(owner, deal.id)).stageId, deal.stageId);

    await updateOpportunity(owner, deal.id, { value: 2500 });
    const valued = await latest(owner, deal.id, "opportunity.updated");
    assert.match(valued.summary, /Value from 1000\.00 to 2500\.00/);
    await undoAuditEvent(owner, valued.id, UNDO);
    assert.equal((await getOpportunity(owner, deal.id)).value, "1000.00");
  });

  it("moves a deal back to Won without making the company a customer or adding a board card again", async () => {
    const company = (await createCompany(owner, { name: "Winner", domain: "winner-undo.test", lifecycle: "prospect" })).body.company;
    const board = (await runTool(owner, "create_board", { name: "Won accounts", stages: ["Kickoff"], addOnWon: true })) as { board: { id: string } };
    const deal = (await createOpportunity(owner, { companyId: company.id, name: "Winner deal" })).body.opportunity;
    const pipeline = await listPipeline(owner);
    const won = pipeline.stages.find((stage) => stage.isWon)!;
    const cards = async () =>
      (
        await getAdminPool().query<{ id: string }>(
          "select id from crm.opportunities where pipeline_id = $1 and company_id = $2 and archived_at is null",
          [board.board.id, company.id],
        )
      ).rows;

    await updateOpportunity(owner, deal.id, { stageId: won.id });
    assert.equal((await getCompany(owner, company.id)).lifecycle, "customer");
    const [card] = await cards();
    assert.ok(card, "winning adds a board card");

    await updateOpportunity(owner, deal.id, { stageId: deal.stageId });
    await updateCompany(owner, company.id, { lifecycle: "prospect" });
    await archiveOpportunity(owner, card.id);

    const reopened = await latest(owner, deal.id, "opportunity.stage_changed");
    assert.equal(reopened.summary, `Moved opportunity Winner deal from ${won.name} to ${deal.stageName}`);
    await undoAuditEvent(owner, reopened.id, UNDO);
    const restored = await getOpportunity(owner, deal.id);
    assert.deepEqual([restored.stageId, restored.status], [won.id, "won"]);
    assert.equal((await getCompany(owner, company.id)).lifecycle, "prospect");
    assert.deepEqual(await cards(), []);
  });

  it("undoes task edits, completion and creation", async () => {
    const due = "2026-11-20T10:00:00.000Z";
    const task = (await createTask(owner, { title: "Send contract", dueAt: due })).body.task;
    await updateTask(owner, task.id, { title: "Send the signed contract", dueAt: "2026-11-27T10:00:00.000Z" });
    const edit = await latest(owner, task.id, "task.updated");
    await undoAuditEvent(owner, edit.id, UNDO);
    const restored = await getTask(owner, task.id);
    assert.deepEqual([restored.title, restored.dueAt], ["Send contract", due]);

    const done = (await completeTask(owner, task.id)).body.task;
    const completion = await latest(owner, task.id, "task.completed");
    assert.equal(completion.summary, "Marked task Send contract done");
    await undoAuditEvent(owner, completion.id, UNDO);
    assert.equal((await getTask(owner, task.id)).completedAt, null);

    const reopened = await latest(owner, task.id, "task.reopened");
    await undoAuditEvent(owner, reopened.id, UNDO);
    assert.equal((await getTask(owner, task.id)).completedAt, done.completedAt);

    const created = await latest(owner, task.id, "task.created");
    assert.match(created.restores ?? "", /Archives task Send contract/);
    await undoAuditEvent(owner, created.id, UNDO);
    assert.ok((await getTask(owner, task.id)).archivedAt);
    assert.equal((await listTasks(owner, { view: "all" })).data.some((item) => item.id === task.id), false);
  });

  it("doesn't show a private task's title to a colleague who can't see it", async () => {
    const task = (await createTask(owner, { title: "Plan Sam's salary review", ownerId: owner.userId })).body.task;
    await updateTask(owner, task.id, { title: "Plan Sam's salary review for March" });
    const change = await latest(owner, task.id, "task.updated");

    const described = await describeUndo(colleague, change.id);
    assert.deepEqual(described, { summary: "A change to this task", canUndo: false, reason: "You can only undo your own changes." });
    const args = { changeId: change.id };
    const card = describeAction("undo_change", args, await recordNames(colleague, [args], ["undo_change"]));
    assert.doesNotMatch(JSON.stringify(card), /salary/i);
    await assert.rejects(undoAuditEvent(colleague, change.id, UNDO), (error: unknown) => {
      return refused(/only undo your own changes/)(error) && !/salary/i.test((error as Error).message);
    });
  });

  it("says when your own change is on a task you can't see any more", async () => {
    const task = (await createTask(owner, { title: "Prepare the board pack", ownerId: colleague.userId })).body.task;
    await updateTask(colleague, task.id, { title: "Prepare the Q4 board pack" });
    const change = await latest(colleague, task.id, "task.updated");
    assert.equal(change.canUndo, true);

    await updateTask(owner, task.id, { ownerId: owner.userId });
    const hidden = (await listRecentChanges(colleague)).find((item) => item.id === change.id);
    assert.deepEqual(
      [hidden?.entityName, hidden?.summary, hidden?.canUndo, hidden?.reason],
      ["this task", "A change to this task", false, "You can't see that task any more."],
    );
    await assert.rejects(undoAuditEvent(colleague, change.id, UNDO), refused(/^You can't see that task any more\.$/));
    assert.equal((await getTask(owner, task.id)).title, "Prepare the Q4 board pack");
  });

  it("brings back a deleted activity and deletes a logged one", async () => {
    const company = (await createCompany(owner, { name: "Noted", domain: "noted-undo.test" })).body.company;
    const note = (await createActivity(owner, { type: "note", title: "Kick-off notes", body: "Agreed scope.", companyId: company.id })).body.activity;
    await archiveActivity(owner, note.id, { operation: "archive_activity", source: "web" });
    const deleted = await latest(owner, note.id, "activity.archived");
    assert.match(deleted.summary, /^Deleted Note "Kick-off notes" on /);
    await undoAuditEvent(owner, deleted.id, UNDO);
    assert.equal((await listActivities(owner, { companyId: company.id })).data.some((item) => item.id === note.id), true);
    const restoredEvents = await getAdminPool().query<{ changes: { fields: string[]; before: { archivedAt: string }; after: { archivedAt: null } }; source: string }>(
      "select changes, source from crm.audit_events where entity_id = $1 and event_type = 'activity.updated'",
      [note.id],
    );
    assert.equal(restoredEvents.rows.length, 1);
    assert.deepEqual(restoredEvents.rows[0].changes.fields, ["archivedAt"]);
    assert.ok(restoredEvents.rows[0].changes.before.archivedAt);
    assert.equal(restoredEvents.rows[0].changes.after.archivedAt, null);
    assert.equal(restoredEvents.rows[0].source, "web");
    const broughtBack = await latest(owner, note.id, "activity.updated");
    assert.match(broughtBack.summary, /^Brought back Note "Kick-off notes" on /);
    assert.equal(broughtBack.canUndo, true);

    const logged = await latest(owner, note.id, "activity.created");
    await undoAuditEvent(owner, logged.id, UNDO);
    assert.equal((await listActivities(owner, { companyId: company.id })).total, 0);
  });

  it("undoes an activity edit, and refuses once it has changed again or been deleted", async () => {
    const company = (await createCompany(owner, { name: "Edited", domain: "edited-undo.test" })).body.company;
    const other = (await createCompany(owner, { name: "Elsewhere", domain: "elsewhere-undo.test" })).body.company;
    const note = (await createActivity(owner, { type: "note", title: "Kick-off", body: "Agreed scope.", companyId: company.id, occurredAt: "2026-10-20T09:00:00.000Z" })).body.activity;
    await updateActivity(owner, note.id, { title: "Kick-off notes", body: "Agreed scope and dates.", companyId: other.id }, { operation: "update_activity", source: "web" });

    const change = await latest(owner, note.id, "activity.updated");
    assert.equal(change.canUndo, true);
    assert.match(change.summary, /^Edited Note "Kick-off notes" on .*: Title from Kick-off to Kick-off notes; Text from Agreed scope\. to Agreed scope and dates\.; Company from Edited to Elsewhere$/);
    assert.equal(change.restores, "Puts back Title: Kick-off; Text: Agreed scope.; Company: Edited.");
    const described = await describeUndo(owner, change.id);
    assert.equal(described.canUndo, true);

    await undoAuditEvent(owner, change.id, UNDO);
    const restored = (await listActivities(owner, { companyId: company.id })).data.find((item) => item.id === note.id);
    assert.deepEqual([restored?.title, restored?.body, restored?.companyId], ["Kick-off", "Agreed scope.", company.id]);
    const undone = await getAdminPool().query<{ changes: { undoes: string; undoneEventType: string } }>(
      "select changes from crm.audit_events where entity_id = $1 and event_type = 'activity.undone'",
      [note.id],
    );
    assert.deepEqual([undone.rows[0].changes.undoes, undone.rows[0].changes.undoneEventType], [change.id, "activity.updated"]);
    await assert.rejects(undoAuditEvent(owner, change.id, UNDO), refused(/already been undone/));

    await updateActivity(owner, note.id, { title: "First rename" }, { operation: "update_activity", source: "web" });
    const first = await latest(owner, note.id, "activity.updated");
    await updateActivity(owner, note.id, { title: "Second rename" }, { operation: "update_activity", source: "web" });
    await assert.rejects(undoAuditEvent(owner, first.id, UNDO), refused(/changed again since: Title is now Second rename/));

    const timed = await latest(owner, note.id, "activity.updated");
    await archiveActivity(owner, note.id, { operation: "archive_activity", source: "web" });
    await assert.rejects(undoAuditEvent(owner, timed.id, UNDO), refused(/can't be undone while Note "Second rename" on .* is deleted/));
  });

  it("waits for an activity edit in progress and refuses rather than overwrite it", async () => {
    const company = (await createCompany(owner, { name: "Racing note", domain: "racing-note-undo.test" })).body.company;
    const note = (await createActivity(owner, { type: "note", title: "Draft", body: "Notes", companyId: company.id })).body.activity;
    await updateActivity(owner, note.id, { title: "Draft two" }, { operation: "update_activity", source: "web" });
    const change = await latest(owner, note.id, "activity.updated");

    const editor = await getAdminPool().connect();
    try {
      await editor.query("begin");
      await editor.query("select 1 from crm.activities where id = $1 for update", [note.id]);
      const undo = undoAuditEvent(owner, change.id, UNDO).then(
        () => null,
        (error: unknown) => error,
      );
      await lockWaiter();
      await editor.query("update crm.activities set title = 'Draft three' where id = $1", [note.id]);
      await editor.query("commit");
      const error = await undo;
      assert.ok(refused(/changed again since: Title is now Draft three/)(error), `expected a refusal, got ${String(error)}`);
    } finally {
      editor.release();
    }
    assert.equal((await listActivities(owner, { companyId: company.id })).data[0].title, "Draft three");
  });

  it("refuses changes it can't safely reverse, and other people's changes", async () => {
    const admin = getAdminPool();
    const board = await createBoard(owner, { name: "Onboarding" });
    assert.equal((await listRecentChanges(owner, { limit: 50 })).some((item) => item.entityId === board.id), false);
    const boardEvent = await admin.query<{ id: string }>("select id from crm.audit_events where entity_id = $1 and event_type = 'board.created'", [board.id]);
    const boardDescribed = await describeUndo(owner, boardEvent.rows[0].id);
    assert.equal(boardDescribed.canUndo, false);
    assert.equal(boardDescribed.reason, "Orbit can't undo this kind of change.");
    await assert.rejects(undoAuditEvent(owner, boardEvent.rows[0].id, UNDO), refused(/can't undo this kind/));

    const company = (await createCompany(owner, { name: "Shared", domain: "shared-undo.test" })).body.company;
    await updateCompany(owner, company.id, { industry: "Travel" });
    const mine = await latest(owner, company.id, "company.updated");
    await assert.rejects(undoAuditEvent(colleague, mine.id, UNDO), refused(/only undo your own changes/));
    assert.equal((await listRecentChanges(colleague)).some((item) => item.id === mine.id), false);

    const odd = await admin.query<{ id: string }>(
      `insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, operation, changes)
       values ($1, 'company.updated', 'company', $2, 'user', $3, 'update_company', '{"fields": ["normalizedName"], "before": {"normalizedName": "x"}, "after": {"normalizedName": "y"}}')
       returning id`,
      [owner.workspaceId, company.id, owner.userId],
    );
    await assert.rejects(undoAuditEvent(owner, odd.rows[0].id, UNDO), refused(/isn't in a shape Orbit can safely reverse/));
    await assert.rejects(undoAuditEvent(owner, "not-an-id", UNDO), (error: unknown) => error instanceof CrmError && error.code === "not_found");

    const stranger = await createUser("undo-stranger@orbit.test", "Stranger");
    await assert.rejects(undoAuditEvent(stranger, mine.id, UNDO), (error: unknown) => error instanceof CrmError && error.code === "not_found");
  });

  it("lists changes and undoes them from the assistant, with what will be restored on the card", async () => {
    const company = (await createCompany(owner, { name: "Assisted", domain: "assisted-undo.test", lifecycle: "prospect" })).body.company;
    await updateCompany(owner, company.id, { lifecycle: "churned" });
    const listed = (await runTool(owner, "list_recent_changes", { entityType: "company", limit: 5 })) as { changes: { id: string; canUndo: boolean; summary: string }[] };
    const change = listed.changes[0];
    assert.equal(change.canUndo, true);
    assert.equal(change.summary, "Changed company Assisted: Lifecycle from Prospect to Churned");

    const args = { changeId: change.id };
    const card = describeAction("undo_change", args, await recordNames(owner, [args], ["undo_change"]));
    assert.deepEqual(card, {
      title: "Undo change",
      lines: ["Changed company Assisted: Lifecycle from Prospect to Churned", "Puts back Lifecycle: Prospect."],
    });

    const result = (await runTool(owner, "undo_change", args)) as { restored: string };
    assert.equal(result.restored, "Puts back Lifecycle: Prospect.");
    assert.equal((await getCompany(owner, company.id)).lifecycle, "prospect");

    const again = describeAction("undo_change", args, await recordNames(owner, [args], ["undo_change"]));
    assert.equal(again.lines[1], "Can't be undone: This change has already been undone.");
    const refusal = (await runTool(owner, "undo_change", args)) as { error: string };
    assert.equal(refusal.error, "This change has already been undone.");
  });
});
