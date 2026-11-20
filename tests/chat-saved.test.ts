import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { POST as restCreate } from "@/app/api/v1/reminders/route";
import { savedPlace } from "@/lib/chat/saved";
import { chatLocationHref, chatSegments, parseChatLocation } from "@/lib/chat/routes";
import { createPersonalToken } from "@/lib/auth/personal";
import { addRoomMembers, chatWorkSettled, createRoom, deleteMessage, openDiscussion, openDm, postMessage, removeRoomMember } from "@/lib/crm/chat";
import { listSaved, listSavedIds, remindAboutMessage, setMessageSaved } from "@/lib/crm/chat-saved";
import { createCompany } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { readReminderInput } from "@/lib/crm/reminder-input";
import { isReminderLink } from "@/lib/crm/reminder-link";
import { completeReminder, createReminder, getReminder, listReminders } from "@/lib/crm/reminders";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, queryAsUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

const MIGRATION = "20270227110000_chat_saved.sql";

async function sql(text: string, values: unknown[] = []) {
  return getAdminPool().query(text, values);
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

async function join(user: UserActor, workspaceId: string, role: "member" | "admin" = "member") {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [workspaceId, user.userId, role]);
  return { ...user, workspaceId, role };
}

async function savedIds(actor: UserActor) {
  return (await listSavedIds(actor)).ids;
}

async function listed(actor: UserActor) {
  return (await listSaved(actor)).items.map((item) => item.message.id);
}

describe("saved routes and labels", () => {
  it("opens Saved at /chat/saved and labels where a message lives", () => {
    assert.deepEqual(chatSegments(["saved"]), { kind: "saved" });
    assert.equal(chatLocationHref({ view: { kind: "saved" } }), "/chat/saved");
    assert.deepEqual(parseChatLocation("/chat/saved", ""), { view: { kind: "saved" }, thread: null, message: null });
    assert.equal(savedPlace({ id: "1", kind: "room", name: "sales" }), "#sales");
    assert.equal(savedPlace({ id: "1", kind: "dm", name: "Sam Okafor" }), "Sam Okafor");
    assert.equal(savedPlace({ id: "1", kind: "task", name: "Send pricing" }), "Task: Send pricing");
    assert.equal(savedPlace({ id: "1", kind: "task", name: "" }), "Task");
    assert.equal(savedPlace({ id: "1", kind: "doc", name: "Pricing review" }), "Doc: Pricing review");
    assert.equal(savedPlace({ id: "1", kind: "mail_thread", name: "" }), "Shared email");
  });

  it("accepts only paths inside Orbit as a reminder link", () => {
    for (const good of ["/chat/abc?message=1", "/chat/abc?thread=2", "/tasks?task=1", "/mail?shared=1&notes=1", "/docs/1?discussion=1"]) assert.equal(isReminderLink(good), true, good);
    for (const bad of ["", "/", "chat/abc", "//evil.test", "/\\evil.test", "https://evil.test/x", "javascript:alert(1)", "/a b", "/a\nb", "/a\u0000b", `/${"a".repeat(500)}`, null, 4, undefined]) {
      assert.equal(isReminderLink(bad), false, String(bad));
    }
  });
});

describe("the saved ids store", () => {
  it("retries a failed load instead of staying wrong, and keeps marks made meanwhile", async () => {
    const { useChatSaved } = await import("@/stores/chat-saved-store");
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return new Response(JSON.stringify({ ids: ["a", "b"] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
      useChatSaved.getState().load();
      await settled();
      assert.equal(useChatSaved.getState().loaded, false);
      assert.equal(useChatSaved.getState().loading, false);
      useChatSaved.getState().load();
      useChatSaved.getState().mark("c", true);
      useChatSaved.getState().mark("a", false);
      await settled();
      assert.equal(calls, 2);
      assert.equal(useChatSaved.getState().loaded, true);
      assert.deepEqual([...useChatSaved.getState().ids].sort(), ["b", "c"]);
      useChatSaved.getState().load();
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("saved messages", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let ada: UserActor;
  let olly: UserActor;
  let room: string;

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@saved.test", "Mark Ridgeon");
    sam = await join(await createUser("sam@saved.test", "Sam Okafor"), mark.workspaceId);
    priya = await join(await createUser("priya@saved.test", "Priya Nair"), mark.workspaceId);
    ada = await join(await createUser("ada@saved.test", "Ada Admin"), mark.workspaceId, "admin");
    olly = await createUser("olly@elsewhere.test", "Olly Outside");
    room = (await createRoom(mark, { name: "sales", memberIds: [sam.userId] })).id;
  });

  after(async () => {
    await chatWorkSettled();
    await getPool().end();
    await getAdminPool().end();
  });

  describe("on the serverless pool", () => {
    useServerlessPool();

    it("saves a message once, however many times, and unsaves it", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Acme signed" });
      assert.deepEqual(await setMessageSaved(mark, message.id, true), { messageId: message.id, saved: true });
      assert.deepEqual(await setMessageSaved(mark, message.id, true), { messageId: message.id, saved: true });
      assert.equal((await sql("select count(*)::int as n from crm.chat_saved where user_id = $1 and message_id = $2", [mark.userId, message.id])).rows[0].n, 1);
      assert.deepEqual(await savedIds(mark), [message.id]);
      assert.deepEqual(await setMessageSaved(mark, message.id, false), { messageId: message.id, saved: false });
      assert.deepEqual(await setMessageSaved(mark, message.id, false), { messageId: message.id, saved: false });
      assert.deepEqual(await savedIds(mark), []);
      assert.deepEqual(await listed(mark), []);
    });

    it("lists saved messages newest saved first with where they were said, and pages with a cursor", async () => {
      const first = (await postMessage(sam, { conversationId: room, body: "First" })).message;
      const second = (await postMessage(mark, { conversationId: room, body: "Second" })).message;
      const root = (await postMessage(sam, { conversationId: room, body: "Root" })).message;
      const reply = (await postMessage(mark, { conversationId: room, parentId: root.id, body: "In the thread" })).message;
      for (const message of [second, first, reply]) await setMessageSaved(mark, message.id, true);
      const page = await listSaved(mark);
      assert.deepEqual(
        page.items.map((item) => item.message.body),
        ["In the thread", "First", "Second"],
      );
      assert.equal(page.items[0].message.parentId, root.id);
      assert.deepEqual(page.items[0].conversation, { id: room, kind: "room", name: "sales" });
      assert.equal(page.items[0].subject, null);
      assert.equal(page.next, null);
      assert.match(page.items[0].savedAt, /^\d{4}-\d{2}-\d{2}T/);
      const one = await listSaved(mark, { limit: 2 });
      assert.deepEqual(
        one.items.map((item) => item.message.body),
        ["In the thread", "First"],
      );
      assert.ok(one.next);
      const rest = await listSaved(mark, { limit: 2, cursor: one.next });
      assert.deepEqual(
        rest.items.map((item) => item.message.body),
        ["Second"],
      );
      assert.equal(rest.next, null);
      await refused(listSaved(mark, { cursor: "not-a-cursor" }), /isn't valid/);
      await sql("delete from crm.chat_saved");
    });

    it("keeps saved rows to their owner: teammates, admins and the workspace owner see none", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Pricing agreed" });
      await setMessageSaved(sam, message.id, true);
      await setMessageSaved(mark, message.id, true);
      for (const outsider of [priya, ada, olly]) {
        assert.deepEqual(await savedIds(outsider), []);
        assert.deepEqual(await listed(outsider), []);
      }
      assert.deepEqual(await savedIds(sam), [message.id]);
      for (const person of [sam, mark, priya, ada, olly]) {
        const seen = await queryAsUser<{ user_id: string }>(person.userId, "select user_id from crm.chat_saved");
        assert.deepEqual(
          seen.map((row) => row.user_id),
          person === sam || person === mark ? [person.userId] : [],
        );
      }
      await assert.rejects(queryAsUser(ada.userId, "insert into crm.chat_saved (user_id, message_id) values ($1, $2)", [sam.userId, message.id]), /row-level security/);
      await queryAsUser(ada.userId, "delete from crm.chat_saved where user_id = $1", [sam.userId]);
      assert.deepEqual(await savedIds(sam), [message.id]);
      await assert.rejects(queryAsUser(sam.userId, "update crm.chat_saved set user_id = $1", [priya.userId]), /permission denied/);
      await sql("delete from crm.chat_saved");
    });

    it("refuses to save a message you can't see, owners and admins included", async () => {
      const dm = await openDm(sam, priya.userId);
      const { message } = await postMessage(sam, { conversationId: dm.id, body: "Between us" });
      for (const outsider of [mark, ada, olly]) {
        await refused(setMessageSaved(outsider, message.id, true), /Message not found\./);
        await assert.rejects(queryAsUser(outsider.userId, "insert into crm.chat_saved (user_id, message_id) values ($1, $2)", [outsider.userId, message.id]), /row-level security/);
      }
      await refused(setMessageSaved(priya, "not-an-id", true), /Message not found\./);
      await refused(setMessageSaved(priya, "00000000-0000-4000-8000-000000000000", true), /Message not found\./);
      assert.equal((await sql("select count(*)::int as n from crm.chat_saved")).rows[0].n, 0);
      assert.equal((await setMessageSaved(priya, message.id, true)).saved, true);
      await sql("delete from crm.chat_saved");
    });

    it("drops a saved message from the list when you lose access, and brings it back with access", async () => {
      const private_ = (await createRoom(mark, { name: "leadership", memberIds: [sam.userId] })).id;
      const { message } = await postMessage(mark, { conversationId: private_, body: "Budget numbers" });
      await setMessageSaved(sam, message.id, true);
      assert.deepEqual(await listed(sam), [message.id]);
      await removeRoomMember(mark, private_, sam.userId);
      assert.deepEqual(await listed(sam), []);
      assert.deepEqual(await savedIds(sam), []);
      assert.equal((await sql("select count(*)::int as n from crm.chat_saved where user_id = $1", [sam.userId])).rows[0].n, 1);
      await addRoomMembers(mark, private_, [sam.userId]);
      assert.deepEqual(await listed(sam), [message.id]);
      await sql("delete from crm.chat_saved");
    });

    it("drops deleted messages and refuses to save deleted ones and system lines", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Oops" });
      await setMessageSaved(mark, message.id, true);
      await deleteMessage(sam, message.id);
      assert.deepEqual(await listed(mark), []);
      assert.deepEqual(await savedIds(mark), []);
      await refused(setMessageSaved(mark, message.id, true), /That message was deleted\./);
      assert.deepEqual(await setMessageSaved(mark, message.id, false), { messageId: message.id, saved: false });
      const event = await sql("insert into crm.chat_messages (conversation_id, author_user_id, body, kind) select $1, $2, 'Mark renamed the room', 'event' returning id", [room, mark.userId]);
      await refused(setMessageSaved(mark, event.rows[0].id, true), /That can't be saved\./);
      await sql("delete from crm.chat_saved");
    });

    it("saves messages in task discussions only for people who can see the task, and links to the task", async () => {
      const companyId = (await createCompany(mark, { name: "Halden Group", domain: "halden.test" })).body.company.id;
      const task = (await createTask(mark, { title: "Send Halden pricing", companyId, ownerId: sam.userId })).body.task;
      const { conversationId } = await openDiscussion(sam, { kind: "task", id: task.id });
      const { message } = await postMessage(sam, { conversationId, body: "Draft is in the doc" });
      await setMessageSaved(mark, message.id, true);
      const [item] = (await listSaved(mark)).items;
      assert.deepEqual(item.subject, { kind: "task", id: task.id });
      assert.deepEqual(item.conversation, { id: conversationId, kind: "task", name: "Send Halden pricing" });
      for (const outsider of [priya, ada, olly]) await refused(setMessageSaved(outsider, message.id, true), /Message not found\./);
      assert.deepEqual(await listed(priya), []);
      await sql("delete from crm.task_participants where task_id = $1", [task.id]);
      await sql("update crm.tasks set owner_id = $1, created_by_user_id = $1 where id = $2", [sam.userId, task.id]);
      assert.deepEqual(await listed(mark), []);
      assert.deepEqual(await listed(sam), []);
      await setMessageSaved(sam, message.id, true);
      assert.deepEqual(await listed(sam), [message.id]);
      await sql("delete from crm.chat_saved");
    });

    it("sets a reminder titled with the sender and a link to the message, never its text", async () => {
      const secret = "Our pricing floor is 41k, do not repeat";
      const { message } = await postMessage(sam, { conversationId: room, body: secret });
      const { reminder } = await remindAboutMessage(mark, message.id, "none");
      assert.equal(reminder.title, "Chat message from Sam");
      assert.equal(reminder.link, `/chat/${room}?message=${message.id}`);
      assert.equal(reminder.dueOn, null);
      assert.equal(reminder.dueAt, null);
      const stored = await sql("select to_jsonb(r)::text as row from crm.reminders r where id = $1", [reminder.id]);
      assert.equal(stored.rows[0].row.includes("pricing floor"), false);
      assert.equal(JSON.stringify(await getReminder(mark, reminder.id)).includes("pricing floor"), false);
      assert.deepEqual((await listReminders(sam)).reminders, []);
    });

    it("links a reminder for a thread reply to its thread, and a discussion message to its discussion", async () => {
      const root = (await postMessage(sam, { conversationId: room, body: "Root" })).message;
      const reply = (await postMessage(mark, { conversationId: room, parentId: root.id, body: "Reply" })).message;
      const inThread = await remindAboutMessage(sam, reply.id, "none");
      assert.equal(inThread.reminder.title, "Chat message from Mark");
      assert.equal(inThread.reminder.link, `/chat/${room}?thread=${root.id}`);
      const companyId = (await createCompany(mark, { name: "Brightwell", domain: "brightwell.test" })).body.company.id;
      const task = (await createTask(mark, { title: "Chase Brightwell", companyId, ownerId: mark.userId })).body.task;
      const { conversationId } = await openDiscussion(mark, { kind: "task", id: task.id });
      const note = (await postMessage(mark, { conversationId, body: "Call at 3" })).message;
      const onTask = await remindAboutMessage(mark, note.id, "none");
      assert.equal(onTask.reminder.link, `/tasks?task=${task.id}`);
      await refused(remindAboutMessage(priya, note.id, "none"), /Message not found\./);
      await refused(remindAboutMessage(ada, note.id, "none"), /Message not found\./);
    });

    it("sets the reminder for in an hour, tomorrow or no date, and refuses anything else", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Timing" });
      const now = Date.parse("2026-11-20T10:00:00Z");
      const hour = (await remindAboutMessage(mark, message.id, "hour", { now })).reminder;
      assert.equal(hour.dueAt, "2026-11-20T11:00:00.000Z");
      assert.equal(hour.dueOn, "2026-11-20");
      const tomorrow = (await remindAboutMessage(mark, message.id, "tomorrow", { now })).reminder;
      assert.equal(tomorrow.dueOn, "2026-11-21");
      assert.equal(tomorrow.dueAt, null);
      await refused(remindAboutMessage(mark, message.id, "next-year"), /Pick when to be reminded\./);
      await refused(remindAboutMessage(mark, message.id, undefined), /Pick when to be reminded\./);
      const deleted = (await postMessage(sam, { conversationId: room, body: "Gone" })).message;
      await deleteMessage(sam, deleted.id);
      await refused(remindAboutMessage(mark, deleted.id, "none"), /That message was deleted\./);
    });

    it("sets tomorrow's reminder on London's tomorrow in British Summer Time, when UTC is still the day before", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Summer" });
      const late = Date.parse("2026-07-01T23:30:00Z");
      const { reminder } = await remindAboutMessage(mark, message.id, "tomorrow", { now: late });
      assert.equal(reminder.dueOn, "2026-07-03");
      const winter = await remindAboutMessage(mark, message.id, "tomorrow", { now: Date.parse("2026-12-01T23:30:00Z") });
      assert.equal(winter.reminder.dueOn, "2026-12-02");
    });

    it("answers not found, never deleted, to someone who can't see a deleted message", async () => {
      const dm = await openDm(sam, priya.userId);
      const { message } = await postMessage(sam, { conversationId: dm.id, body: "Gone and private" });
      await deleteMessage(sam, message.id);
      for (const outsider of [mark, ada, olly]) {
        await refused(setMessageSaved(outsider, message.id, true), /Message not found\./);
        await refused(remindAboutMessage(outsider, message.id, "none"), /Message not found\./);
      }
      await refused(setMessageSaved(priya, message.id, true), /That message was deleted\./);
    });

    it("replays the first reminder when a Remind me is retried with the same key, even seconds later", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Retry" });
      const key = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
      const first = await remindAboutMessage(mark, message.id, "hour", { now: Date.parse("2026-11-20T10:00:00Z"), idempotencyKey: key });
      const second = await remindAboutMessage(mark, message.id, "hour", { now: Date.parse("2026-11-20T10:00:07.321Z"), idempotencyKey: key });
      assert.equal(second.reminder.id, first.reminder.id);
      const other = await remindAboutMessage(mark, message.id, "hour", { now: Date.parse("2026-11-20T10:00:00Z"), idempotencyKey: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" });
      assert.notEqual(other.reminder.id, first.reminder.id);
    });

    it("sets one reminder for a repeated key", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Twice" });
      const key = "6f1c9a52-8d3e-4c7a-9b0e-1a2b3c4d5e6f";
      const before = (await listReminders(mark)).reminders.length;
      const one = await remindAboutMessage(mark, message.id, "none", { idempotencyKey: key });
      const two = await remindAboutMessage(mark, message.id, "none", { idempotencyKey: key });
      assert.equal(one.reminder.id, two.reminder.id);
      assert.equal((await listReminders(mark)).reminders.length, before + 1);
    });

    it("keeps the link when a repeating reminder is ticked, and shows it to the person it belongs to only", async () => {
      const link = `/chat/${room}?message=00000000-0000-4000-8000-000000000001`;
      const { reminder } = await createReminder(mark, { title: "Chat message from Sam", dueOn: "2026-11-25", repeat: { every: "week" } }, { now: Date.parse("2026-11-20T10:00:00Z"), link });
      assert.equal(reminder.link, link);
      const ticked = await completeReminder(mark, reminder.id, { dueOn: reminder.dueOn }, { now: Date.parse("2026-11-20T10:00:00Z") });
      assert.equal(ticked.reminder.link, link);
      const copy = await getReminder(mark, ticked.doneId!);
      assert.equal(copy.reminder.link, link);
      const seen = await queryAsUser<{ link: string | null }>(sam.userId, "select link from crm.reminders where id = $1", [reminder.id]);
      assert.deepEqual(seen, []);
    });

    it("stores only paths inside Orbit in a reminder's link, in the database as well as in code", async () => {
      await refused(createReminder(mark, { title: "Bad" }, { link: "https://evil.test/x" }), /path inside Orbit/);
      await refused(createReminder(mark, { title: "Bad" }, { link: "//evil.test" }), /path inside Orbit/);
      await refused(createReminder(mark, { title: "Bad" }, { link: "javascript:alert(1)" }), /path inside Orbit/);
      assert.equal((await createReminder(mark, { title: "Fine" }, { link: "/chat/abc?message=1" })).reminder.link, "/chat/abc?message=1");
      const insert = (link: string | null) =>
        sql("insert into crm.reminders (user_id, title, link) values ($1, 'Raw', $2)", [mark.userId, link]);
      for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "chat/x", "/", "/a b", `/${"a".repeat(500)}`, ""]) {
        await assert.rejects(insert(bad), /reminders_link_check/, bad);
      }
      await insert(null);
      await insert("/chat/abc?thread=1");
      await assert.rejects(queryAsUser(mark.userId, "update crm.reminders set link = 'https://evil.test' where user_id = $1", [mark.userId]), /reminders_link_check/);
    });

    it("leaves the link to Chat: the reminder API, MCP and assistant never set one", async () => {
      const token = (await createPersonalToken(mark, "Saved test")).token;
      const response = await restCreate(
        new Request("http://crm.test/api/v1/reminders", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ title: "Sneaky", link: "/chat/x" }),
        }),
      );
      assert.equal(response.status, 400);
      assert.match(JSON.stringify(await response.json()), /don't take link/);
      assert.deepEqual(readReminderInput({ title: "Sneaky", link: "/chat/x" }), { title: "Sneaky" });
      assert.throws(() => readReminderInput({ title: "Sneaky", link: "/chat/x" }, { strict: true }), /don't take link/);
    });

    it("runs the migration again without error and keeps the rows", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Keep me" });
      await setMessageSaved(mark, message.id, true);
      await reapplyMigrationsFrom(MIGRATION);
      assert.deepEqual(await savedIds(mark), [message.id]);
      const policies = await sql("select policyname from pg_policies where tablename = 'chat_saved' order by policyname");
      assert.deepEqual(policies.rows.map((row) => row.policyname), ["chat_saved_delete", "chat_saved_insert", "chat_saved_select"]);
      const flags = await sql("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'crm.chat_saved'::regclass");
      assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
      await sql("delete from crm.chat_saved");
    });
  });
});
