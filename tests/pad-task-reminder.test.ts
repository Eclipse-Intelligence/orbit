import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { CrmError } from "@/lib/crm/errors";
import { addPadTask, REMINDER_NOT_REMOVED } from "@/lib/crm/pad-task";
import { createReminder, deleteReminder, getReminder } from "@/lib/crm/reminders";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool } from "@/lib/db/pool";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

async function tasksTitled(title: string) {
  const result = await getAdminPool().query<{ id: string; due_has_time: boolean; due_at: Date | null; duration_minutes: number; owner_id: string }>(
    "select id, due_has_time, due_at, duration_minutes, owner_id from crm.tasks where title = $1",
    [title],
  );
  return result.rows;
}

async function gone(actor: UserActor, id: string) {
  await assert.rejects(getReminder(actor, id), (error: unknown) => error instanceof CrmError && error.status === 404);
}

describe("Turn into task", () => {
  let mark: UserActor;
  let sam: UserActor;

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark-turn@orbit.test", "Mark Ridgeon");
    sam = await createUser("sam-turn@orbit.test", "Sam Teammate");
  });

  after(async () => {
    await getAdminPool().end();
  });

  useServerlessPool();

  it("saves the task, then removes the reminder", async () => {
    const { reminder } = await createReminder(mark, { title: "Washing machine repair", dueOn: "2030-03-04" });
    const result = await addPadTask(mark, { title: "Washing machine repair", dueAt: "2030-03-04", remindMinutes: null, clickupListId: null, durationMinutes: 30, key: randomUUID(), fromReminderId: reminder.id });
    assert.deepEqual(result, { ok: true });
    const tasks = await tasksTitled("Washing machine repair");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].due_has_time, false);
    assert.ok(tasks[0].due_at);
    assert.equal(tasks[0].owner_id, mark.userId);
    await gone(mark, reminder.id);
  });

  it("carries a reminder's link into the task description as a markdown link, and leaves other tasks alone", async () => {
    const link = "/chat/6b77a718-65ec-4679-9420-bd40ecdc4ffb?thread=43d4e049-9fd7-4dee-80ac-dddbca518bad";
    const { reminder } = await createReminder(mark, { title: "Chat message from Lena", dueOn: "2030-03-06" }, { link });
    await addPadTask(mark, { title: "Chat message from Lena", dueAt: "2030-03-06", remindMinutes: null, clickupListId: null, key: randomUUID(), fromReminderId: reminder.id });
    const description = async (title: string) => (await getAdminPool().query<{ description: string | null }>("select description from crm.tasks where title = $1", [title])).rows[0].description;
    assert.equal(await description("Chat message from Lena"), `[Open message](${link})`);
    await gone(mark, reminder.id);

    const plain = await createReminder(mark, { title: "Plain reminder", dueOn: "2030-03-06" });
    await addPadTask(mark, { title: "Plain reminder", dueAt: "2030-03-06", remindMinutes: null, clickupListId: null, key: randomUUID(), fromReminderId: plain.reminder.id });
    assert.equal(await description("Plain reminder"), null);
    await addPadTask(mark, { title: "No reminder at all", dueAt: "2030-03-06", remindMinutes: null, clickupListId: null, key: randomUUID() });
    assert.equal(await description("No reminder at all"), null);

    const awkward = await createReminder(mark, { title: "Awkward link" }, { link: "/chat/x?a=(b)" });
    await addPadTask(mark, { title: "Awkward link", dueAt: null, remindMinutes: null, clickupListId: null, key: randomUUID(), fromReminderId: awkward.reminder.id });
    assert.equal(await description("Awkward link"), "[Open message](/chat/x?a=%28b%29)");

    const theirs = await createReminder(sam, { title: "Sam's link" }, { link: "/chat/secret?message=1" });
    await addPadTask(mark, { title: "Not Sam's", dueAt: null, remindMinutes: null, clickupListId: null, key: randomUUID(), fromReminderId: theirs.reminder.id });
    assert.equal(await description("Not Sam's"), null);
  });

  it("keeps the task when the reminder can't be removed, and Try again with the same key only removes it", async () => {
    const { reminder } = await createReminder(mark, { title: "Book flights", dueOn: "2030-03-05" });
    const key = randomUUID();
    const input = { title: "Book flights", dueAt: "2030-03-05T10:00:00.000Z", remindMinutes: null, clickupListId: null, durationMinutes: 45, key, fromReminderId: reminder.id };
    const failing = await addPadTask(mark, input, {
      removeReminder: async () => {
        throw new Error("connection reset");
      },
    });
    assert.deepEqual(failing, { ok: true, reminderError: REMINDER_NOT_REMOVED });
    assert.equal((await tasksTitled("Book flights")).length, 1);
    assert.equal((await getReminder(mark, reminder.id)).reminder.title, "Book flights");

    const retried = await addPadTask(mark, input);
    assert.deepEqual(retried, { ok: true });
    const tasks = await tasksTitled("Book flights");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].duration_minutes, 45);
    assert.equal(tasks[0].due_at?.toISOString(), "2030-03-05T10:00:00.000Z");
    await gone(mark, reminder.id);
  });

  it("counts a reminder already gone as removed", async () => {
    const { reminder } = await createReminder(mark, { title: "Renew car tax" });
    await deleteReminder(mark, reminder.id);
    const result = await addPadTask(mark, { title: "Renew car tax", dueAt: null, remindMinutes: null, clickupListId: null, key: randomUUID(), fromReminderId: reminder.id });
    assert.deepEqual(result, { ok: true });
    assert.equal((await tasksTitled("Renew car tax")).length, 1);
  });

  it("never removes someone else's reminder", async () => {
    const { reminder } = await createReminder(sam, { title: "Sam's dentist" });
    const result = await addPadTask(mark, { title: "Sam's dentist", dueAt: null, remindMinutes: null, clickupListId: null, key: randomUUID(), fromReminderId: reminder.id });
    assert.deepEqual(result, { ok: true });
    assert.equal((await getReminder(sam, reminder.id)).reminder.title, "Sam's dentist");
  });

  it("leaves the reminder when the task fails", async () => {
    const { reminder } = await createReminder(mark, { title: "Call Mum back" });
    await assert.rejects(addPadTask(mark, { title: "", dueAt: null, remindMinutes: null, clickupListId: null, key: randomUUID(), fromReminderId: reminder.id }));
    assert.equal((await getReminder(mark, reminder.id)).reminder.title, "Call Mum back");
  });

  it("adds a reminder once when the add line retries with the same key", async () => {
    const key = randomUUID();
    const first = await createReminder(mark, { title: "Retried reminder", dueOn: "2030-03-06" }, { idempotencyKey: key });
    const again = await createReminder(mark, { title: "Retried reminder", dueOn: "2030-03-06" }, { idempotencyKey: key });
    assert.equal(again.reminder.id, first.reminder.id);
    const rows = await getAdminPool().query("select id from crm.reminders where title = 'Retried reminder'");
    assert.equal(rows.rowCount, 1);
  });

  it("adds a task without a reminder exactly as before", async () => {
    const result = await addPadTask(mark, { title: "Plain task", dueAt: null, remindMinutes: null, clickupListId: null, key: randomUUID() });
    assert.deepEqual(result, { ok: true });
    assert.equal((await tasksTitled("Plain task")).length, 1);
  });
});
