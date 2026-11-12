import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it, mock } from "node:test";
import { createContact } from "@/lib/crm/contacts";
import { ingestLead } from "@/lib/crm/leads";
import { exportTasksCsv } from "@/lib/crm/spreadsheet";
import { dayStartIso } from "@/lib/crm/task-time";
import { createTask, getTask, listDueReminders, listTasks, updateTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { undoAuditEvent } from "@/lib/crm/undo";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { addTask } from "@/lib/extension/capture";
import { createUser, resetDatabase } from "./helpers";

let mark: UserActor;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@timing.test", "Mark Ridgeon");
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("the task timing migration", () => {
  it("keeps tasks with a reminder timed and moves the rest to London midnight without a ClickUp push", async () => {
    const client = await getAdminPool().connect();
    try {
      await client.query("begin");
      await client.query("alter table crm.tasks drop constraint tasks_timing_check, drop column due_has_time, drop column scheduled_by");
      const insert = async (title: string, dueAt: string | null, remind: number | null, sync: unknown = {}) =>
        (
          await client.query<{ id: string; updated_at: Date }>(
            `insert into crm.tasks (workspace_id, title, due_at, remind_minutes, clickup_sync, updated_at)
             values ($1, $2, $3, $4, $5::jsonb, now() - interval '3 days') returning id, updated_at`,
            [mark.workspaceId, title, dueAt, remind, JSON.stringify(sync)],
          )
        ).rows[0];
      const reminded = await insert("Call Jane at two", "2026-07-01T13:00:00.000Z", 15);
      const summer = await insert("Send the deck", "2026-07-01T08:00:00.000Z", null, { dueAt: "2026-07-01T08:00:00.000Z", title: "Send the deck" });
      const lateSummer = await insert("Late one", "2026-07-01T23:30:00.000Z", null);
      const winter = await insert("Winter one", "2026-12-01T15:45:00.000Z", null, { dueAt: "2026-11-30T09:00:00.000Z" });
      const undated = await insert("No date", null, null);
      const migration = readFileSync("supabase/migrations/20270121100000_task_timing.sql", "utf8");
      await client.query(migration);
      await client.query(migration);
      const rows = (
        await client.query<{ id: string; due_at: Date | null; due_has_time: boolean; scheduled_by: string | null; duration_minutes: number; updated_at: Date; clickup_sync: Record<string, unknown> }>(
          "select id, due_at, due_has_time, scheduled_by, duration_minutes, updated_at, clickup_sync from crm.tasks where workspace_id = $1",
          [mark.workspaceId],
        )
      ).rows;
      const byId = new Map(rows.map((row) => [row.id, row]));
      assert.equal(byId.get(reminded.id)?.due_at?.toISOString(), "2026-07-01T13:00:00.000Z");
      assert.equal(byId.get(reminded.id)?.due_has_time, true);
      assert.equal(byId.get(reminded.id)?.scheduled_by, "person");
      assert.equal(byId.get(summer.id)?.due_at?.toISOString(), "2026-06-30T23:00:00.000Z");
      assert.equal(byId.get(summer.id)?.due_has_time, false);
      assert.equal(byId.get(summer.id)?.scheduled_by, null);
      assert.equal(new Date(String(byId.get(summer.id)?.clickup_sync.dueAt)).toISOString(), "2026-06-30T23:00:00.000Z");
      assert.equal(byId.get(summer.id)?.clickup_sync.title, "Send the deck");
      assert.equal(byId.get(lateSummer.id)?.due_at?.toISOString(), "2026-07-01T23:00:00.000Z");
      assert.equal(byId.get(winter.id)?.due_at?.toISOString(), "2026-12-01T00:00:00.000Z");
      assert.equal(byId.get(winter.id)?.clickup_sync.dueAt, "2026-11-30T09:00:00.000Z");
      assert.equal(byId.get(undated.id)?.due_at, null);
      assert.ok(rows.every((row) => row.duration_minutes === 15));
      assert.equal(byId.get(summer.id)?.updated_at.toISOString(), summer.updated_at.toISOString());
      const dirty = await client.query(
        `select 1 from crm.tasks t where t.id = $1
           and (t.due_at is distinct from (t.clickup_sync->>'dueAt')::timestamptz
             or (t.clickup_sync ? 'dueHasTime' and t.due_has_time is distinct from (t.clickup_sync->>'dueHasTime')::boolean))`,
        [summer.id],
      );
      assert.equal(dirty.rowCount, 0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("date-only and timed tasks", () => {
  it("stores date-only tasks at London midnight and timed tasks as placed by a person", async () => {
    const summer = (await createTask(mark, { title: "Send the summer deck", dueDate: "2026-07-01" })).body.task;
    assert.equal(summer.dueAt, "2026-06-30T23:00:00.000Z");
    assert.equal(summer.dueDate, "2026-07-01");
    assert.equal(summer.dueHasTime, false);
    assert.equal(summer.scheduledBy, null);
    assert.equal(summer.durationMinutes, 15);
    const timed = (await createTask(mark, { title: "Call Jane", dueAt: "2026-07-01T14:30", durationMinutes: 30 })).body.task;
    assert.equal(timed.dueAt, "2026-07-01T13:30:00.000Z");
    assert.equal(timed.dueDate, "2026-07-01");
    assert.equal(timed.dueHasTime, true);
    assert.equal(timed.scheduledBy, "person");
    assert.equal(timed.durationMinutes, 30);
    const late = (await createTask(mark, { title: "Late call", dueAt: "2026-07-01T23:30:00Z" })).body.task;
    assert.equal(late.dueDate, "2026-07-02");
  });

  it("counts a date-only task due today as today until the London day ends, across summer time", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-07-01T22:30:00Z") });
    try {
      const today = (await createTask(mark, { title: "Due today only", dueDate: "2026-07-01" })).body.task;
      const yesterday = (await createTask(mark, { title: "Due yesterday only", dueDate: "2026-06-30" })).body.task;
      const overdue = (await listTasks(mark, { view: "overdue", limit: 100 })).data.map((task) => task.id);
      const todays = (await listTasks(mark, { view: "today", limit: 100 })).data.map((task) => task.id);
      assert.ok(todays.includes(today.id));
      assert.ok(!overdue.includes(today.id));
      assert.ok(overdue.includes(yesterday.id));
      mock.timers.setTime(Date.parse("2026-07-01T23:00:00Z"));
      const nextDay = (await listTasks(mark, { view: "overdue", limit: 100 })).data.map((task) => task.id);
      assert.ok(nextDay.includes(today.id));
    } finally {
      mock.timers.reset();
    }
  });

  it("asks for a time before a reminder, and drops the reminder with the time", async () => {
    await assert.rejects(createTask(mark, { title: "Remind without time", dueDate: "2026-12-01", remindMinutes: 15 }), /Pick a time for the reminder\./);
    const plain = (await createTask(mark, { title: "Plain day", dueDate: "2026-12-01" })).body.task;
    await assert.rejects(updateTask(mark, plain.id, { remindMinutes: 15 }), /Pick a time for the reminder\./);
    const timed = (await updateTask(mark, plain.id, { dueAt: "2026-12-01T14:00", remindMinutes: 15 })).body.task;
    assert.equal(timed.dueHasTime, true);
    assert.equal(timed.remindMinutes, 15);
    const removed = (await updateTask(mark, plain.id, { dueDate: "2026-12-01" })).body.task;
    assert.equal(removed.dueHasTime, false);
    assert.equal(removed.remindMinutes, null);
    assert.equal(removed.scheduledBy, null);
    assert.equal(removed.dueAt, dayStartIso("2026-12-01"));
    const cleared = (await updateTask(mark, timed.id, { dueAt: null })).body.task;
    assert.equal(cleared.dueAt, null);
    assert.equal(cleared.dueDate, null);
    assert.equal(cleared.dueHasTime, false);
  });

  it("only reminds about timed tasks", async () => {
    const soon = new Date(Date.now() + 10 * 60_000);
    const timed = (await createTask(mark, { title: "Timed reminder", dueAt: soon.toISOString(), remindMinutes: 15 })).body.task;
    await sql("update crm.tasks set due_has_time = false, scheduled_by = null where id = $1", [timed.id]);
    const reminders = await listDueReminders(mark);
    assert.ok(!reminders.some((item) => item.id === timed.id));
    const second = (await createTask(mark, { title: "Timed reminder two", dueAt: soon.toISOString(), remindMinutes: 15 })).body.task;
    assert.ok((await listDueReminders(mark)).some((item) => item.id === second.id));
  });

  it("refuses dueDate with a time, both fields, and durations out of range", async () => {
    await assert.rejects(createTask(mark, { title: "Both", dueDate: "2026-12-01", dueAt: "2026-12-01T10:00" }), /not both/);
    await assert.rejects(createTask(mark, { title: "Time in date", dueDate: "2026-12-01T10:00" }), /dueDate takes a day/);
    await assert.rejects(createTask(mark, { title: "Too short", durationMinutes: 4 }), /between 5 and 480/);
    await assert.rejects(createTask(mark, { title: "Too long", durationMinutes: 481 }), /between 5 and 480/);
    const task = (await createTask(mark, { title: "Long one", durationMinutes: 480 })).body.task;
    assert.equal((await updateTask(mark, task.id, { durationMinutes: 45 })).body.task.durationMinutes, 45);
  });

  it("keeps a planner placement and drops it when the time goes", async () => {
    const task = (await createTask(mark, { title: "Planned", dueAt: "2026-12-02T10:15", scheduledBy: "planner" })).body.task;
    assert.equal(task.scheduledBy, "planner");
    const moved = (await updateTask(mark, task.id, { dueAt: "2026-12-02T11:00" })).body.task;
    assert.equal(moved.scheduledBy, "person");
    const dayOnly = (await updateTask(mark, task.id, { dueDate: "2026-12-02" })).body.task;
    assert.equal(dayOnly.scheduledBy, null);
  });

  it("leaves the placement alone when an update doesn't change the due time", async () => {
    const task = (await createTask(mark, { title: "Planned and kept", dueAt: "2026-12-02T10:15", scheduledBy: "planner" })).body.task;
    const same = (await updateTask(mark, task.id, { dueAt: "2026-12-02T10:15", title: "Planned and kept, renamed" })).body.task;
    assert.equal(same.scheduledBy, "planner");
    const events = await sql<{ changes: { fields?: string[] } }>("select changes from crm.audit_events where entity_id = $1 and event_type = 'task.updated'", [task.id]);
    assert.deepEqual(events.map((event) => event.changes.fields), [["title"]]);
  });

  it("exports the day, the time and the duration", async () => {
    await createTask(mark, { title: "Exported timed", dueAt: "2026-12-08T09:45", durationMinutes: 45 });
    await createTask(mark, { title: "Exported day", dueDate: "2026-12-08" });
    const exported = await exportTasksCsv(mark);
    assert.deepEqual(exported.rows[0], ["Title", "Company", "Due", "Due time", "Duration", "Priority", "Completed"]);
    const timed = exported.rows.find((row) => row[0] === "Exported timed");
    const day = exported.rows.find((row) => row[0] === "Exported day");
    assert.deepEqual(timed?.slice(2, 5), ["2026-12-08", "09:45", "45"]);
    assert.deepEqual(day?.slice(2, 5), ["2026-12-08", "", "15"]);
  });

  it("undoes Remove the time, bringing back the time and the reminder", async () => {
    const task = (await createTask(mark, { title: "Undo the removal", dueAt: "2026-12-03T15:00", remindMinutes: 30 })).body.task;
    await updateTask(mark, task.id, { dueDate: "2026-12-03" });
    const event = (await sql<{ id: string }>("select id from crm.audit_events where entity_id = $1 and event_type = 'task.updated' order by created_at desc limit 1", [task.id]))[0];
    await undoAuditEvent(mark, event.id, { operation: "undo", source: "web" });
    const back = await getTask(mark, task.id);
    assert.equal(back.dueHasTime, true);
    assert.equal(back.dueAt, "2026-12-03T15:00:00.000Z");
    assert.equal(back.remindMinutes, 30);
    assert.equal(back.scheduledBy, "person");
  });
});

describe("routes that set a day only", () => {
  it("keeps a lead task with a time timed with its reminder, and drops the reminder from a day-only one", async () => {
    const timed = await ingestLead(mark, { contact: { firstName: "Lena", email: "lena@lead.test" }, task: { title: "Call Lena", dueAt: "2026-12-04T15:30", remindMinutes: 15 } });
    assert.equal(timed.body.task?.dueHasTime, true);
    assert.equal(timed.body.task?.dueAt, "2026-12-04T15:30:00.000Z");
    assert.equal(timed.body.task?.remindMinutes, 15);
    const bare = await ingestLead(mark, { contact: { firstName: "Leo", email: "leo@lead.test" }, task: { title: "Call Leo", dueAt: "2026-12-04", remindMinutes: 15 } });
    assert.equal(bare.body.task?.dueDate, "2026-12-04");
    assert.equal(bare.body.task?.dueHasTime, false);
    assert.equal(bare.body.task?.remindMinutes, null);
    const day = await ingestLead(mark, { contact: { firstName: "Lou", email: "lou@lead.test" }, task: { title: "Call Lou", dueDate: "2026-12-05", remindMinutes: 60 } });
    assert.equal(day.body.task?.dueAt, dayStartIso("2026-12-05"));
    assert.equal(day.body.task?.remindMinutes, null);
    await assert.rejects(ingestLead(mark, { contact: { firstName: "Lia", email: "lia@lead.test" }, task: { title: "Call Lia", dueDate: "2026-02-30" } }), /task\.dueDate: enter a real calendar date/);
  });

  it("makes extension tasks date only and ignores an older panel's reminder", async () => {
    const contact = (await createContact(mark, { firstName: "Ezra", email: "ezra@ext.test" })).body.contact;
    const plain = await addTask(mark, { title: "Send Ezra the deck", due: "2026-12-07", contactId: contact.id });
    assert.equal(plain.task.dueDate, "2026-12-07");
    assert.equal(plain.task.dueHasTime, false);
    const reminded = await addTask(mark, { title: "Ring Ezra", due: "2026-12-07", remindMinutes: 60, contactId: contact.id });
    assert.equal(reminded.task.dueHasTime, false);
    assert.equal((await getTask(mark, reminded.task.id)).remindMinutes, null);
  });

});
