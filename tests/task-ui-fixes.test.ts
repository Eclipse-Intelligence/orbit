import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { createOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { snoozeTask } from "@/lib/crm/action-needed";
import { relinkTask } from "@/lib/crm/task-act";
import { createTask, updateTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { reconcileDone } from "@/lib/task-done";
import { dayOnlyHint, dayOnlyNote, movedMessage, ownerSetsTime, relinkChange, relinkNote } from "@/lib/task-pad";
import { createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let sam: UserActor;
let acme: string;
let beta: string;
let jane: string;
let bob: string;
let renewal: string;

const web = { operation: "link_task", source: "web" } as const;

describe("task UI fixes", () => {
  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@ui-fixes.test", "Mark Ridgeon");
    const samUser = await createUser("sam@ui-fixes.test", "Sam Okafor");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, samUser.userId]);
    sam = { ...samUser, workspaceId: mark.workspaceId, role: "member", scopes: scopesForRole("member") };
    acme = (await createCompany(mark, { name: "Acme", domain: "acme-ui.test" })).body.company.id;
    beta = (await createCompany(mark, { name: "Beta", domain: "beta-ui.test" })).body.company.id;
    jane = (await createContact(mark, { companyId: acme, firstName: "Jane", lastName: "Doe", email: "jane@acme-ui.test" })).body.contact.id;
    bob = (await createContact(mark, { companyId: beta, firstName: "Bob", lastName: "Ray", email: "bob@beta-ui.test" })).body.contact.id;
    renewal = (await createOpportunity(mark, { companyId: acme, name: "Acme renewal" })).body.opportunity.id;
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("changes a task's company from Edit links by dropping the person and opportunity that don't fit", async () => {
    const task = (await createTask(mark, { title: "Check in", contactId: jane, opportunityId: renewal })).body.task;
    await assert.rejects(() => relinkTask(mark, task.id, { companyId: beta }, web), /different company/);
    assert.deepEqual(relinkChange(task, "company", null), { companyId: null }, "Don't link on Company leaves the person and opportunity");
    const change = relinkChange(task, "company", { id: beta });
    assert.deepEqual(change, { companyId: beta, opportunityId: null, contactId: null });
    assert.equal(relinkNote(task, "company", change), "Removed Jane Doe and Acme renewal, linked to another company.");
    const moved = await relinkTask(mark, task.id, change, web);
    assert.deepEqual([moved.companyId, moved.contactId, moved.opportunityId], [beta, null, null]);

    const again = (await createTask(mark, { title: "Check in again", contactId: jane, opportunityId: renewal })).body.task;
    const person = await relinkTask(mark, again.id, relinkChange(again, "contact", { id: bob, company: { id: beta, name: "Beta" } }), web);
    assert.deepEqual([person.companyId, person.contactId, person.opportunityId], [beta, bob, null]);
    const back = await relinkTask(mark, again.id, relinkChange(person, "opportunity", { id: renewal, company: { id: acme, name: "Acme" } }), web);
    assert.deepEqual([back.companyId, back.contactId, back.opportunityId], [acme, null, renewal]);

    const loner = (await createContact(mark, { firstName: "Lena", lastName: "Fox", email: "lena@fox-ui.test" })).body.contact.id;
    const free = (await createTask(mark, { title: "Ring Lena", contactId: loner, companyId: acme, opportunityId: renewal })).body.task;
    assert.equal(free.contactCompanyId, null);
    const kept = relinkChange(free, "company", { id: beta });
    assert.deepEqual(kept, { companyId: beta, opportunityId: null }, "a person with no company stays");
    assert.equal(relinkNote(free, "company", kept), "Removed Acme renewal, linked to another company.");
    const keptPerson = await relinkTask(mark, free.id, kept, web);
    assert.deepEqual([keptPerson.companyId, keptPerson.contactId, keptPerson.opportunityId], [beta, loner, null]);
    assert.equal(relinkNote(keptPerson, "opportunity", relinkChange(keptPerson, "opportunity", { id: renewal, company: { id: acme, name: "Acme" } })), null);

    const lone = (await createTask(mark, { title: "Ring Acme", companyId: acme })).body.task;
    assert.deepEqual(relinkChange(lone, "company", { id: acme }), { companyId: acme });
    assert.deepEqual(relinkChange(lone, "company", null), { companyId: null });
  });

  it("shows what was saved when a time on a teammate's task is kept as the day only", async () => {
    assert.equal(ownerSetsTime(mark.userId, sam.userId), true);
    assert.equal(ownerSetsTime(mark.userId, mark.userId), false);
    assert.equal(ownerSetsTime(mark.userId, null), false);
    assert.equal(dayOnlyNote("Sam Okafor"), "Saved the day only. Only Sam can set a time.");
    assert.equal(dayOnlyHint("Sam Okafor"), "Only Sam can set a time, so this saves the day only.");
    assert.equal(dayOnlyNote(null), "Saved the day only. Only the assignee can set a time.");

    const task = (await createTask(mark, { title: "Send Sam the deck", ownerId: sam.userId, dueDate: "2026-11-20" })).body.task;
    const saved = (await updateTask(mark, task.id, { dueAt: "2026-11-20T09:00:00Z", remindMinutes: 15 })).body.task;
    assert.deepEqual([saved.dueHasTime, saved.remindMinutes, saved.dueDate], [false, null, "2026-11-20"]);

    const timed = (await updateTask(sam, task.id, { dueAt: "2026-11-20T09:00:00Z" })).body.task;
    assert.equal(timed.dueHasTime, true);
    const now = new Date("2026-11-16T10:00:00Z").getTime();
    const moved = (await snoozeTask(mark, task.id, "2026-11-23T09:00:00Z", now)).body.task;
    assert.equal(moved.dueHasTime, false);
    assert.equal(movedMessage(timed, "2026-11-23T09:00:00Z", { dueAt: moved.dueAt, dueHasTime: moved.dueHasTime }, now), "Due Mon 23 Nov. Only Sam can set a time.");
    assert.equal(movedMessage({ dueHasTime: true, ownerName: "Mark" }, "2026-11-23T09:00:00Z", { dueAt: "2026-11-23T09:00:00.000Z", dueHasTime: true }, now), "Due Mon 23 Nov, 09:00.");
  });

  it("shows a done task again once fresh data says it was reopened", () => {
    const none = () => new Set<string>();
    const marked = { done: new Set(["a", "b", "c"]), awaiting: new Set(["a"]), confirmed: none(), sent: new Set(["c"]) };
    const settled = reconcileDone(new Set(["b", "d"]), marked);
    assert.deepEqual([[...settled.done], [...settled.awaiting], [...settled.confirmed].sort(), [...settled.sent]], [["a", "b", "c"], [], ["a", "c"], []]);
    const viewSwitch = reconcileDone(new Set(["d"]), settled);
    assert.ok(!viewSwitch.confirmed.has("b"), "a task in its Undo window that leaves the list isn't counted as done on the server");
    const back = reconcileDone(new Set(["b", "d"]), viewSwitch);
    assert.ok(back.done.has("b"), "so it stays hidden when the view comes back");
    const reopened = reconcileDone(new Set(["a", "b", "c", "d"]), settled);
    assert.deepEqual([...reopened.done], ["b"], "tasks reopened elsewhere show again, one still in its Undo window stays hidden");
    assert.deepEqual([...reopened.confirmed], []);
    const pending = reconcileDone(new Set(["e"]), { done: new Set(["e"]), awaiting: none(), confirmed: none(), sent: new Set(["e"]) });
    assert.deepEqual([[...pending.done], [...pending.sent], [...pending.confirmed]], [["e"], ["e"], []], "a completion still on its way keeps the task hidden");
    const failed = reconcileDone(new Set(["a"]), { done: new Set(["a"]), awaiting: new Set(["a"]), confirmed: none(), sent: none() });
    assert.deepEqual([...failed.done], []);
  });
});
