import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact, updateContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { scopesForRole } from "@/lib/crm/scopes";
import {
  createRepeatingTask,
  createTaskFromApi,
  DONE_ALREADY,
  endSeriesOn,
  NEW_DAY_OPEN,
  readRepeat,
  rollDueSeries,
  setTaskRepeat,
  skipDeletedOccurrenceInDb,
  skipOccurrence,
  SKIP_MOVED_ON,
  SPLITS_WEEKS,
  TOO_FEW_TIMES,
  TOO_MANY_SERIES,
  updateOccurrence,
} from "@/lib/crm/task-series";
import { addTaskParticipants, archiveTask, completeTask, getTask, reopenTask, updateTask } from "@/lib/crm/tasks";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { undoAuditEvent, undoTaskEvents } from "@/lib/crm/undo";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { reachesEnd, repeatInputOf, repeatPresets, type RepeatEnds } from "@/lib/task-repeat";
import { createAgent, createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let companyId: string;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

type SeriesRow = { id: string; current_task_id: string | null; ended_at: Date | null; at: string | null; title: string; ends: RepeatEnds; duration_minutes: number; roll_at: Date | null };

async function series(id: string) {
  const [row] = await sql<SeriesRow>("select id, current_task_id, ended_at, to_char(at, 'HH24:MI') as at, title, ends, duration_minutes, roll_at from crm.task_series where id = $1", [id]);
  return row;
}

async function later(parentId: string) {
  const [row] = await sql<SeriesRow>(
    "select id, current_task_id, ended_at, to_char(at, 'HH24:MI') as at, title, ends, duration_minutes, roll_at from crm.task_series where split_from_id = $1 order by starts_on",
    [parentId],
  );
  return row;
}

async function openTasks(seriesIds: string[]) {
  return sql<{ id: string; occurs_on: string; series_id: string; title: string; company_id: string | null; mail_thread_key: string | null }>(
    "select id, occurs_on::text as occurs_on, series_id, title, company_id, mail_thread_key from crm.tasks where series_id = any($1::uuid[]) and completed_at is null and archived_at is null order by occurs_on",
    [seriesIds],
  );
}

function at(day: string, time: string) {
  return new Date(`${day}T${time}:00Z`).toISOString();
}

async function weekly(title: string, extra: Record<string, unknown> = {}, time: string | null = "14:00", owner: UserActor = mark) {
  const due = time ? { dueAt: at("2027-03-02", time) } : { dueDate: "2027-03-02" };
  return (await createRepeatingTask(owner, { title, ...due, companyId }, { every: "week", ...extra })).body.task;
}

async function splitAt(task: { seriesId: string | null }, day: string, title: string, actor: UserActor = mark) {
  await updateOccurrence(actor, { seriesId: task.seriesId!, occursOn: day }, { title }, "following");
  return later(task.seriesId!);
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@review.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@review.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@review.test", "Priya Nair"), "member");
  companyId = (await createCompany(mark, { name: "Northwind", domain: "northwind-review.test" })).body.company.id;
});

beforeEach(async () => {
  await sql("update crm.task_series set archived_at = now() where archived_at is null");
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("split series", () => {
  it("reports the end of the whole series, so a new pattern sent back with it keeps repeating (3)", async () => {
    const task = await weekly("Pattern on split");
    await splitAt(task, "2027-03-16", "Pattern later");
    const repeat = (await getTask(mark, task.id)).repeat!;
    assert.deepEqual(repeat.ends, { never: true });
    await setTaskRepeat(mark, task.id, repeatInputOf({ freq: "daily", interval: 1 }, repeat.ends));
    assert.deepEqual((await series(task.seriesId!)).ends, { never: true });
  });

  it("stops a later part when the end comes before it starts (4)", async () => {
    const task = await weekly("End before part");
    const part = await splitAt(task, "2027-03-16", "End before later");
    await endSeriesOn(mark, task.id, "2027-03-09");
    assert.ok((await series(part.id)).ended_at);
    assert.deepEqual((await series(task.seriesId!)).ends, { until: "2027-03-09" });
  });

  it("ends a later part on a date inside it and keeps its change (21)", async () => {
    const task = await weekly("End inside part");
    const part = await splitAt(task, "2027-03-16", "Kept later title");
    await endSeriesOn(mark, task.id, "2027-03-30");
    const kept = await series(part.id);
    assert.equal(kept.ended_at, null);
    assert.deepEqual(kept.ends, { until: "2027-03-30" });
    assert.equal(kept.title, "Kept later title");
    assert.deepEqual((await series(task.seriesId!)).ends, { until: "2027-03-15" });
  });

  it("undoes Done on an earlier part's last one without leaving two open tasks (43)", async () => {
    const task = await weekly("Undo part start");
    const part = await splitAt(task, "2027-03-09", "Started later");
    await completeTask(mark, task.id);
    assert.equal((await openTasks([part.id])).length, 1);
    await reopenTask(mark, task.id);
    const open = await openTasks([task.seriesId!, part.id]);
    assert.deepEqual(open.map((row) => row.id), [task.id]);
    assert.equal((await series(part.id)).current_task_id, null);
    assert.equal((await series(task.seriesId!)).ended_at, null);
  });

  it("starts a later part after the done one's day when the last one was moved past it (45)", async () => {
    const task = await weekly("Late into part");
    const part = await splitAt(task, "2027-03-09", "Late later");
    await updateTask(mark, task.id, { dueAt: at("2027-03-10", "14:00") });
    await completeTask(mark, task.id);
    assert.deepEqual((await openTasks([part.id])).map((row) => row.occurs_on), ["2027-03-16"]);
  });

  it("skips the earlier part's last one into the later part (49)", async () => {
    const task = await weekly("Skip into part");
    const part = await splitAt(task, "2027-03-09", "Skipped into");
    const moved = (await skipOccurrence(mark, { taskId: task.id })).body.task;
    assert.equal(moved.seriesId, part.id);
    assert.equal(moved.occursOn, "2027-03-09");
    assert.equal(moved.title, "Skipped into");
  });

  it("moves the earlier part's roll time when the later part's first date is skipped (50)", async () => {
    const task = await weekly("Roll after part skip");
    const part = await splitAt(task, "2027-03-09", "Roll later");
    assert.equal((await series(task.seriesId!)).roll_at?.toISOString(), "2027-03-09T00:00:00.000Z");
    await skipOccurrence(mark, { seriesId: part.id, occursOn: "2027-03-09" });
    assert.equal((await series(task.seriesId!)).roll_at?.toISOString(), "2027-03-16T00:00:00.000Z");
  });

  it("refuses moving the earlier part's last date past the later part's first (55)", async () => {
    const task = await weekly("Past the part");
    await splitAt(task, "2027-03-16", "After the move");
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-09" }, { dueAt: at("2027-03-17", "14:00") }, "this"), /before Tue 16 Mar/);
  });

  it("rolls a missed last task into the later part an assignee split off (11)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Assignee part", dueDate: "2027-03-02", ownerId: sam.userId }, { every: "week" })).body.task;
    await splitAt(task, "2027-03-09", "Sam's part", sam);
    const result = await rollDueSeries({ deadline: Date.now() + 30_000, now: Date.parse("2027-03-09T00:01:00Z") });
    assert.equal(result.rolled, 1);
    const moved = await sql<{ series_id: string; occurs_on: string }>("select series_id, occurs_on::text as occurs_on from crm.tasks where id = $1", [task.id]);
    assert.notEqual(moved[0].series_id, task.seriesId);
    assert.equal(moved[0].occurs_on, "2027-03-09");
  });
});

describe("Done and Undo", () => {
  it("completes after the linked contact moved company, following the contact (1)", async () => {
    const moved = (await createCompany(mark, { name: "Moved to", domain: "moved-to-review.test" })).body.company.id;
    const contact = (await createContact(mark, { firstName: "Moving", lastName: "Contact", email: "moving@review.test", companyId })).body.contact.id;
    const task = (await createRepeatingTask(mark, { title: "Call the mover", dueDate: "2027-03-02", contactId: contact }, { every: "week" })).body.task;
    await updateContact(mark, contact, { companyId: moved });
    await splitAt(task, "2027-03-16", "Call the mover later");
    await completeTask(mark, task.id);
    const [next] = await openTasks([task.seriesId!]);
    assert.equal(next.company_id, moved);
  });

  it("refuses stopping the series from a done one (5)", async () => {
    const task = await weekly("Stop from done");
    await completeTask(mark, task.id);
    await assert.rejects(setTaskRepeat(mark, task.id, null), new RegExp(DONE_ALREADY.slice(0, 20)));
    assert.equal((await series(task.seriesId!)).ended_at, null);
  });

  it("brings back skipped and changed dates when Done is undone (10)", async () => {
    const task = await weekly("Undo keeps changes");
    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-09" });
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { title: "Retitled" }, "this");
    await completeTask(mark, task.id);
    await reopenTask(mark, task.id);
    const changes = await sql<{ occurs_on: string; skip: boolean; title: string | null }>(
      "select occurs_on::text as occurs_on, skip, title from crm.task_occurrence_changes where series_id = $1 order by occurs_on",
      [task.seriesId],
    );
    assert.deepEqual(changes, [
      { occurs_on: "2027-03-09", skip: true, title: null },
      { occurs_on: "2027-03-16", skip: false, title: "Retitled" },
    ]);
  });

  it("goes past a done day years ahead (47)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Far ahead", dueDate: "2027-03-01" }, { every: "day" })).body.task;
    await updateTask(mark, task.id, { dueDate: "2034-03-01" });
    await completeTask(mark, task.id);
    assert.deepEqual((await openTasks([task.seriesId!])).map((row) => row.occurs_on), ["2034-03-02"]);
  });

  it("makes no occurrence before the done one's day when the last date has passed it (48)", async () => {
    const task = await weekly("Last before done", { ends: { after: 2 } });
    await updateTask(mark, task.id, { dueAt: at("2027-03-12", "14:00") });
    await completeTask(mark, task.id);
    assert.equal((await openTasks([task.seriesId!])).length, 0);
    assert.ok((await series(task.seriesId!)).ended_at);
  });

  it("carries the mail thread to the next one for the same person (105)", async () => {
    const task = await weekly("Thread follows");
    const thread = "00000000-0000-4000-8000-000000000000|thread-review-key";
    await sql("update crm.tasks set mail_thread_key = $2 where id = $1", [task.id, thread]);
    await completeTask(mark, task.id);
    assert.equal((await openTasks([task.seriesId!]))[0].mail_thread_key, thread);
  });

  it("opens the series again when deleting its last one is undone (63)", async () => {
    const task = await weekly("Delete last", { ends: { after: 1 } });
    await archiveTask(mark, task.id);
    assert.ok((await series(task.seriesId!)).ended_at);
    const [archived] = await sql<{ id: string }>("select id from crm.audit_events where entity_id = $1 and event_type = 'task.archived'", [task.id]);
    await undoAuditEvent(mark, archived.id, { operation: "undo_change" });
    assert.equal((await series(task.seriesId!)).ended_at, null);
  });

  it("returns undo ids that undo a This one reassign (61)", async () => {
    const task = await weekly("Reassign undo");
    const result = (await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this")).body;
    await undoTaskEvents(mark, task.id, result.undo, { operation: "undo_change" });
    assert.equal((await getTask(mark, task.id)).ownerId, mark.userId);
  });
});

describe("rolls and skips", () => {
  it("rolls an open one moved later to the date after its new day (19)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Moved later", dueAt: at("2027-03-01", "10:00") }, { every: "day" })).body.task;
    await updateTask(mark, task.id, { dueAt: at("2027-03-02", "17:00") });
    await rollDueSeries({ deadline: Date.now() + 30_000, now: Date.parse("2027-03-02T17:16:00Z") });
    const moved = await getTask(mark, task.id);
    assert.equal(moved.occursOn, "2027-03-03");
    assert.equal(moved.dueAt, at("2027-03-03", "10:00"));
  });

  it("refreshes the roll time when only the length changes (44)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Late length", dueAt: at("2027-03-01", "23:00") }, { every: "day" })).body.task;
    assert.equal((await series(task.seriesId!)).roll_at?.toISOString(), "2027-03-02T00:00:00.000Z");
    await updateOccurrence(mark, { taskId: task.id }, { durationMinutes: 120 }, "this");
    assert.equal((await series(task.seriesId!)).roll_at?.toISOString(), "2027-03-02T01:00:00.000Z");
  });

  it("doesn't tell the owner they were assigned a task when a handed-on one rolls back to them (54)", async () => {
    const task = (await createRepeatingTask(priya, { title: "Handed roll", dueDate: "2027-03-01", ownerId: mark.userId }, { every: "day" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this");
    const alerts = async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return (await sql("select 1 from crm.notifications where user_id = $1 and title like '%assigned you a task' and body = 'Handed roll'", [mark.userId])).length;
    };
    const before = await alerts();
    await rollDueSeries({ deadline: Date.now() + 30_000, now: Date.parse("2027-03-02T00:01:00Z") });
    assert.equal((await getTask(mark, task.id)).ownerId, mark.userId);
    assert.equal(await alerts(), before);
  });

  it("rolls a non-owner's run once, not every minute (58)", async () => {
    const task = (await createRepeatingTask(priya, { title: "Owner gone", dueDate: "2027-03-01" }, { every: "day" })).body.task;
    await updateOccurrence(priya, { taskId: task.id }, { ownerId: sam.userId }, "this");
    await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, priya.userId]);
    try {
      await sql("update crm.task_series set roll_pending = true, roll_at = '2027-03-01' where id = $1", [task.seriesId]);
      const first = Date.parse("2027-03-02T00:01:00Z");
      await rollDueSeries({ deadline: Date.now() + 30_000, now: first });
      await rollDueSeries({ deadline: Date.now() + 30_000, now: first + 60_000 });
      assert.equal((await getTask(sam, task.id)).occursOn, "2027-03-02");
    } finally {
      await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [mark.workspaceId, priya.userId]);
    }
  });

  it("refuses a stale delete of the open one so a retry can't skip twice (25)", async () => {
    const task = await weekly("Delete twice");
    await archiveTask(mark, task.id, { expect: "2027-03-02" });
    await assert.rejects(archiveTask(mark, task.id, { expect: "2027-03-02" }), new RegExp(SKIP_MOVED_ON.slice(0, 20)));
    assert.equal((await getTask(mark, task.id)).occursOn, "2027-03-09");
  });

  it("doesn't fail the ClickUp sync when the deleted one can't be skipped (111)", async () => {
    const task = await weekly("ClickUp gone");
    await addTaskParticipants(mark, task.id, [priya.userId]);
    const skipped = await withActor(priya, (db) => skipDeletedOccurrenceInDb(db, priya, task.id, { operation: "clickup_deleted", source: "clickup" }));
    assert.equal(skipped, false);
  });
});

describe("edits by scope", () => {
  async function samsTimedSeries(title: string) {
    const task = (await createRepeatingTask(mark, { title, dueDate: "2027-03-02", ownerId: sam.userId }, { every: "week" })).body.task;
    await updateOccurrence(sam, { taskId: task.id }, { dueAt: at("2027-03-02", "14:00") }, "all");
    assert.equal((await series(task.seriesId!)).at, "14:00");
    return task;
  }

  async function handedOn(title: string) {
    const task = await weekly(title);
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this");
    await updateOccurrence(sam, { taskId: task.id }, { dueAt: at("2027-03-02", "16:00") }, "this");
    return task;
  }

  it("keeps the assignee's series time when the creator resends it with All (14)", async () => {
    const task = await samsTimedSeries("Same time resent");
    await updateOccurrence(mark, { taskId: task.id }, { dueAt: at("2027-03-02", "14:00"), title: "Same time renamed" }, "all");
    assert.equal((await series(task.seriesId!)).at, "14:00");
  });

  it("leaves a handed-on assignee's own time when All changes the time from an upcoming date (15)", async () => {
    const task = await handedOn("Handed time kept");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { dueAt: at("2027-03-16", "15:00") }, "all");
    const open = await getTask(sam, task.id);
    assert.equal(open.dueHasTime, true);
    assert.equal(open.dueAt, at("2027-03-02", "16:00"));
    assert.equal((await series(task.seriesId!)).at, "15:00");
  });

  it("lets the owner change the length for All while a handed-on one has a time (16)", async () => {
    const task = await handedOn("Handed length");
    await updateOccurrence(mark, { taskId: task.id }, { durationMinutes: 60 }, "all");
    assert.equal((await series(task.seriesId!)).duration_minutes, 60);
    assert.equal((await getTask(sam, task.id)).durationMinutes, 15);
  });

  it("refuses This and following moved before the date before it (17)", async () => {
    const task = await weekly("Moved too early");
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-23" }, { dueAt: at("2027-03-04", "14:00") }, "following"), /Choose a day after/);
  });

  it("drops the edited date's own old title when This and following renames it (18)", async () => {
    const task = await weekly("Stale title");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { title: "Old one-off" }, "this");
    const part = await splitAt(task, "2027-03-16", "Second part");
    const rows = await sql("select 1 from crm.task_occurrence_changes where series_id = $1 and occurs_on = '2027-03-16' and title is not null", [part.id]);
    assert.equal(rows.length, 0);
  });

  it("refuses a new day with All on the open one (24)", async () => {
    const task = await weekly("All new day");
    await assert.rejects(updateOccurrence(mark, { taskId: task.id }, { dueAt: at("2027-03-03", "14:00") }, "all"), new RegExp(NEW_DAY_OPEN.slice(0, 20)));
  });

  it("reads London date text when deciding whether a scope is needed (23)", async () => {
    const task = await weekly("London text");
    await assert.rejects(updateOccurrence(mark, { taskId: task.id }, { dueAt: "02/03/2027 15:00" }, undefined), /repeatScope/);
    await updateOccurrence(mark, { taskId: task.id }, { dueAt: "02/03/2027 14:00" }, undefined);
  });

  it("moves a timed open one to another day with dueDate and no scope (109)", async () => {
    const task = await weekly("Date move");
    const moved = (await updateOccurrence(mark, { taskId: task.id }, { dueDate: "2027-03-03" }, undefined)).body.task;
    assert.equal(moved.dueDate, "2027-03-03");
  });

  it("ignores used change rows when counting the 200 (46)", async () => {
    const task = await weekly("Old rows");
    await sql("insert into crm.task_occurrence_changes (series_id, occurs_on, skip) select $1, date '2026-01-01' + i, true from generate_series(0, 199) i", [task.seriesId]);
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { title: "Still room" }, "this");
  });

  it("refuses a This and following move that would split a fortnightly pattern's weeks (52)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Fortnightly", dueDate: "2027-03-01" }, { every: "week", interval: 2, days: ["mo", "th"] })).body.task;
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-29" }, { dueDate: "2027-03-27" }, "following"), new RegExp(SPLITS_WEEKS.slice(0, 20)));
  });

  it("keeps a moved date's day when All changes the time (53)", async () => {
    const task = await weekly("Moved keeps day");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { dueAt: at("2027-03-17", "14:00") }, "this");
    await updateOccurrence(mark, { taskId: task.id }, { dueAt: at("2027-03-02", "15:00") }, "all");
    const [change] = await sql<{ due_at: Date; due_has_time: boolean }>("select due_at, due_has_time from crm.task_occurrence_changes where series_id = $1 and occurs_on = '2027-03-16'", [task.seriesId]);
    assert.equal(change.due_at.toISOString(), at("2027-03-17", "15:00"));
    assert.equal(change.due_has_time, true);
  });

  it("refuses a creator setting the length of a colleague's timed upcoming date (56)", async () => {
    const task = await samsTimedSeries("Colleague length");
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { durationMinutes: 60 }, "this"), /Only the owner can change the length/);
  });
});

describe("ends and limits", () => {
  it("refuses End on a date once the series has stopped (59)", async () => {
    const task = await weekly("Stopped end");
    await setTaskRepeat(mark, task.id, null);
    await assert.rejects(endSeriesOn(mark, task.id, "2027-04-01"), /doesn't repeat any more/);
  });

  it("refuses fewer times than have passed (64)", async () => {
    const task = await weekly("Too few", { ends: { after: 10 } });
    let open = task.id;
    for (let done = 0; done < 3; done += 1) {
      await completeTask(mark, open);
      open = (await openTasks([task.seriesId!]))[0].id;
    }
    await assert.rejects(setTaskRepeat(mark, open, { every: "week", ends: { after: 2 } }), new RegExp(TOO_FEW_TIMES.slice(0, 20)));
  });

  it("counts an agent's series against the workspace owner, and keeps a reopened last one ended when full (65, 66)", async () => {
    const last = await weekly("Last when full", { ends: { after: 1 } });
    await completeTask(mark, last.id);
    const values: string[] = [];
    for (let index = 0; index < 200; index += 1) values.push(`('${mark.workspaceId}', '${mark.userId}', '${mark.userId}', 'Full ${index}', '2027-03-01', '{"freq":"daily","interval":1}'::jsonb)`);
    await sql(`insert into crm.task_series (workspace_id, created_by_user_id, owner_id, title, starts_on, rule) values ${values.join(", ")}`);
    try {
      const { actor: agent } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Review agent");
      await assert.rejects(createRepeatingTask(agent, { title: "Agent over", dueDate: "2027-03-02" }, { every: "week" }), new RegExp(TOO_MANY_SERIES.slice(0, 20)));
      await reopenTask(mark, last.id);
      assert.ok((await series(last.seriesId!)).ended_at);
    } finally {
      await sql("update crm.task_series set archived_at = now() where title like 'Full %'");
    }
  });

  it("starts every few months on the first matching day after the due day (22)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Quarterly", dueDate: "2027-01-20" }, { every: "month", interval: 3, monthDay: 5 })).body.task;
    assert.equal(task.occursOn, "2027-02-05");
  });

  it("refuses a count that runs past the year Outlook takes (96)", () => {
    assert.equal(reachesEnd({ startsOn: "2027-01-01", at: null, rule: { freq: "yearly", interval: 99 }, ends: { count: 30 } }), false);
    assert.equal(reachesEnd({ startsOn: "2027-01-01", at: null, rule: { freq: "yearly", interval: 1 }, ends: { count: 30 } }), true);
  });

  it("labels the yearly choice with the series' own day on a short year (134)", () => {
    const yearly = repeatPresets("2029-02-28", { rule: { freq: "yearly", interval: 1 }, startsOn: "2028-02-29" }).find((preset) => preset.id === "yearly");
    assert.equal(yearly?.label, "Every year on 29 Feb");
  });

  it("refuses a malformed monthWeek and a falsy repeat on create (nit)", async () => {
    assert.throws(() => readRepeat({ every: "month", monthWeek: 0 }, "2027-03-02"), /which week of the month/);
    await assert.rejects(createTaskFromApi(mark, { title: "Falsy repeat", dueDate: "2027-03-02", repeat: false }), /Choose how it repeats/);
  });
});
