import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CrmError } from "@/lib/crm/errors";
import {
  completeReminder,
  createReminder,
  deleteReminder,
  getReminder,
  getReminderSettings,
  listReminders,
  MOVED_ON,
  NEEDS_DATE_TO_REPEAT,
  NEEDS_DUE_ON,
  NEEDS_TIME_TO_BLOCK,
  PEOPLE_ONLY,
  reopenReminder,
  REOPEN_FIRST,
  setReminderMorning,
  TIME_PASSED,
  TOO_MANY_REMINDERS,
  TOO_MANY_REPEATING,
  updateReminder,
} from "@/lib/crm/reminders";
import { SCOPES } from "@/lib/crm/scopes";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool } from "@/lib/db/pool";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { processReminderPushes } from "@/lib/reminder-push";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const MINUTE = 60_000;
const NOW = Date.parse("2027-01-15T12:00:00Z");

type Sent = { endpoint: string; title: string; body: string; url: string; tag: string };

function pusher() {
  const sent: Sent[] = [];
  const send: PushSender = async (subscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) });
  };
  return { send, sent };
}

async function refused(work: Promise<unknown>, message: string | RegExp, status?: number) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    if (typeof message === "string") assert.equal(error.message, message);
    else assert.match(error.message, message);
    if (status) assert.equal(error.status, status);
    return true;
  });
}

async function wipe(userId: string) {
  await getAdminPool().query("delete from crm.reminders where user_id = $1", [userId]);
  await getAdminPool().query("delete from crm.reminder_settings where user_id = $1", [userId]);
}

describe("reminders", () => {
  let mark: UserActor;
  let sam: UserActor;
  let samHere: UserActor;
  let markThere: UserActor;
  let admin: AgentActor;
  let member: AgentActor;

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark-reminders@orbit.test", "Mark Ridgeon");
    sam = await createUser("sam-reminders@orbit.test", "Sam Teammate");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [mark.workspaceId, sam.userId]);
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [sam.workspaceId, mark.userId]);
    samHere = { ...sam, workspaceId: mark.workspaceId, role: "admin" };
    markThere = { ...mark, workspaceId: sam.workspaceId, role: "member", scopes: SCOPES.filter((scope) => scope !== "admin") };
    admin = (await createAgent(mark.workspaceId, [...SCOPES], "Admin agent")).actor;
    member = (await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Member agent")).actor;
    await savePushSubscription(mark, { endpoint: "https://web.push.apple.com/mark-phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    await savePushSubscription(sam, { endpoint: "https://web.push.apple.com/sam-phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
  });

  after(async () => {
    await getAdminPool().end();
  });

  useServerlessPool();

  describe("privacy", () => {
    it("keeps each person's reminders to themselves, in one workspace and across workspaces", async () => {
      await wipe(mark.userId);
      await wipe(sam.userId);
      const own = (await createReminder(mark, { title: "Renew car tax", dueOn: "2027-01-20" }, { now: NOW })).reminder;
      const theirs = (await createReminder(sam, { title: "Bins out" }, { now: NOW })).reminder;
      assert.deepEqual((await listReminders(mark)).reminders.map((item) => item.id), [own.id]);
      assert.deepEqual((await listReminders(markThere)).reminders.map((item) => item.id), [own.id], "the same list in every workspace");
      assert.deepEqual((await listReminders(sam)).reminders.map((item) => item.id), [theirs.id]);
      const rows = await queryAsUser<{ id: string }>(sam.userId, "select id from crm.reminders");
      assert.deepEqual(rows.map((row) => row.id), [theirs.id]);
    });

    it("gives owners and admins nothing of anyone else's reminders", async () => {
      await wipe(mark.userId);
      const own = (await createReminder(mark, { title: "Book MOT", dueOn: "2027-01-20" }, { now: NOW })).reminder;
      assert.equal((await listReminders(samHere, { includeDone: true })).reminders.some((item) => item.id === own.id), false);
      await refused(getReminder(samHere, own.id), "Reminder not found.", 404);
      await refused(updateReminder(samHere, own.id, { title: "Changed" }, { now: NOW }), "Reminder not found.", 404);
      await refused(completeReminder(samHere, own.id, {}, { now: NOW }), "Reminder not found.", 404);
      await refused(reopenReminder(samHere, own.id), "Reminder not found.", 404);
      assert.deepEqual(await deleteReminder(samHere, own.id), { id: own.id, deleted: false });
      const still = (await getReminder(mark, own.id)).reminder;
      assert.equal(still.title, "Book MOT");
      assert.equal(still.completedAt, null);
      const counted = await queryAsUser<{ count: number }>(sam.userId, "select count(*)::int as count from crm.reminders where user_id = $1", [mark.userId]);
      assert.equal(counted[0].count, 0);
    });

    it("refuses workspace agent tokens, admin ones included, before any scope check", async () => {
      const own = (await createReminder(mark, { title: "Agent proof" }, { now: NOW })).reminder;
      for (const agent of [admin, member, { ...member, scopes: [] }]) {
        await refused(listReminders(agent), PEOPLE_ONLY, 403);
        await refused(getReminder(agent, own.id), PEOPLE_ONLY, 403);
        await refused(createReminder(agent, { title: "Nope" }), PEOPLE_ONLY, 403);
        await refused(updateReminder(agent, own.id, { title: "Nope" }), PEOPLE_ONLY, 403);
        await refused(completeReminder(agent, own.id), PEOPLE_ONLY, 403);
        await refused(reopenReminder(agent, own.id), PEOPLE_ONLY, 403);
        await refused(deleteReminder(agent, own.id), PEOPLE_ONLY, 403);
        await refused(getReminderSettings(agent), PEOPLE_ONLY, 403);
      }
      await refused(listReminders({ ...mark, scopes: [] }), "Missing scope crm:read.", 403);
      await refused(createReminder({ ...mark, scopes: ["crm:read"] }, { title: "Nope" }), "Missing scope tasks:write.", 403);
    });

    it("keeps the definer functions away from signed-in people", async () => {
      for (const sql of [
        "select * from private.claim_reminder_pushes(now(), 10, '{}')",
        "select private.release_reminder_push(gen_random_uuid(), now())",
        "select * from private.claim_morning_reminders(now(), 10)",
        "select private.release_morning_reminders(gen_random_uuid(), current_date)",
      ]) {
        await assert.rejects(queryAsUser(mark.userId, sql), /permission denied/);
      }
    });
  });

  describe("adding and changing", () => {
    it("validates times, blocks and repeats", async () => {
      await wipe(mark.userId);
      await refused(createReminder(mark, { title: "  " }, { now: NOW }), "Enter a reminder.");
      await refused(createReminder(mark, { title: "Late", dueAt: "2027-01-15T11:00" }, { now: NOW }), TIME_PASSED);
      await refused(createReminder(mark, { title: "Block", dueOn: "2027-01-20", blocksTime: true }, { now: NOW }), NEEDS_TIME_TO_BLOCK);
      await refused(createReminder(mark, { title: "Repeat", repeat: { every: "week" } }, { now: NOW }), NEEDS_DATE_TO_REPEAT);
      await refused(createReminder(mark, { title: "Both", dueOn: "2027-01-20", dueAt: "2027-01-20T10:00" }, { now: NOW }), /not both/);
      const timed = (await createReminder(mark, { title: "Washing machine repair", dueAt: "2027-01-20T10:00", blocksTime: true, durationMinutes: 60 }, { now: NOW })).reminder;
      assert.equal(timed.dueOn, "2027-01-20");
      assert.equal(timed.time, "10:00");
      assert.equal(timed.blocksTime, true);
      const moved = (await updateReminder(mark, timed.id, { dueOn: "2027-01-22" }, { now: NOW })).reminder;
      assert.equal(moved.dueAt, "2027-01-22T10:00:00.000Z", "a new day keeps the time");
      const dateOnly = (await updateReminder(mark, timed.id, { dueAt: null }, { now: NOW })).reminder;
      assert.equal(dateOnly.dueOn, "2027-01-22");
      assert.equal(dateOnly.dueAt, null);
      assert.equal(dateOnly.blocksTime, false, "Block time goes with the time");
      await refused(updateReminder(mark, timed.id, { blocksTime: true }, { now: NOW }), NEEDS_TIME_TO_BLOCK);
      const past = (await updateReminder(mark, timed.id, { dueAt: "2027-01-10T09:00" }, { now: NOW })).reminder;
      assert.equal(past.dueOn, "2027-01-10", "only a new timed reminder is refused for a passed time");
      await completeReminder(mark, timed.id, {}, { now: NOW });
      await refused(updateReminder(mark, timed.id, { title: "Changed" }, { now: NOW }), REOPEN_FIRST);
      assert.equal((await reopenReminder(mark, timed.id)).reminder.completedAt, null);
    });

    it("snaps a repeat to its pattern and moves it from then on when the date changes", async () => {
      await wipe(mark.userId);
      const weekly = (await createReminder(mark, { title: "Bins out", dueOn: "2027-01-19", repeat: { every: "week", days: ["th"] } }, { now: NOW })).reminder;
      assert.equal(weekly.dueOn, "2027-01-21", "Tuesday snaps to the next Thursday");
      assert.match(weekly.repeatText ?? "", /^Every Thursday/);
      const friday = (await updateReminder(mark, weekly.id, { dueOn: "2027-01-22" }, { now: NOW })).reminder;
      assert.equal(friday.dueOn, "2027-01-22");
      assert.deepEqual(friday.repeat, { every: "week", days: ["fr"], ends: null });
      await refused(updateReminder(mark, weekly.id, { dueOn: null }, { now: NOW }), NEEDS_DATE_TO_REPEAT);
      const plain = (await updateReminder(mark, weekly.id, { dueOn: null, repeat: null }, { now: NOW })).reminder;
      assert.equal(plain.repeat, null);
      assert.equal(plain.dueOn, null);
    });

    it("puts a time just after London midnight on the London day", async () => {
      await wipe(mark.userId);
      const summer = (await createReminder(mark, { title: "Night shift", dueAt: "2027-06-30T23:30:00Z" }, { now: NOW })).reminder;
      assert.equal(summer.dueOn, "2027-07-01");
      assert.equal(summer.time, "00:30");
      const winter = (await createReminder(mark, { title: "Late call", dueAt: "2027-01-20T23:30:00Z" }, { now: NOW })).reminder;
      assert.equal(winter.dueOn, "2027-01-20");
      const midnight = (await createReminder(mark, { title: "Midnight", dueAt: "2027-07-01T00:00" }, { now: NOW })).reminder;
      assert.equal(midnight.dueAt, "2027-06-30T23:00:00.000Z");
      assert.equal(midnight.dueOn, "2027-07-01");
    });

    it("stops at 500 open reminders and 200 repeating ones", async () => {
      await wipe(mark.userId);
      await getAdminPool().query(
        "insert into crm.reminders (user_id, title, due_on, repeat_rule, repeat_ends) select $1, 'Filler ' || n, '2027-01-20', $2, $3 from generate_series(1, 200) n",
        [mark.userId, { freq: "daily", interval: 1 }, { never: true }],
      );
      await refused(createReminder(mark, { title: "One more", dueOn: "2027-01-20", repeat: { every: "day" } }, { now: NOW }), TOO_MANY_REPEATING);
      const plain = (await createReminder(mark, { title: "Plain", dueOn: "2027-01-20" }, { now: NOW })).reminder;
      await refused(updateReminder(mark, plain.id, { repeat: { every: "day" } }, { now: NOW }), TOO_MANY_REPEATING);
      await getAdminPool().query("insert into crm.reminders (user_id, title) select $1, 'Filler ' || n from generate_series(1, 299) n", [mark.userId]);
      await refused(createReminder(mark, { title: "Too many" }, { now: NOW }), TOO_MANY_REMINDERS);
      await completeReminder(mark, plain.id, {}, { now: NOW });
      const room = (await createReminder(mark, { title: "Room again" }, { now: NOW })).reminder;
      await refused(reopenReminder(mark, plain.id), TOO_MANY_REMINDERS);
      assert.equal((await createReminder(sam, { title: "Sam is separate" }, { now: NOW })).reminder.title, "Sam is separate");
      await deleteReminder(mark, room.id);
      await wipe(mark.userId);
    });
  });

  describe("ticking", () => {
    it("ticks a repeating reminder to its next date and undoes it", async () => {
      await wipe(mark.userId);
      const bins = (await createReminder(mark, { title: "Bins out", dueOn: "2027-01-21", repeat: { every: "week" } }, { now: NOW })).reminder;
      await refused(completeReminder(mark, bins.id, {}, { now: NOW }), NEEDS_DUE_ON);
      const ticked = await completeReminder(mark, bins.id, { dueOn: "2027-01-21" }, { now: NOW });
      assert.equal(ticked.changed, true);
      assert.equal(ticked.reminder.dueOn, "2027-01-28");
      assert.equal(ticked.reminder.completedAt, null);
      assert.ok(ticked.doneId && ticked.doneId !== bins.id);
      const copy = (await getReminder(mark, ticked.doneId!)).reminder;
      assert.equal(copy.dueOn, "2027-01-21");
      assert.equal(copy.repeatOf, bins.id);
      assert.equal(copy.movedTo, "2027-01-28");
      assert.ok(copy.completedAt);
      assert.equal(copy.repeat, null);
      const done = (await listReminders(mark, { includeDone: true })).reminders.filter((item) => item.completedAt);
      assert.deepEqual(done.map((item) => item.id), [copy.id]);
      await refused(updateReminder(mark, copy.id, { title: "Changed" }), REOPEN_FIRST);
      assert.equal((await completeReminder(mark, copy.id, { dueOn: "2027-01-21" }, { now: NOW })).changed, false, "ticking a done copy does nothing");
      const undone = await reopenReminder(mark, copy.id);
      assert.equal(undone.reminder.id, bins.id);
      assert.equal(undone.reminder.dueOn, "2027-01-21");
      await refused(getReminder(mark, copy.id), "Reminder not found.", 404);
    });

    it("refuses to undo once the reminder has moved on, and reopens a copy whose reminder was deleted", async () => {
      await wipe(mark.userId);
      const bins = (await createReminder(mark, { title: "Bins out", dueOn: "2027-01-21", repeat: { every: "week" } }, { now: NOW })).reminder;
      const first = await completeReminder(mark, bins.id, { dueOn: "2027-01-21" }, { now: NOW });
      const second = await completeReminder(mark, bins.id, { dueOn: "2027-01-28" }, { now: NOW });
      assert.equal(second.reminder.dueOn, "2027-02-04");
      await refused(reopenReminder(mark, first.doneId!), MOVED_ON, 409);
      const back = await reopenReminder(mark, second.doneId!);
      assert.equal(back.reminder.dueOn, "2027-01-28");
      const backAgain = await reopenReminder(mark, first.doneId!);
      assert.equal(backAgain.reminder.dueOn, "2027-01-21", "undoing in turn walks back one date at a time");
      const third = await completeReminder(mark, bins.id, { dueOn: "2027-01-21" }, { now: NOW });
      const moved = (await updateReminder(mark, bins.id, { dueOn: "2027-01-29" }, { now: NOW })).reminder;
      assert.equal(moved.dueOn, "2027-01-29");
      await refused(reopenReminder(mark, third.doneId!), MOVED_ON, 409);
      assert.deepEqual(await deleteReminder(mark, bins.id), { id: bins.id, deleted: true });
      const orphan = (await getReminder(mark, third.doneId!)).reminder;
      assert.equal(orphan.repeatOf, null, "done copies are kept");
      const reopened = (await reopenReminder(mark, orphan.id)).reminder;
      assert.equal(reopened.completedAt, null);
      assert.equal(reopened.movedTo, null);
      assert.equal(reopened.dueOn, "2027-01-21");
    });

    it("never skips a date on a double tick, a retry or a stale tab", async () => {
      await wipe(mark.userId);
      const daily = (await createReminder(mark, { title: "Water plants", dueOn: "2027-01-16", repeat: { every: "day" } }, { now: NOW })).reminder;
      const [one, two] = await Promise.all([
        completeReminder(mark, daily.id, { dueOn: "2027-01-16" }, { now: NOW }),
        completeReminder(mark, daily.id, { dueOn: "2027-01-16" }, { now: NOW }),
      ]);
      assert.deepEqual([one.changed, two.changed].sort(), [false, true]);
      assert.equal((await getReminder(mark, daily.id)).reminder.dueOn, "2027-01-17");
      const retry = await completeReminder(mark, daily.id, { dueOn: "2027-01-16" }, { now: NOW });
      assert.equal(retry.changed, false);
      assert.equal(retry.doneId, null);
      assert.equal(retry.reminder.dueOn, "2027-01-17");
      const plain = (await createReminder(mark, { title: "Call the vet" }, { now: NOW })).reminder;
      assert.equal((await completeReminder(mark, plain.id, {}, { now: NOW })).changed, true);
      const again = await completeReminder(mark, plain.id, {}, { now: NOW });
      assert.equal(again.changed, false);
      const copies = await getAdminPool().query("select count(*)::int as count from crm.reminders where repeat_of = $1", [daily.id]);
      assert.equal(copies.rows[0].count, 1);
    });

    it("rolls a missed repeat forward past today", async () => {
      await wipe(mark.userId);
      const daily = (await createReminder(mark, { title: "Stretch", dueOn: "2027-01-10", repeat: { every: "day" } }, { now: NOW })).reminder;
      const ticked = await completeReminder(mark, daily.id, { dueOn: "2027-01-10" }, { now: NOW });
      assert.equal(ticked.reminder.dueOn, "2027-01-16", "the day after today, not the day after the missed date");
    });

    it("ends after n times and reopens the last one", async () => {
      await wipe(mark.userId);
      const three = (await createReminder(mark, { title: "Take pills", dueOn: "2027-01-16", repeat: { every: "day", ends: { after: 3 } } }, { now: NOW })).reminder;
      assert.deepEqual(three.repeat?.ends, { after: 3 });
      const first = await completeReminder(mark, three.id, { dueOn: "2027-01-16" }, { now: NOW });
      assert.deepEqual(first.reminder.repeat?.ends, { after: 2 });
      await completeReminder(mark, three.id, { dueOn: "2027-01-17" }, { now: NOW });
      const last = await completeReminder(mark, three.id, { dueOn: "2027-01-18" }, { now: NOW });
      assert.equal(last.doneId, three.id, "the last time completes the reminder itself");
      assert.ok(last.reminder.completedAt);
      assert.equal(last.reminder.dueOn, "2027-01-18");
      const copies = await getAdminPool().query("select count(*)::int as count from crm.reminders where repeat_of = $1", [three.id]);
      assert.equal(copies.rows[0].count, 2);
      const reopened = (await reopenReminder(mark, three.id)).reminder;
      assert.equal(reopened.completedAt, null);
      assert.deepEqual(reopened.repeat?.ends, { after: 1 });
      const until = (await createReminder(mark, { title: "Until Monday", dueOn: "2027-01-16", repeat: { every: "day", ends: { on: "2027-01-17" } } }, { now: NOW })).reminder;
      await completeReminder(mark, until.id, { dueOn: "2027-01-16" }, { now: NOW });
      const ended = await completeReminder(mark, until.id, { dueOn: "2027-01-17" }, { now: NOW });
      assert.ok(ended.reminder.completedAt);
    });

    it("keeps the clock time across the clocks going forward and back", async () => {
      await wipe(mark.userId);
      const spring = Date.parse("2027-03-27T12:00:00Z");
      const morning = (await createReminder(mark, { title: "Vitamins", dueAt: "2027-03-27T09:00", repeat: { every: "day" } }, { now: Date.parse("2027-03-27T06:00:00Z") })).reminder;
      assert.equal(morning.dueAt, "2027-03-27T09:00:00.000Z");
      const summer = await completeReminder(mark, morning.id, { dueOn: "2027-03-27" }, { now: spring });
      assert.equal(summer.reminder.dueOn, "2027-03-28");
      assert.equal(summer.reminder.dueAt, "2027-03-28T08:00:00.000Z");
      assert.equal(summer.reminder.time, "09:00");
      const autumn = (await createReminder(mark, { title: "Run", dueAt: "2027-10-30T07:30", repeat: { every: "day" } }, { now: Date.parse("2027-10-30T05:00:00Z") })).reminder;
      assert.equal(autumn.dueAt, "2027-10-30T06:30:00.000Z");
      const winter = await completeReminder(mark, autumn.id, { dueOn: "2027-10-30" }, { now: Date.parse("2027-10-30T12:00:00Z") });
      assert.equal(winter.reminder.dueAt, "2027-10-31T07:30:00.000Z");
      assert.equal(winter.reminder.time, "07:30");
      const undone = await reopenReminder(mark, summer.doneId!);
      assert.equal(undone.reminder.dueAt, "2027-03-27T09:00:00.000Z");
    });
  });

  describe("pushes", () => {
    it("pushes a timed reminder once per time, and again after it moves", async () => {
      await wipe(mark.userId);
      await wipe(sam.userId);
      const repair = (await createReminder(mark, { title: "Washing machine repair", dueAt: "2027-01-20T10:00" }, { now: NOW })).reminder;
      const at = Date.parse(repair.dueAt!);
      const early = pusher();
      await processReminderPushes({ deadline: Date.now() + 30_000, now: at - MINUTE, send: early.send });
      assert.equal(early.sent.length, 0);
      const before = await getAdminPool().query<{ updated_at: Date }>("select updated_at from crm.reminders where id = $1", [repair.id]);
      const [first, second] = [pusher(), pusher()];
      await Promise.all([
        processReminderPushes({ deadline: Date.now() + 30_000, now: at + MINUTE, send: first.send }),
        processReminderPushes({ deadline: Date.now() + 30_000, now: at + MINUTE, send: second.send }),
      ]);
      const sent = [...first.sent, ...second.sent];
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0], {
        endpoint: "https://web.push.apple.com/mark-phone",
        title: "Washing machine repair",
        body: "10:00",
        url: "/?reminders=open",
        tag: `reminder:${repair.id}:${repair.dueAt}`,
        badge: null,
      });
      const afterClaim = await getAdminPool().query<{ updated_at: Date; pushed_for: Date }>("select updated_at, pushed_for from crm.reminders where id = $1", [repair.id]);
      assert.equal(afterClaim.rows[0].updated_at.toISOString(), before.rows[0].updated_at.toISOString(), "a claim doesn't touch updated_at");
      assert.equal(afterClaim.rows[0].pushed_for.toISOString(), repair.dueAt);
      const again = pusher();
      await processReminderPushes({ deadline: Date.now() + 30_000, now: at + 2 * MINUTE, send: again.send });
      assert.equal(again.sent.length, 0);
      const moved = (await updateReminder(mark, repair.id, { dueAt: "2027-01-20T11:00" }, { now: NOW })).reminder;
      const late = pusher();
      await processReminderPushes({ deadline: Date.now() + 30_000, now: Date.parse(moved.dueAt!) + 10 * MINUTE, send: late.send });
      assert.equal(late.sent.length, 0, "more than five minutes late is not pushed");
      const moveAgain = (await updateReminder(mark, repair.id, { dueAt: "2027-01-20T12:00" }, { now: NOW })).reminder;
      const onTime = pusher();
      await processReminderPushes({ deadline: Date.now() + 30_000, now: Date.parse(moveAgain.dueAt!), send: onTime.send });
      assert.equal(onTime.sent.length, 1);
      await completeReminder(mark, repair.id, {}, { now: NOW });
    });

    it("releases a push that failed so the next run tries again", async () => {
      await wipe(mark.userId);
      const call = (await createReminder(mark, { title: "Call the garage", dueAt: "2027-01-21T09:00" }, { now: NOW })).reminder;
      const at = Date.parse(call.dueAt!);
      const failing: PushSender = async () => {
        throw Object.assign(new Error("down"), { statusCode: 503 });
      };
      await processReminderPushes({ deadline: Date.now() + 30_000, now: at, send: failing });
      const row = await getAdminPool().query<{ pushed_for: Date | null }>("select pushed_for from crm.reminders where id = $1", [call.id]);
      assert.equal(row.rows[0].pushed_for, null);
      const retry = pusher();
      await processReminderPushes({ deadline: Date.now() + 30_000, now: at + MINUTE, send: retry.send });
      assert.equal(retry.sent.length, 1);
    });

    it("sends the morning list once, skips an empty day, and skips more than an hour late", async () => {
      await wipe(mark.userId);
      await wipe(sam.userId);
      await createReminder(mark, { title: "Bins out", dueOn: "2027-01-15" }, { now: NOW - 6 * 60 * MINUTE });
      await createReminder(mark, { title: "Renew car tax", dueOn: "2027-01-15" }, { now: NOW - 6 * 60 * MINUTE });
      await createReminder(mark, { title: "Overdue", dueOn: "2027-01-14" }, { now: NOW - 6 * 60 * MINUTE });
      await createReminder(mark, { title: "Timed", dueAt: "2027-01-15T15:00" }, { now: NOW - 6 * 60 * MINUTE });
      await createReminder(mark, { title: "Tomorrow", dueOn: "2027-01-16" }, { now: NOW - 6 * 60 * MINUTE });
      await createReminder(sam, { title: "Sam's day is tomorrow", dueOn: "2027-01-16" }, { now: NOW - 6 * 60 * MINUTE });
      const early = pusher();
      await processReminderPushes({ deadline: Date.now() + 30_000, now: Date.parse("2027-01-15T07:59:00Z"), send: early.send });
      assert.equal(early.sent.length, 0);
      const [first, second] = [pusher(), pusher()];
      await Promise.all([
        processReminderPushes({ deadline: Date.now() + 30_000, now: Date.parse("2027-01-15T08:05:00Z"), send: first.send }),
        processReminderPushes({ deadline: Date.now() + 30_000, now: Date.parse("2027-01-15T08:05:00Z"), send: second.send }),
      ]);
      const sent = [...first.sent, ...second.sent];
      assert.equal(sent.length, 1, "once, and nothing for Sam's empty day");
      assert.equal(sent[0].endpoint, "https://web.push.apple.com/mark-phone");
      assert.equal(sent[0].title, "2 reminders today");
      assert.equal(sent[0].body, "Bins out, Renew car tax");
      assert.equal(sent[0].url, "/?reminders=open");
      const again = pusher();
      await processReminderPushes({ deadline: Date.now() + 30_000, now: Date.parse("2027-01-15T08:30:00Z"), send: again.send });
      assert.equal(again.sent.length, 0);
      const tomorrowLate = pusher();
      await processReminderPushes({ deadline: Date.now() + 30_000, now: Date.parse("2027-01-16T09:01:00Z"), send: tomorrowLate.send });
      assert.equal(tomorrowLate.sent.length, 0, "more than an hour after the morning time");
    });

    it("uses the person's own morning time, on the London day", async () => {
      await wipe(mark.userId);
      await setReminderMorning(mark, "06:30");
      assert.deepEqual(await getReminderSettings(markThere), { morningAt: "06:30" });
      await refused(setReminderMorning(mark, "25:00"), "Choose a time, such as 08:00.");
      await createReminder(mark, { title: "Summer list", dueOn: "2027-07-01" }, { now: NOW });
      const utcEarly = pusher();
      await processReminderPushes({ deadline: Date.now() + 30_000, now: Date.parse("2027-07-01T05:35:00Z"), send: utcEarly.send });
      assert.equal(utcEarly.sent.length, 1, "06:35 London in summer is 05:35 UTC");
      assert.equal(utcEarly.sent[0].title, "1 reminder today");
      await wipe(mark.userId);
      await setReminderMorning(mark, "00:00");
      await createReminder(mark, { title: "Midnight list", dueOn: "2027-07-02" }, { now: NOW });
      const midnight = pusher();
      await processReminderPushes({ deadline: Date.now() + 30_000, now: Date.parse("2027-07-01T23:10:00Z"), send: midnight.send });
      assert.equal(midnight.sent.length, 1, "23:10 UTC on 1 July is 00:10 on 2 July in London");
      assert.equal(midnight.sent[0].body, "Midnight list");
      await wipe(mark.userId);
    });
  });
});
