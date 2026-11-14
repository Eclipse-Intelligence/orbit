import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { dateKey, shiftDateKey } from "@/lib/calendar-view";
import { dayStartIso, wallInstant } from "@/lib/crm/task-time";
import { addTaskParticipants, completeTask, createTask, getTask, listDueReminders, placeTask } from "@/lib/crm/tasks";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Task, UserActor } from "@/lib/crm/types";
import { actorForTask, createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  edgeScrollSpeed,
  moveInstant,
  placedTask,
  placementFor,
  placementLanded,
  pointerInstant,
  resizedDuration,
  resizeLimits,
  samePlace,
  slotDateLabel,
  slotInstant,
  slotRange,
  snapStart,
} from "@/lib/task-drag";
import { createUser, resetDatabase } from "./helpers";

delete process.env.TYPESAFE_API_KEY;
delete process.env.LLM_API_KEY;

const MINUTE = 60_000;

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

function task(overrides: Partial<Task>): Task {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "ws",
    title: "Call Jane Cooper",
    description: null,
    dueAt: null,
    dueDate: null,
    dueHasTime: false,
    durationMinutes: 15,
    scheduledBy: null,
    remindMinutes: null,
    completedAt: null,
    priority: "normal",
    ownerId: null,
    ownerName: null,
    companyId: null,
    companyName: null,
    companyPhone: null,
    contactId: null,
    contactCompanyId: null,
    contactName: null,
    contactFirstName: null,
    contactLastName: null,
    contactJobTitle: null,
    contactPhone: null,
    contactEmail: null,
    opportunityId: null,
    opportunityName: null,
    createdByUserId: null,
    createdByAgentId: null,
    archivedAt: null,
    clickupTaskId: null,
    clickupListId: null,
    clickupUrl: null,
    clickupError: null,
    inOutlook: false,
    mailThreadKey: null,
    mailThread: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const plus = (iso: string, minutes: number) => new Date(iso).getTime() + minutes * MINUTE;

describe("dragging on the grid", () => {
  it("snaps a start to 15 minutes and keeps the block inside its day", () => {
    assert.equal(snapStart(13 * 60 + 37, 15), 13 * 60 + 30);
    assert.equal(snapStart(13 * 60 + 38, 15), 13 * 60 + 45);
    assert.equal(snapStart(-20, 15), 0);
    assert.equal(snapStart(23 * 60 + 55, 30), 23 * 60 + 30);
    assert.equal(snapStart(23 * 60 + 55, 5), 23 * 60 + 45);
  });

  it("resizes in 15 minute steps between 15 minutes and 8 hours, from the block's own start", () => {
    const start = "2026-11-13T13:15:00.000Z";
    assert.equal(resizedDuration(start, plus(start, 29), 15), 30);
    assert.equal(resizedDuration(start, plus(start, 1), 15), 15);
    assert.equal(resizedDuration(start, plus(start, -60), 15), 15);
    assert.equal(resizedDuration("2026-11-13T09:00:00.000Z", plus("2026-11-13T09:00:00.000Z", 660), 15), 480);
    const seconds = "2026-11-13T13:15:42.000Z";
    assert.equal(resizedDuration(seconds, plus(seconds, 44), 15), 45);
  });

  it("never resizes past midnight, and never collapses a block that already crosses it", () => {
    assert.equal(resizedDuration("2026-11-13T23:00:00.000Z", plus("2026-11-13T23:00:00.000Z", 120), 15), 60);
    assert.deepEqual(resizeLimits("2026-11-13T23:50:00.000Z", 5), { least: 10, most: 10 });
    assert.equal(resizedDuration("2026-11-13T23:50:00.000Z", plus("2026-11-13T23:50:00.000Z", 60), 5), 10);
    assert.deepEqual(resizeLimits("2026-11-13T23:50:00.000Z", 15), { least: 15, most: 15 });
    assert.equal(resizedDuration("2026-11-13T23:00:00.000Z", plus("2026-11-13T23:00:00.000Z", 120), 120), 120);
    assert.equal(resizedDuration("2026-11-13T23:00:00.000Z", plus("2026-11-13T23:00:00.000Z", 30), 120), 30);
  });

  it("measures a resize in real minutes on the day the clocks go forward", () => {
    const start = new Date(wallInstant("2026-03-29", 0, 30)).toISOString();
    assert.equal(start, "2026-03-29T00:30:00.000Z");
    assert.equal(pointerInstant("2026-03-29", 2 * 60 + 30), Date.parse("2026-03-29T01:30:00.000Z"));
    assert.equal(resizedDuration(start, pointerInstant("2026-03-29", 2 * 60 + 30), 15), 60);
    assert.equal(slotRange({ minutes: 30, durationMinutes: 60, at: start }), "00:30 to 02:30");
  });

  it("keeps the repeated 01:30 on the day the clocks go back", () => {
    const second = "2026-10-25T01:30:00.000Z";
    assert.equal(resizedDuration(second, pointerInstant("2026-10-25", 2 * 60), 15), 30);
    assert.deepEqual(placementFor({ day: "2026-10-25", minutes: 90, durationMinutes: 30, at: second }), { at: second, durationMinutes: 30 });
    assert.equal(slotRange({ minutes: 90, durationMinutes: 30, at: second }), "01:30 to 02:00");
    assert.equal(samePlace(task({ dueAt: second, dueHasTime: true, durationMinutes: 30 }), { day: "2026-10-25", minutes: 90, durationMinutes: 30, at: second }), true);
  });

  it("moves on clock-change days to the instant the label shows, and keeps a block's own instant on its own slot", () => {
    const second = "2026-10-25T01:30:00.000Z";
    assert.equal(moveInstant(second, "2026-10-25", 90), second);
    assert.equal(moveInstant("2026-10-25T00:30:00.000Z", "2026-10-25", 90), "2026-10-25T00:30:00.000Z");
    assert.equal(moveInstant(null, "2026-10-25", 90), "2026-10-25T00:30:00.000Z");
    const gap = moveInstant(null, "2027-03-28", 60);
    assert.equal(gap, "2027-03-28T01:00:00.000Z");
    assert.equal(slotRange({ minutes: 60, durationMinutes: 45, at: gap }), "02:00 to 02:45");
    assert.deepEqual(placementFor({ day: "2027-03-28", minutes: 60, durationMinutes: 45, at: gap }), { at: gap, durationMinutes: 45 });
  });

  it("turns a slot into London wall time, in summer and winter", () => {
    assert.equal(slotInstant("2026-07-14", 13 * 60 + 30), "2026-07-14T12:30:00.000Z");
    assert.equal(slotInstant("2026-11-13", 13 * 60 + 30), "2026-11-13T13:30:00.000Z");
    assert.deepEqual(placementFor({ day: "2026-11-13", minutes: 9 * 60, durationMinutes: 30 }), { at: "2026-11-13T09:00:00.000Z", durationMinutes: 30 });
    assert.equal(slotRange({ minutes: 13 * 60 + 15, durationMinutes: 30 }), "13:15 to 13:45");
    assert.equal(slotDateLabel("2026-11-13"), "Fri 13 Nov");
    assert.equal(pointerInstant("2026-11-13", 24 * 60), Date.parse("2026-11-14T00:00:00.000Z"));
  });

  it("knows when a drop lands where the block already is", () => {
    const placed = task({ dueAt: "2026-11-13T13:30:00.000Z", dueHasTime: true, durationMinutes: 15 });
    assert.equal(samePlace(placed, { day: "2026-11-13", minutes: 13 * 60 + 30, durationMinutes: 15 }), true);
    assert.equal(samePlace(placed, { day: "2026-11-13", minutes: 13 * 60 + 30, durationMinutes: 30 }), false);
    assert.equal(samePlace(task({ dueAt: dayStartIso("2026-11-13") }), { day: "2026-11-13", minutes: 0, durationMinutes: 15 }), false);
  });

  it("shows a drop at once, making it timed and the dragger's, or date only on the same day", () => {
    const listed = task({ dueAt: dayStartIso("2026-11-13"), dueDate: "2026-11-13", durationMinutes: 45 });
    const timed = placedTask(listed, { at: "2026-11-16T10:00:00.000Z", durationMinutes: 45 }, "mark");
    assert.equal(timed.dueHasTime, true);
    assert.equal(timed.dueDate, "2026-11-16");
    assert.equal(timed.scheduledBy, "person");
    assert.equal(timed.ownerId, "mark");
    assert.equal(placedTask({ ...listed, ownerId: "sam" }, { at: "2026-11-16T10:00:00.000Z", durationMinutes: 45 }, "mark").ownerId, "sam");
    const back = placedTask(task({ dueAt: "2026-07-14T22:30:00.000Z", dueHasTime: true, scheduledBy: "planner", remindMinutes: 10 }), { dateOnly: true }, "mark");
    assert.equal(back.dueDate, "2026-07-14");
    assert.equal(back.dueAt, dayStartIso("2026-07-14"));
    assert.equal(back.dueHasTime, false);
    assert.equal(back.scheduledBy, null);
    assert.equal(back.remindMinutes, null);
    assert.equal(placementLanded({ ...timed, dueAt: "2026-11-16T10:00:00Z" }, timed), true);
    assert.equal(placementLanded(listed, timed), false);
    assert.equal(placementLanded({ ...timed, durationMinutes: 15 }, timed), false);
  });

  it("scrolls faster the closer the pointer is to an edge", () => {
    assert.equal(edgeScrollSpeed(500, 100, 900), 0);
    assert.ok(edgeScrollSpeed(105, 100, 900) < edgeScrollSpeed(140, 100, 900));
    assert.ok(edgeScrollSpeed(140, 100, 900) < 0);
    assert.ok(edgeScrollSpeed(895, 100, 900) > edgeScrollSpeed(860, 100, 900));
    assert.ok(edgeScrollSpeed(860, 100, 900) > 0);
    assert.equal(edgeScrollSpeed(910, 100, 900), 18);
    assert.equal(edgeScrollSpeed(120, 100, 200), 0);
  });
});

describe("placing a task by dragging", () => {
  let mark: UserActor;
  let personal: UserActor;
  let sam: UserActor;
  const today = dateKey(Date.now());
  const day = (offset: number) => shiftDateKey(today, offset);
  const at = (offset: number, hour: number, minute = 0) => new Date(wallInstant(day(offset), hour, minute)).toISOString();
  const failure = async (work: () => Promise<unknown>) => {
    try {
      await work();
      return "";
    } catch (error) {
      const known = error as { code?: string; status?: number };
      return `${known.code}|${known.status}`;
    }
  };
  const audits = async (id: string) =>
    (
      await getAdminPool().query<{ operation: string; source: string; workspace_id: string; changes: { fields?: string[] } }>(
        "select operation, source, workspace_id, changes from crm.audit_events where entity_id = $1 and event_type = 'task.updated' order by created_at",
        [id],
      )
    ).rows;

  before(async () => {
    await resetDatabase();
    mark = { ...(await createUser("mark@drag.test", "Mark Ridgeon")), workspaceName: "Eclipse" };
    const created = await createWorkspace(mark, { name: "Mark Ridgeon" });
    personal = { ...mark, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    const samId = (await getAdminPool().query<{ id: string }>("select private.create_local_user('sam@drag.test', 'password-123', 'Sam Okafor') as id")).rows[0].id;
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, samId]);
    sam = { ...mark, userId: samId, email: "sam@drag.test", fullName: "Sam Okafor", role: "member", scopes: scopesForRole("member") };
  });

  it("puts a date-only task on the grid with its time and duration, placed by the person, and audits it as a drag", async () => {
    const listed = (await createTask(mark, { title: "Call Jane Cooper", dueDate: day(2), durationMinutes: 45 })).body.task;
    const { task: placed, changed } = await placeTask(mark, listed.id, { at: at(3, 13, 30), durationMinutes: 45 });
    assert.equal(changed, true);
    assert.equal(placed.dueAt, at(3, 13, 30));
    assert.equal(placed.dueHasTime, true);
    assert.equal(placed.dueDate, day(3));
    assert.equal(placed.durationMinutes, 45);
    assert.equal(placed.scheduledBy, "person");
    const recorded = await audits(listed.id);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].operation, "drag_task");
    assert.equal(recorded[0].source, "web");
    assert.ok(!recorded[0].changes.fields?.includes("durationMinutes"));
  });

  it("records nothing when a drop changes nothing", async () => {
    const block = (await createTask(mark, { title: "Still here", dueAt: at(2, 9), durationMinutes: 30 })).body.task;
    assert.equal(block.scheduledBy, "person");
    const result = await placeTask(mark, block.id, { at: at(2, 9), durationMinutes: 30 });
    assert.equal(result.changed, false);
    assert.equal((await audits(block.id)).length, 0);
    assert.equal((await getTask(mark, block.id)).updatedAt, block.updatedAt);
    const dated = (await createTask(mark, { title: "Dated", dueDate: day(2) })).body.task;
    assert.equal((await placeTask(mark, dated.id, { dateOnly: true })).changed, false);
    assert.equal((await audits(dated.id)).length, 0);
    const resized = await placeTask(mark, block.id, { at: at(2, 9), durationMinutes: 45 });
    assert.equal(resized.changed, true);
    assert.deepEqual((await audits(block.id))[0].changes.fields, ["durationMinutes"]);
  });

  it("makes an unassigned task the dragger's", async () => {
    const unassigned = (await createTask(mark, { title: "Unassigned call", ownerId: null })).body.task;
    assert.equal(unassigned.ownerId, null);
    const { task: placed } = await placeTask(mark, unassigned.id, { at: at(1, 9), durationMinutes: 15 });
    assert.equal(placed.ownerId, mark.userId);
    assert.equal(placed.dueHasTime, true);
  });

  it("keeps a task someone else owns with them", async () => {
    const forSam = (await createTask(mark, { title: "Sam's follow-up", ownerId: sam.userId, dueDate: day(1) })).body.task;
    const { task: placed } = await placeTask(mark, forSam.id, { at: at(1, 11), durationMinutes: 15 });
    assert.equal(placed.ownerId, sam.userId);
  });

  it("claims a block Plan placed when it is only resized, and moves its reminder with it", async () => {
    const planned = (await createTask(mark, { title: "Email Halden", dueAt: at(2, 13, 15), scheduledBy: "planner", remindMinutes: 10 })).body.task;
    assert.equal(planned.scheduledBy, "planner");
    const { task: resized } = await placeTask(mark, planned.id, { at: at(2, 13, 15), durationMinutes: 30 });
    assert.equal(resized.durationMinutes, 30);
    assert.equal(resized.scheduledBy, "person");
    assert.equal(resized.dueAt, at(2, 13, 15));
    assert.equal(resized.remindMinutes, 10);
    const soon = new Date(Date.now() + 15 * MINUTE);
    soon.setUTCSeconds(0, 0);
    const { task: moved } = await placeTask(mark, planned.id, { at: soon.toISOString(), durationMinutes: 30 });
    assert.equal(moved.remindMinutes, 10);
    const reminder = (await listDueReminders(mark)).find((item) => item.id === planned.id);
    assert.ok(reminder, "the reminder follows the block");
    assert.equal(new Date(reminder.dueAt).getTime(), soon.getTime());
  });

  it("times a date-only task dropped at midnight on its own day", async () => {
    const listed = (await createTask(mark, { title: "Night call", dueDate: day(4) })).body.task;
    const { task: placed } = await placeTask(mark, listed.id, { at: at(4, 0), durationMinutes: 15 });
    assert.equal(placed.dueHasTime, true);
    assert.equal(placed.scheduledBy, "person");
    assert.equal(placed.dueAt, dayStartIso(day(4)));
  });

  it("makes a block date only again on the same day when it goes back on the list", async () => {
    const block = (await createTask(mark, { title: "Late email", dueAt: at(5, 23, 30), remindMinutes: 15 })).body.task;
    const { task: back } = await placeTask(mark, block.id, { dateOnly: true });
    assert.equal(back.dueHasTime, false);
    assert.equal(back.dueDate, day(5));
    assert.equal(back.dueAt, dayStartIso(day(5)));
    assert.equal(back.scheduledBy, null);
    assert.equal(back.remindMinutes, null);
    const undated = (await createTask(mark, { title: "No date" })).body.task;
    assert.match(await failure(() => placeTask(mark, undated.id, { dateOnly: true })), /^invalid_input\|400/);
  });

  it("refuses a done task", async () => {
    const done = (await createTask(mark, { title: "Already done", dueAt: at(1, 10) })).body.task;
    await completeTask(mark, done.id);
    assert.match(await failure(() => placeTask(mark, done.id, { at: at(1, 12), durationMinutes: 15 })), /^invalid_input\|400/);
    assert.match(await failure(() => placeTask(mark, done.id, { dateOnly: true })), /^invalid_input\|400/);
    const after = await getTask(mark, done.id);
    assert.equal(after.dueAt, at(1, 10));
    assert.equal(after.dueHasTime, true);
  });

  it("refuses a drop with no time or a bad duration, someone who can't see the task, and someone only tagged on it", async () => {
    const block = (await createTask(mark, { title: "Mark's block", dueAt: at(1, 15) })).body.task;
    assert.match(await failure(() => placeTask(mark, block.id, { at: day(1), durationMinutes: 15 })), /^invalid_input\|400/);
    assert.match(await failure(() => placeTask(mark, block.id, { at: at(1, 15), durationMinutes: 2 })), /^invalid_input\|400/);
    assert.match(await failure(() => placeTask(sam, block.id, { at: at(1, 16), durationMinutes: 15 })), /^not_found\|404/);
    await addTaskParticipants(mark, block.id, [sam.userId]);
    assert.match(await failure(() => placeTask(sam, block.id, { at: at(1, 16), durationMinutes: 15 })), /^forbidden\|403/);
    assert.equal((await getTask(mark, block.id)).dueAt, at(1, 15));
  });

  it("moves a block from another workspace only in that workspace", async () => {
    const elsewhere = (await createTask(personal, { title: "Email the accountant", dueAt: at(1, 12) })).body.task;
    const actor = await actorForTask(mark, elsewhere.id);
    assert.equal(actor.workspaceId, personal.workspaceId);
    assert.match(await failure(() => placeTask(mark, elsewhere.id, { at: at(1, 14), durationMinutes: 15 })), /^not_found\|404/);
    const { task: moved } = await placeTask(actor, elsewhere.id, { at: at(1, 14), durationMinutes: 30 });
    assert.equal(moved.workspaceId, personal.workspaceId);
    assert.equal(moved.dueAt, at(1, 14));
    assert.deepEqual((await audits(elsewhere.id)).map((row) => row.workspace_id), [personal.workspaceId]);
  });
});
