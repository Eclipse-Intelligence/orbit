import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { completeTask, createTask, getTask, listDueReminders, updateTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { processTaskReminders, taskReminderPush } from "@/lib/task-reminder-push";
import { createUser, resetDatabase } from "./helpers";

const MINUTE = 60 * 1000;

type Sent = { endpoint: string; title: string; body: string; url: string; tag: string };

function pusher() {
  const sent: Sent[] = [];
  const send: PushSender = async (subscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) });
  };
  return { send, sent };
}

function at(minutes: number, now: number) {
  return new Date(now + minutes * MINUTE).toISOString();
}

async function sentAt(taskId: string) {
  const result = await getAdminPool().query<{ reminder_sent_at: Date | null; updated_at: Date }>(
    "select reminder_sent_at, updated_at from crm.tasks where id = $1",
    [taskId],
  );
  return result.rows[0];
}

function forTask(sent: Sent[], taskId: string) {
  return sent.filter((item) => item.url.includes(taskId));
}

describe("task reminder pushes", () => {
  let owner: UserActor;
  let teammate: UserActor;
  let companyId: string;
  const later = { deadline: () => Date.now() + 30_000 };

  before(async () => {
    await resetDatabase();
    owner = await createUser("reminder-push@orbit.test", "Mark Ridgeon");
    const sam = await createUser("sam-push@orbit.test", "Sam Teammate");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam.userId]);
    teammate = { ...sam, workspaceId: owner.workspaceId, role: "member" };
    companyId = (await createCompany(owner, { name: "Push Co", domain: "push.test" })).body.company.id;
    await savePushSubscription(owner, { endpoint: "https://web.push.apple.com/mark-phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    await savePushSubscription(teammate, { endpoint: "https://web.push.apple.com/sam-phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
  });

  after(async () => {
    await getPool().end();
  });

  it("words the push like the in-app reminder and opens the task", () => {
    const now = Date.parse("2026-10-16T08:50:00.000Z");
    const message = taskReminderPush({ taskId: "abc", title: "Call Ada", dueAt: "2026-10-16T09:00:00.000Z", remindMinutes: 10, about: "Push Co" }, now);
    assert.deepEqual(message, {
      title: "Task due in 10 minutes",
      body: "Call Ada · Push Co",
      url: "/tasks?task=abc",
      tag: "abc:2026-10-16T09:00:00.000Z:10",
    });
  });

  it("pushes a due reminder once to the owner, even when runs overlap", async () => {
    const now = Date.now();
    const task = (await createTask(owner, { title: "Call Ada", companyId, dueAt: at(10, now), remindMinutes: 10 })).body.task;
    const early = pusher();
    await processTaskReminders({ deadline: later.deadline(), now: now - 2 * MINUTE, send: early.send });
    assert.equal(forTask(early.sent, task.id).length, 0);
    assert.equal((await sentAt(task.id)).reminder_sent_at, null);

    const before = (await sentAt(task.id)).updated_at;
    const first = pusher();
    const second = pusher();
    await Promise.all([
      processTaskReminders({ deadline: later.deadline(), now, send: first.send }),
      processTaskReminders({ deadline: later.deadline(), now, send: second.send }),
    ]);
    const pushed = [...forTask(first.sent, task.id), ...forTask(second.sent, task.id)];
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].endpoint, "https://web.push.apple.com/mark-phone");
    assert.equal(pushed[0].title, "Task due in 10 minutes");
    assert.equal(pushed[0].body, "Call Ada · Push Co");
    assert.equal(pushed[0].url, `/tasks?task=${task.id}`);
    const marked = await sentAt(task.id);
    assert.ok(marked.reminder_sent_at);
    assert.equal(marked.updated_at.getTime(), before.getTime());
    assert.equal((await getTask(owner, task.id)).updatedAt, task.updatedAt);

    const again = pusher();
    await processTaskReminders({ deadline: later.deadline(), now: now + MINUTE, send: again.send });
    assert.equal(forTask(again.sent, task.id).length, 0);
  });

  it("pushes again after the time or reminder changes, and not after it is cleared", async () => {
    const now = Date.now();
    const task = (await createTask(owner, { title: "Send the proposal", companyId, dueAt: at(5, now), remindMinutes: 5 })).body.task;
    const first = pusher();
    await processTaskReminders({ deadline: later.deadline(), now, send: first.send });
    assert.equal(forTask(first.sent, task.id).length, 1);

    await updateTask(owner, task.id, { title: "Send the proposal today" });
    assert.ok((await sentAt(task.id)).reminder_sent_at);

    await updateTask(owner, task.id, { dueAt: at(30, now) });
    assert.equal((await sentAt(task.id)).reminder_sent_at, null);
    const moved = pusher();
    await processTaskReminders({ deadline: later.deadline(), now, send: moved.send });
    assert.equal(forTask(moved.sent, task.id).length, 0);
    await processTaskReminders({ deadline: later.deadline(), now: now + 25 * MINUTE, send: moved.send });
    assert.deepEqual(forTask(moved.sent, task.id).map((item) => item.title), ["Task due in 5 minutes"]);

    await updateTask(owner, task.id, { remindMinutes: 30 });
    const widened = pusher();
    await processTaskReminders({ deadline: later.deadline(), now: now + 25 * MINUTE, send: widened.send });
    assert.equal(forTask(widened.sent, task.id).length, 1);

    await updateTask(owner, task.id, { remindMinutes: null });
    const cleared = pusher();
    await processTaskReminders({ deadline: later.deadline(), now: now + 26 * MINUTE, send: cleared.send });
    assert.equal(forTask(cleared.sent, task.id).length, 0);
  });

  it("does not push a completed task", async () => {
    const now = Date.now();
    const task = (await createTask(owner, { title: "Already done", companyId, dueAt: at(10, now), remindMinutes: 15 })).body.task;
    await completeTask(owner, task.id);
    const sent = pusher();
    await processTaskReminders({ deadline: later.deadline(), now, send: sent.send });
    assert.equal(forTask(sent.sent, task.id).length, 0);
  });

  it("skips reminders whose task was due a while ago", async () => {
    const now = Date.now();
    const task = (await createTask(owner, { title: "Long gone", companyId, dueAt: at(-30, now), remindMinutes: 10 })).body.task;
    const sent = pusher();
    await processTaskReminders({ deadline: later.deadline(), now, send: sent.send });
    assert.equal(forTask(sent.sent, task.id).length, 0);
  });

  it("pushes to the assignee, or to the creator when nobody owns the task", async () => {
    const now = Date.now();
    const assigned = (await createTask(teammate, { title: "Sam's call", companyId, dueAt: at(10, now), remindMinutes: 10, ownerId: teammate.userId })).body.task;
    const ownerless = (await createTask(teammate, { title: "Anyone's call", companyId, dueAt: at(10, now), remindMinutes: 10, ownerId: null })).body.task;
    assert.equal(ownerless.ownerId, null);
    const sent = pusher();
    await processTaskReminders({ deadline: later.deadline(), now, send: sent.send });
    assert.deepEqual(forTask(sent.sent, assigned.id).map((item) => item.endpoint), ["https://web.push.apple.com/sam-phone"]);
    assert.deepEqual(forTask(sent.sent, ownerless.id).map((item) => item.endpoint), ["https://web.push.apple.com/sam-phone"]);

    const samSees = await listDueReminders(teammate, new Date(now));
    assert.equal(samSees.find((item) => item.id === assigned.id)?.pushed, true);
    const markSees = await listDueReminders(owner, new Date(now));
    assert.equal(markSees.find((item) => item.id === ownerless.id)?.pushed, false);

    await getAdminPool().query("update crm.tasks set owner_id = $2 where id = $1", [assigned.id, owner.userId]);
    const handed = pusher();
    await processTaskReminders({ deadline: later.deadline(), now: now + MINUTE, send: handed.send });
    assert.deepEqual(forTask(handed.sent, assigned.id).map((item) => item.endpoint), ["https://web.push.apple.com/mark-phone"]);
  });

  it("hands a reminder back when the run is out of time", async () => {
    const now = Date.now();
    const task = (await createTask(owner, { title: "Out of time", companyId, dueAt: at(10, now), remindMinutes: 10 })).body.task;
    const late = pusher();
    await processTaskReminders({ deadline: Date.now() - 1, now, send: late.send });
    assert.equal(forTask(late.sent, task.id).length, 0);
    assert.equal((await sentAt(task.id)).reminder_sent_at, null);
    const next = pusher();
    await processTaskReminders({ deadline: later.deadline(), now: now + MINUTE, send: next.send });
    assert.equal(forTask(next.sent, task.id).length, 1);
  });

  it("claims due reminders from the every-minute cron", async () => {
    await getAdminPool().query("delete from crm.push_subscriptions");
    const now = Date.now();
    const task = (await createTask(owner, { title: "From the cron", companyId, dueAt: at(3, now), remindMinutes: 5 })).body.task;
    const { GET } = await import("@/app/api/cron/mail-due/route");
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-secret-value";
    try {
      const unauthorised = await GET(new Request("https://orbit.example.com/api/cron/mail-due"));
      assert.equal(unauthorised.status, 401);
      assert.equal((await sentAt(task.id)).reminder_sent_at, null);
      const response = await GET(new Request("https://orbit.example.com/api/cron/mail-due", { headers: { authorization: "Bearer cron-secret-value" } }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as { taskReminders: { claimed: number; pushed: number } };
      assert.ok(body.taskReminders.claimed >= 1);
      assert.equal(body.taskReminders.pushed, 0);
      assert.ok((await sentAt(task.id)).reminder_sent_at);
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });
});
