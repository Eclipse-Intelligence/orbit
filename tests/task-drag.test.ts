import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { dateKey, shiftDateKey } from "@/lib/calendar-view";
import { dayStartIso, wallInstant } from "@/lib/crm/task-time";
import {
  createTask,
  getTask,
  listDueReminders,
  placeTask,
} from "@/lib/crm/tasks";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Task, UserActor } from "@/lib/crm/types";
import { actorForTask, createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  edgeScrollSpeed,
  placedTask,
  placementFor,
  placementLanded,
  samePlace,
  slotDateLabel,
  slotInstant,
  slotRange,
  snapDuration,
  snapStart,
} from "@/lib/task-drag";
import { createUser, resetDatabase } from "./helpers";

delete process.env.TYPESAFE_API_KEY;
delete process.env.LLM_API_KEY;

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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("dragging on the grid", () => {
  it("snaps a start to 15 minutes and keeps the block inside its day", () => {
    assert.equal(snapStart(13 * 60 + 37, 15), 13 * 60 + 30);
    assert.equal(snapStart(13 * 60 + 38, 15), 13 * 60 + 45);
    assert.equal(snapStart(-20, 15), 0);
    assert.equal(snapStart(23 * 60 + 55, 30), 23 * 60 + 30);
    assert.equal(snapStart(23 * 60 + 55, 5), 23 * 60 + 45);
  });

  it("snaps a resize to 15 minutes between 15 minutes and 8 hours, and never past midnight", () => {
    assert.equal(snapDuration(13 * 60 + 15, 13 * 60 + 44), 30);
    assert.equal(snapDuration(13 * 60 + 15, 13 * 60 + 16), 15);
    assert.equal(snapDuration(13 * 60, 13 * 60 - 60), 15);
    assert.equal(snapDuration(9 * 60, 20 * 60), 480);
    assert.equal(snapDuration(23 * 60, 25 * 60), 60);
  });

  it("turns a slot into London wall time, in summer and winter", () => {
    assert.equal(
      slotInstant("2026-07-14", 13 * 60 + 30),
      "2026-07-14T12:30:00.000Z",
    );
    assert.equal(
      slotInstant("2026-11-13", 13 * 60 + 30),
      "2026-11-13T13:30:00.000Z",
    );
    assert.deepEqual(
      placementFor({ day: "2026-11-13", minutes: 9 * 60, durationMinutes: 30 }),
      { at: "2026-11-13T09:00:00.000Z", durationMinutes: 30 },
    );
    assert.equal(
      slotRange({ minutes: 13 * 60 + 15, durationMinutes: 30 }),
      "13:15 to 13:45",
    );
    assert.equal(slotDateLabel("2026-11-13"), "Fri 13 Nov");
  });

  it("knows when a drop lands where the block already is", () => {
    const placed = task({
      dueAt: "2026-11-13T13:30:00.000Z",
      dueHasTime: true,
      durationMinutes: 15,
    });
    assert.equal(
      samePlace(placed, {
        day: "2026-11-13",
        minutes: 13 * 60 + 30,
        durationMinutes: 15,
      }),
      true,
    );
    assert.equal(
      samePlace(placed, {
        day: "2026-11-13",
        minutes: 13 * 60 + 30,
        durationMinutes: 30,
      }),
      false,
    );
    assert.equal(
      samePlace(task({ dueAt: dayStartIso("2026-11-13") }), {
        day: "2026-11-13",
        minutes: 0,
        durationMinutes: 15,
      }),
      false,
    );
  });

  it("shows a drop at once, making it timed and the dragger's, or date only on the same day", () => {
    const listed = task({
      dueAt: dayStartIso("2026-11-13"),
      dueDate: "2026-11-13",
      durationMinutes: 45,
    });
    const timed = placedTask(
      listed,
      { at: "2026-11-16T10:00:00.000Z", durationMinutes: 45 },
      "mark",
    );
    assert.equal(timed.dueHasTime, true);
    assert.equal(timed.dueDate, "2026-11-16");
    assert.equal(timed.scheduledBy, "person");
    assert.equal(timed.ownerId, "mark");
    assert.equal(
      placedTask(
        { ...listed, ownerId: "sam" },
        { at: "2026-11-16T10:00:00.000Z", durationMinutes: 45 },
        "mark",
      ).ownerId,
      "sam",
    );
    const back = placedTask(
      task({
        dueAt: "2026-07-14T22:30:00.000Z",
        dueHasTime: true,
        scheduledBy: "planner",
        remindMinutes: 10,
      }),
      { dateOnly: true },
      "mark",
    );
    assert.equal(back.dueDate, "2026-07-14");
    assert.equal(back.dueAt, dayStartIso("2026-07-14"));
    assert.equal(back.dueHasTime, false);
    assert.equal(back.scheduledBy, null);
    assert.equal(back.remindMinutes, null);
    assert.equal(
      placementLanded({ ...timed, dueAt: "2026-11-16T10:00:00Z" }, timed),
      true,
    );
    assert.equal(placementLanded(listed, timed), false);
    assert.equal(
      placementLanded({ ...timed, durationMinutes: 15 }, timed),
      false,
    );
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
  const at = (offset: number, hour: number, minute = 0) =>
    new Date(wallInstant(day(offset), hour, minute)).toISOString();
  const failure = async (work: () => Promise<unknown>) => {
    try {
      await work();
      return "";
    } catch (error) {
      const known = error as { code?: string; status?: number };
      return `${known.code}|${known.status}`;
    }
  };

  before(async () => {
    await resetDatabase();
    mark = {
      ...(await createUser("mark@drag.test", "Mark Ridgeon")),
      workspaceName: "Eclipse",
    };
    const created = await createWorkspace(mark, { name: "Mark Ridgeon" });
    personal = {
      ...mark,
      workspaceId: created.id,
      workspaceName: "Mark Ridgeon",
      role: "owner",
      scopes: scopesForRole("owner"),
    };
    const samId = (
      await getAdminPool().query<{ id: string }>(
        "select private.create_local_user('sam@drag.test', 'password-123', 'Sam Okafor') as id",
      )
    ).rows[0].id;
    await getAdminPool().query(
      "insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [mark.workspaceId, samId],
    );
    sam = {
      ...mark,
      userId: samId,
      email: "sam@drag.test",
      fullName: "Sam Okafor",
      role: "member",
      scopes: scopesForRole("member"),
    };
  });

  it("puts a date-only task on the grid with its time and duration, placed by the person, and audits it as a drag", async () => {
    const listed = (
      await createTask(mark, {
        title: "Call Jane Cooper",
        dueDate: day(2),
        durationMinutes: 45,
      })
    ).body.task;
    const placed = await placeTask(mark, listed.id, {
      at: at(3, 13, 30),
      durationMinutes: 45,
    });
    assert.equal(placed.dueAt, at(3, 13, 30));
    assert.equal(placed.dueHasTime, true);
    assert.equal(placed.dueDate, day(3));
    assert.equal(placed.durationMinutes, 45);
    assert.equal(placed.scheduledBy, "person");
    const audit = await getAdminPool().query<{
      operation: string;
      source: string;
    }>(
      "select operation, source from crm.audit_events where entity_id = $1 and event_type = 'task.updated'",
      [listed.id],
    );
    assert.deepEqual(audit.rows, [{ operation: "drag_task", source: "web" }]);
  });

  it("makes an unassigned task the dragger's", async () => {
    const unassigned = (
      await createTask(mark, { title: "Unassigned call", ownerId: null })
    ).body.task;
    assert.equal(unassigned.ownerId, null);
    const placed = await placeTask(mark, unassigned.id, {
      at: at(1, 9),
      durationMinutes: 15,
    });
    assert.equal(placed.ownerId, mark.userId);
    assert.equal(placed.dueHasTime, true);
  });

  it("keeps a task someone else owns with them", async () => {
    const forSam = (
      await createTask(mark, {
        title: "Sam's follow-up",
        ownerId: sam.userId,
        dueDate: day(1),
      })
    ).body.task;
    const placed = await placeTask(mark, forSam.id, {
      at: at(1, 11),
      durationMinutes: 15,
    });
    assert.equal(placed.ownerId, sam.userId);
  });

  it("claims a block Plan placed when it is only resized, and moves its reminder with it", async () => {
    const planned = (
      await createTask(mark, {
        title: "Email Halden",
        dueAt: at(2, 13, 15),
        scheduledBy: "planner",
        remindMinutes: 10,
      })
    ).body.task;
    assert.equal(planned.scheduledBy, "planner");
    const resized = await placeTask(mark, planned.id, {
      at: at(2, 13, 15),
      durationMinutes: 30,
    });
    assert.equal(resized.durationMinutes, 30);
    assert.equal(resized.scheduledBy, "person");
    assert.equal(resized.remindMinutes, 10);
    const moved = await placeTask(mark, planned.id, {
      at: at(0, 23, 45),
      durationMinutes: 15,
    });
    assert.equal(moved.remindMinutes, 10);
    const reminders = await listDueReminders(mark);
    const reminder = reminders.find((item) => item.id === planned.id);
    if (reminder) assert.equal(reminder.dueAt, at(0, 23, 45));
  });

  it("times a date-only task dropped at midnight on its own day", async () => {
    const listed = (
      await createTask(mark, { title: "Night call", dueDate: day(4) })
    ).body.task;
    const placed = await placeTask(mark, listed.id, {
      at: at(4, 0),
      durationMinutes: 15,
    });
    assert.equal(placed.dueHasTime, true);
    assert.equal(placed.scheduledBy, "person");
    assert.equal(placed.dueAt, dayStartIso(day(4)));
  });

  it("makes a block date only again on the same day when it goes back on the list", async () => {
    const block = (
      await createTask(mark, {
        title: "Late email",
        dueAt: at(5, 23, 30),
        remindMinutes: 15,
      })
    ).body.task;
    const back = await placeTask(mark, block.id, { dateOnly: true });
    assert.equal(back.dueHasTime, false);
    assert.equal(back.dueDate, day(5));
    assert.equal(back.dueAt, dayStartIso(day(5)));
    assert.equal(back.scheduledBy, null);
    assert.equal(back.remindMinutes, null);
    const undated = (await createTask(mark, { title: "No date" })).body.task;
    assert.match(
      await failure(() => placeTask(mark, undated.id, { dateOnly: true })),
      /^invalid_input\|400/,
    );
  });

  it("refuses a drop with no time, and someone who can't change the task", async () => {
    const block = (
      await createTask(mark, { title: "Mark's block", dueAt: at(1, 15) })
    ).body.task;
    assert.match(
      await failure(() =>
        placeTask(mark, block.id, { at: day(1), durationMinutes: 15 }),
      ),
      /^invalid_input\|400/,
    );
    assert.match(
      await failure(() =>
        placeTask(mark, block.id, { at: at(1, 15), durationMinutes: 2 }),
      ),
      /^invalid_input\|400/,
    );
    assert.match(
      await failure(() =>
        placeTask(sam, block.id, { at: at(1, 16), durationMinutes: 15 }),
      ),
      /^not_found\|404/,
    );
    assert.equal((await getTask(mark, block.id)).dueAt, at(1, 15));
  });

  it("moves a block from another workspace in that workspace", async () => {
    const elsewhere = (
      await createTask(personal, {
        title: "Email the accountant",
        dueAt: at(1, 12),
      })
    ).body.task;
    const actor = await actorForTask(mark, elsewhere.id);
    assert.equal(actor.workspaceId, personal.workspaceId);
    assert.match(
      await failure(() =>
        placeTask(mark, elsewhere.id, { at: at(1, 14), durationMinutes: 15 }),
      ),
      /^not_found\|404/,
    );
    const moved = await placeTask(actor, elsewhere.id, {
      at: at(1, 14),
      durationMinutes: 30,
    });
    assert.equal(moved.workspaceId, personal.workspaceId);
    assert.equal(moved.dueAt, at(1, 14));
    const audit = await getAdminPool().query<{ workspace_id: string }>(
      "select workspace_id from crm.audit_events where entity_id = $1 and event_type = 'task.updated'",
      [elsewhere.id],
    );
    assert.deepEqual(
      audit.rows.map((row) => row.workspace_id),
      [personal.workspaceId],
    );
  });
});
