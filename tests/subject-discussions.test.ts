import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { discussionCount, discussionHref, readSubject, taskPanelHref } from "@/lib/chat/discussions";
import { replaceDescriptionText, splitDescription } from "@/lib/crm/task-description";
import type { ChatLiveEvent, ChatMessage } from "@/lib/chat/types";
import {
  chatWorkSettled,
  deleteMessage,
  discussionCounts,
  editMessage,
  getDiscussion,
  listMessages,
  listThread,
  markThreadRead,
  openDiscussion,
  postMessage,
} from "@/lib/crm/chat";
import { createCompany } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask, listTaskParticipants, removeTaskParticipant } from "@/lib/crm/tasks";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { appendToDailyNote } from "@/lib/docs/daily-notes";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { createDoc, shareDoc } from "@/lib/docs/store";
import { createUser, resetDatabase } from "./helpers";

type Alert = {
  title: string;
  body: string | null;
  href: string | null;
  source: string;
};

const PROVENANCE = { operation: "discussions_test", source: "test" };

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let ada: UserActor;
let olly: UserActor;
let companyId: string;
let broadcasts: LiveMessage[];

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return {
    ...user,
    workspaceId: mark.workspaceId,
    workspaceName: mark.workspaceName,
    role,
    scopes: scopesForRole(role),
  };
}

function tag(person: UserActor) {
  return `@[${person.fullName}](member:${person.userId})`;
}

function opened(path: string) {
  return `/open?workspace=${mark.workspaceId}&to=${encodeURIComponent(path)}`;
}

async function alertsFor(user: UserActor) {
  await chatWorkSettled();
  for (let tries = 0; tries < 30; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return sql<Alert>("select title, body, href, source from crm.notifications where user_id = $1 order by created_at, id", [user.userId]);
}

async function until(check: () => boolean, label: string) {
  for (let tries = 0; tries < 300; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

function chatEvents(userId: string) {
  return broadcasts.filter((message) => message.topic === personTopic(userId) && message.event === "chat").map((message) => message.payload as ChatLiveEvent);
}

async function newTask(title: string, owner: UserActor = sam) {
  return (await createTask(mark, { title, companyId, ownerId: owner.userId })).body.task;
}

async function send(actor: UserActor, conversationId: string, body: string, parentId: string | null = null) {
  return (await postMessage(actor, { conversationId, body, parentId })).message;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@discuss.test", "Mark Ridgeon");
  await sql("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
  mark = { ...mark, workspaceName: "Eclipse" };
  sam = await join(await createUser("sam@discuss.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@discuss.test", "Priya Nair"), "member");
  ada = await join(await createUser("ada@discuss.test", "Ada Admin"), "admin");
  olly = await createUser("olly@elsewhere.test", "Olly Outside");
  companyId = (await createCompany(mark, { name: "Halden Group", domain: "halden.test" })).body.company.id;
});

beforeEach(async () => {
  await chatWorkSettled();
  await new Promise((resolve) => setTimeout(resolve, 100));
  broadcasts = [];
  setLiveTesting({
    batch: async (messages) => void broadcasts.push(...messages),
  });
  await sql("truncate crm.push_log, crm.notifications");
});

after(async () => {
  await chatWorkSettled();
  setLiveTesting(null);
  await getPool().end();
  await getAdminPool().end();
});

describe("task discussions", () => {
  it("creates one conversation per task, however many people open it at once", async () => {
    const task = await newTask("Send Halden the revised pricing");
    const before = await getDiscussion(sam, { kind: "task", id: task.id });
    assert.deepEqual(
      {
        conversationId: before.conversationId,
        count: before.count,
        page: before.page,
      },
      { conversationId: null, count: 0, page: null },
    );
    const opened = await Promise.all([mark, sam, ada, mark, sam, ada].map((actor) => openDiscussion(actor, { kind: "task", id: task.id })));
    assert.equal(new Set(opened.map((item) => item.conversationId)).size, 1);
    const rows = await sql<{ count: number }>("select count(*)::int as count from crm.chat_conversations where task_id = $1", [task.id]);
    assert.equal(rows[0].count, 1);
    const after = await getDiscussion(sam, { kind: "task", id: task.id });
    assert.equal(after.conversationId, opened[0].conversationId);
    assert.deepEqual(after.page?.messages, []);
  });

  it("shows the discussion to the owner, the creator and admins, and no one else", async () => {
    const task = await newTask("Draft Samsara renewal terms");
    const { conversationId } = await openDiscussion(sam, {
      kind: "task",
      id: task.id,
    });
    await send(sam, conversationId, "Starting on this today.");
    for (const actor of [mark, sam, ada]) {
      const discussion = await getDiscussion(actor, {
        kind: "task",
        id: task.id,
      });
      assert.equal(discussion.count, 1, actor.fullName ?? "");
      assert.deepEqual(
        discussion.page?.messages.map((message) => message.body),
        ["Starting on this today."],
      );
    }
    await refused(getDiscussion(priya, { kind: "task", id: task.id }), /Task not found/);
    await refused(openDiscussion(priya, { kind: "task", id: task.id }), /Task not found/);
    await refused(listMessages(priya, conversationId), /Conversation not found/);
    await refused(postMessage(priya, { conversationId, body: "Let me in" }), /Conversation not found/);
    await refused(getDiscussion(olly, { kind: "task", id: task.id }), /Task not found/);
    await refused(getDiscussion(sam, { kind: "task", id: "not-a-task" }), /Discussion not found/);
    const seen = await sql<{ id: string }>("select id from crm.chat_conversations where id = $1", [conversationId]);
    assert.equal(seen.length, 1);
  });

  it("tags someone mentioned in the discussion, gives them access and tells them", async () => {
    const task = await newTask("Check the discount maths");
    const { conversationId } = await openDiscussion(sam, {
      kind: "task",
      id: task.id,
    });
    const first = await send(sam, conversationId, `${tag(priya)} can you check the discount maths? ${tag(ada)} too.`);

    assert.deepEqual((await listTaskParticipants(sam, [task.id]))[task.id]?.sort(), [mark.userId, priya.userId].sort());
    const audit = await sql<{ user_id: string; source: string }>(
      "select changes->'participant'->>'userId' as user_id, source from crm.audit_events where entity_id = $1 and event_type = 'task.participant_added' and actor_user_id = $2",
      [task.id, sam.userId],
    );
    assert.deepEqual(
      audit.map((row) => [row.user_id, row.source]).sort(),
      [[priya.userId, "chat"]],
    );

    assert.deepEqual(await alertsFor(priya), [
      {
        title: "Sam Okafor tagged you in a task",
        body: "Check the discount maths",
        href: opened(taskPanelHref(task.id, { tagged: true })),
        source: "task",
      },
    ]);
    assert.deepEqual(
      (await alertsFor(ada)).map((alert) => [alert.title, alert.href]),
      [["Sam Okafor mentioned you in a task", opened(taskPanelHref(task.id))]],
    );
    assert.deepEqual(await alertsFor(mark), []);

    const seen = await getDiscussion(priya, { kind: "task", id: task.id });
    assert.deepEqual(
      seen.page?.messages.map((message) => message.id),
      [first.id],
    );
    const reply = await send(priya, conversationId, "Checked. 12% on year one holds.", first.id);
    const thread = await listThread(priya, first.id);
    assert.deepEqual(
      thread.replies.map((message) => message.id),
      [reply.id],
    );
    assert.equal(thread.following, true);
    assert.deepEqual(
      (await alertsFor(sam)).filter((alert) => !alert.title.includes("assigned")),
      [
        {
          title: "Priya Nair replied in a thread on a task",
          body: "Check the discount maths",
          href: opened(taskPanelHref(task.id)),
          source: "task",
        },
      ],
    );

    await refused(postMessage(sam, { conversationId, body: `${tag(olly)} have a look` }), /Tag people in this task's workspace/);
  });

  it("alerts people who can already see the task when they are mentioned", async () => {
    const task = await newTask("Ask Mark about v4");
    const { conversationId } = await openDiscussion(sam, {
      kind: "task",
      id: task.id,
    });
    await send(sam, conversationId, `${tag(mark)} is v4 final?`);
    assert.deepEqual(await alertsFor(mark), [
      {
        title: "Sam Okafor mentioned you in a task",
        body: "Ask Mark about v4",
        href: taskPanelHref(task.id),
        source: "task",
      },
    ]);
  });

  it("tags people added to a message by an edit", async () => {
    const task = await newTask("Book the security review");
    const { conversationId } = await openDiscussion(sam, {
      kind: "task",
      id: task.id,
    });
    const message = await send(sam, conversationId, "Who can take this?");
    await refused(getDiscussion(priya, { kind: "task", id: task.id }), /Task not found/);
    await editMessage(sam, message.id, `Who can take this? ${tag(priya)}`);
    assert.equal((await getDiscussion(priya, { kind: "task", id: task.id })).count, 1);
    assert.equal((await alertsFor(priya)).length, 1);
  });

  it("sends live events to everyone who can see the task, and no one else", async () => {
    const task = await newTask("Live task", sam);
    const { conversationId } = await openDiscussion(sam, {
      kind: "task",
      id: task.id,
    });
    await send(sam, conversationId, "Hello");
    await chatWorkSettled();
    for (const person of [mark, sam, ada])
      assert.ok(
        chatEvents(person.userId).some((event) => event.type === "message"),
        person.fullName ?? "",
      );
    for (const person of [priya, olly]) assert.deepEqual(chatEvents(person.userId), [], person.fullName ?? "");
    await send(sam, conversationId, `${tag(priya)} welcome`);
    await chatWorkSettled();
    await until(() => chatEvents(priya.userId).some((event) => event.type === "message" && event.message.body.includes("welcome")), "the tagged person's live event");
  });

  it("takes the discussion away from people removed from the task", async () => {
    const task = await newTask("Removed participant");
    const { conversationId } = await openDiscussion(sam, {
      kind: "task",
      id: task.id,
    });
    const root = await send(sam, conversationId, `${tag(priya)} have a look`);
    await send(priya, conversationId, "On it", root.id);
    await markThreadRead(priya, root.id);
    assert.equal(await removeTaskParticipant(sam, task.id, priya.userId), true);
    await sql("truncate crm.push_log, crm.notifications");
    broadcasts = [];
    await refused(getDiscussion(priya, { kind: "task", id: task.id }), /Task not found/);
    await refused(listMessages(priya, conversationId), /Conversation not found/);
    await refused(listThread(priya, root.id), /not found/i);
    await refused(postMessage(priya, { conversationId, body: "Still here?" }), /Conversation not found/);
    await send(sam, conversationId, "Thanks, done.", root.id);
    assert.deepEqual(await alertsFor(priya), []);
    assert.deepEqual(chatEvents(priya.userId), []);
  });

  it("counts messages that aren't deleted, replies included", async () => {
    const task = await newTask("Counted");
    const empty = await newTask("Quiet");
    const { conversationId } = await openDiscussion(sam, {
      kind: "task",
      id: task.id,
    });
    const root = await send(sam, conversationId, "One");
    await send(mark, conversationId, "Two", root.id);
    const gone = await send(sam, conversationId, "Three");
    await deleteMessage(sam, gone.id);
    assert.deepEqual(await discussionCounts(sam, "task", [task.id, empty.id, "nope"]), { [task.id]: 2 });
    assert.deepEqual(await discussionCounts(priya, "task", [task.id]), {});
    const discussion = await getDiscussion(sam, { kind: "task", id: task.id });
    assert.equal(discussion.count, 2);
    assert.equal(discussionCount(discussion.page?.messages ?? []), 2);
  });
  it("rolls back the whole post when one of two tags is outside the workspace", async () => {
    const task = await newTask("Two tags");
    const { conversationId } = await openDiscussion(sam, { kind: "task", id: task.id });
    await refused(postMessage(sam, { conversationId, body: `${tag(priya)} and ${tag(olly)} please look` }), /Tag people in this task's workspace/);
    assert.deepEqual((await listTaskParticipants(sam, [task.id]))[task.id] ?? [], [mark.userId]);
    assert.equal((await getDiscussion(sam, { kind: "task", id: task.id })).count, 0);
    await refused(getDiscussion(priya, { kind: "task", id: task.id }), /Task not found/);
    assert.deepEqual(await alertsFor(priya), []);
  });

  it("shuts out an assignee who left the workspace but still owns the task", async () => {
    const dana = await join(await createUser("dana@discuss.test", "Dana Left"), "member");
    const task = await newTask("Owned by a leaver", dana);
    const { conversationId } = await openDiscussion(dana, { kind: "task", id: task.id });
    await send(dana, conversationId, "Picking this up.");
    await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, dana.userId]);
    const [row] = await sql<{ owner_id: string }>("select owner_id from crm.tasks where id = $1", [task.id]);
    assert.equal(row.owner_id, dana.userId);
    broadcasts = [];
    await refused(getDiscussion(dana, { kind: "task", id: task.id }), /Task not found/);
    await refused(postMessage(dana, { conversationId, body: "Still here?" }), /Conversation not found/);
    await send(mark, conversationId, "Taking this back.");
    await until(() => chatEvents(mark.userId).length > 0, "the creator's live event");
    assert.deepEqual(chatEvents(dana.userId), []);
    await send(mark, conversationId, `${tag(dana)} are you there?`);
    assert.deepEqual((await alertsFor(dana)).filter((alert) => !alert.title.includes("assigned")), []);
    assert.deepEqual(chatEvents(dana.userId), []);
  });

  it("carries the discussion when the task moves workspace", async () => {
    const other = await createUser("owner@elsewhere-two.test", "Other Owner");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [other.workspaceId, mark.userId]);
    const task = (await createTask(mark, { title: "Moving task", ownerId: mark.userId })).body.task;
    const { conversationId } = await openDiscussion(mark, { kind: "task", id: task.id });
    await send(mark, conversationId, `${tag(priya)} have a look`);
    assert.equal((await getDiscussion(priya, { kind: "task", id: task.id })).count, 1);
    await sql("update crm.tasks set workspace_id = $2 where id = $1", [task.id, other.workspaceId]);
    await refused(getDiscussion(priya, { kind: "task", id: task.id }), /Task not found/);
    assert.equal((await getDiscussion(mark, { kind: "task", id: task.id })).count, 1);
    const moved = await getDiscussion(other, { kind: "task", id: task.id });
    assert.equal(moved.conversationId, conversationId);
    assert.equal(moved.count, 1);
    await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [other.workspaceId, mark.userId]);
  });
});

describe("doc discussions", () => {
  it("opens only on shared docs, never on private docs or daily notes", async () => {
    const shared = await createDoc(mark, { title: "Halden kick-off", content: "Agenda", shared: true }, PROVENANCE);
    const own = await createDoc(sam, { title: "Sam's private notes", content: "Mine" }, PROVENANCE);
    const daily = await appendToDailyNote(
      sam,
      {
        text: "Call Tom",
        date: "2026-11-11",
        now: new Date("2026-11-11T10:00:00Z"),
      },
      PROVENANCE,
    );

    const created = await Promise.all([sam, priya, mark].map((actor) => openDiscussion(actor, { kind: "doc", id: shared.id })));
    assert.equal(new Set(created.map((item) => item.conversationId)).size, 1);
    await refused(openDiscussion(sam, { kind: "doc", id: own.id }), /Share this doc with the workspace to discuss it/);
    await refused(openDiscussion(sam, { kind: "doc", id: daily.page.id }), /Daily notes don't have a discussion/);
    await refused(openDiscussion(priya, { kind: "doc", id: own.id }), /Doc not found/);
    await refused(openDiscussion(olly, { kind: "doc", id: shared.id }), /Doc not found/);
    const insert = sql("insert into crm.chat_conversations (kind, page_id) values ('doc', $1)", [own.id]);
    await assert.doesNotReject(insert);
    const forced = await sql<{ id: string }>("select id from crm.chat_conversations where page_id = $1", [own.id]);
    await refused(listMessages(sam, forced[0].id), /Conversation not found/);
    await refused(postMessage(sam, { conversationId: forced[0].id, body: "Hidden" }), /Conversation not found/);
  });

  it("tells mentioned workspace members, and stops when the doc is unshared", async () => {
    const doc = await createDoc(mark, { title: "Pricing review", content: "Notes", shared: true }, PROVENANCE);
    const { conversationId } = await openDiscussion(priya, {
      kind: "doc",
      id: doc.id,
    });
    const root = await send(priya, conversationId, `${tag(mark)} is v4 final? ${tag(olly)}`);
    assert.deepEqual(await alertsFor(mark), [
      {
        title: "Priya mentioned you in a doc",
        body: null,
        href: discussionHref({ kind: "doc", id: doc.id }),
        source: "doc",
      },
    ]);
    assert.deepEqual(await alertsFor(olly), []);
    await chatWorkSettled();
    for (const person of [mark, sam, priya, ada]) assert.ok(chatEvents(person.userId).length > 0, person.fullName ?? "");
    assert.deepEqual(chatEvents(olly.userId), []);

    await send(sam, conversationId, "Agreed", root.id);
    const priyaAlerts = await alertsFor(priya);
    assert.deepEqual(
      priyaAlerts.map((alert) => alert.title),
      ["Sam replied in a thread on a doc"],
    );

    await shareDoc(mark, doc.id, false, PROVENANCE);
    await refused(postMessage(sam, { conversationId, body: "Still shared?" }), /Conversation not found/);
    await refused(getDiscussion(sam, { kind: "doc", id: doc.id }), /Doc not found/);
    await refused(getDiscussion(mark, { kind: "doc", id: doc.id }), /Share this doc with the workspace to discuss it/);
  });
});

describe("discussion helpers", () => {
  it("reads subjects and builds links", () => {
    const id = "6f1c2b9e-4a5d-4c3b-8e2f-1a2b3c4d5e6f";
    assert.deepEqual(readSubject({ kind: "task", id: id.toUpperCase() }), {
      kind: "task",
      id,
    });
    assert.equal(readSubject({ kind: "room", id }), null);
    assert.equal(readSubject({ kind: "doc", id: "nope" }), null);
    assert.equal(discussionHref({ kind: "task", id }), `/tasks?task=${id}`);
    assert.equal(discussionHref({ kind: "doc", id }), `/docs/${id}?discussion=1`);
    assert.equal(taskPanelHref(id, { tagged: true }), `/tasks?who=tagged&task=${id}`);
  });

  it("counts loaded roots and their replies", () => {
    const base: ChatMessage = {
      id: "a",
      conversationId: "c",
      parentId: null,
      author: { id: "u", name: "U" },
      clientKey: null,
      body: "x",
      mentions: [],
      via: null,
      hook: null,
      replyCount: 0,
      lastReplyAt: null,
      replyAuthors: [],
      editedAt: null,
      deletedAt: null,
      createdAt: "2026-11-11T10:00:00.000Z",
    };
    assert.equal(
      discussionCount([
        base,
        { ...base, id: "b", replyCount: 2 },
        {
          ...base,
          id: "d",
          deletedAt: "2026-11-11T11:00:00.000Z",
          replyCount: 1,
        },
      ]),
      5,
    );
  });

  it("keeps mail links where they were when the description text changes", () => {
    const link = "[Re: pricing](/mail?thread=a)";
    assert.equal(replaceDescriptionText(`Intro\n${link}\nSecond`, "Intro changed\nSecond"), `Intro changed\n${link}\nSecond`);
    assert.equal(replaceDescriptionText(`Use v4\n\n${link}`, "Use v5"), `Use v5\n\n${link}`);
    assert.equal(replaceDescriptionText(link, "New text"), `${link}\nNew text`);
    assert.equal(replaceDescriptionText("A\n\nB", "A\nB"), "A\nB");
    assert.equal(replaceDescriptionText("A", "A\n\n\n\nB"), "A\n\n\n\nB");
    assert.equal(replaceDescriptionText(`A\n${link}\nB`, "A\nNew\nB"), `A\n${link}\nNew\nB`);
    assert.equal(replaceDescriptionText(`A\n${link}\nB`, "Only"), `Only\n${link}`);
    assert.equal(replaceDescriptionText(`One\n${link}`, ""), link);
    assert.equal(replaceDescriptionText(null, ""), null);
    let mid = `A\n\n${link}\nB`;
    for (let round = 0; round < 3; round += 1) {
      const { text } = splitDescription(mid);
      mid = replaceDescriptionText(mid, text) ?? "";
    }
    assert.equal(mid, `A\n\n${link}\nB`);
    const edited = replaceDescriptionText(`A\n\n${link}\nB`, "A changed\n\nB");
    assert.equal(replaceDescriptionText(edited, splitDescription(edited).text), edited);
  });
});
