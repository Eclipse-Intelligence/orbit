import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { postChat } from "@/lib/chat/tools";
import type { ChatLiveEvent } from "@/lib/chat/types";
import {
  chatWorkSettled,
  createRoom,
  editMessage,
  listConversations,
  listMessages,
  listUnreads,
  markAllChatRead,
  markConversationRead,
  markConversationUnread,
  openDiscussion,
  openDm,
  postMessage,
  setConversationNotify,
  updateRoom,
} from "@/lib/crm/chat";
import { createHook, postViaHook } from "@/lib/crm/chat-hooks";
import { CrmError } from "@/lib/crm/errors";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { usesRoomMention } from "@/lib/chat/markdown";
import { readNeeded } from "@/lib/chat/timeline";
import { mentionsRoom, ROOM_SENTINEL, roomOfferPlace, stripRoomMention } from "@/lib/mentions";
import { chatBody } from "@/lib/workflows/engine";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

after(async () => {
  await getPool().end();
});

async function sql(text: string, values: unknown[] = []) {
  return getAdminPool().query(text, values);
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

async function titles(userId: string) {
  await chatWorkSettled();
  return (await sql("select title from crm.notifications where user_id = $1 order by created_at, id", [userId])).rows.map((row: { title: string }) => row.title);
}

function tag(person: UserActor) {
  return `@[${person.fullName}](member:${person.userId})`;
}

let keys = 0;
function key() {
  keys += 1;
  return `notify-${keys}`;
}

describe("chat notification levels", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let broadcasts: LiveMessage[];

  async function room(name: string, members: UserActor[]) {
    return (await createRoom(mark, { name, memberIds: members.map((member) => member.userId) })).id;
  }

  async function sidebarEntry(person: UserActor, conversationId: string) {
    const entry = (await listConversations(person)).conversations.find((conversation) => conversation.id === conversationId);
    assert.ok(entry);
    return entry;
  }

  function post(person: UserActor, conversationId: string, body: string, extra: { parentId?: string; roomMention?: boolean; format?: "plain" | "markdown" } = {}) {
    return postMessage(person, { conversationId, parentId: extra.parentId, body, format: extra.format, clientKey: key() }, { roomMention: extra.roomMention });
  }

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@notify.test", "Mark Ridgeon");
    const samUser = await createUser("sam@notify.test", "Sam Okafor");
    const priyaUser = await createUser("priya@notify.test", "Priya Nair");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')", [mark.workspaceId, samUser.userId, priyaUser.userId]);
    sam = { ...samUser, workspaceId: mark.workspaceId, role: "member" };
    priya = { ...priyaUser, workspaceId: mark.workspaceId, role: "member" };
  });

  beforeEach(async () => {
    broadcasts = [];
    setLiveTesting({ batch: async (messages) => void broadcasts.push(...messages) });
    await sql("truncate crm.push_log, crm.notifications");
  });

  afterEach(async () => {
    await chatWorkSettled();
    setLiveTesting(null);
  });

  useServerlessPool();

  describe("rooms", () => {
    it("alerts All once per unread burst, Mentions only for tags, and Nothing only for tags unless mentions are muted too", async () => {
      const ops = await room("ops", [sam, priya]);
      assert.equal((await sidebarEntry(sam, ops)).notify, "default");
      await setConversationNotify(priya, ops, { notify: "all" });
      await post(mark, ops, "First");
      await post(mark, ops, "Second");
      assert.deepEqual(await titles(priya.userId), ["Mark posted in #ops"]);
      assert.deepEqual(await titles(sam.userId), []);
      await markConversationRead(priya, ops);
      await post(mark, ops, "Third");
      assert.deepEqual(await titles(priya.userId), ["Mark posted in #ops", "Mark posted in #ops"]);

      await post(mark, ops, `${tag(sam)} and ${tag(priya)} look`);
      assert.deepEqual(await titles(sam.userId), ["Mark mentioned you in #ops"]);
      assert.equal((await titles(priya.userId)).at(-1), "Mark mentioned you in #ops");

      await setConversationNotify(sam, ops, { notify: "mute" });
      await post(mark, ops, `${tag(sam)} muted but tagged`);
      assert.equal((await titles(sam.userId)).length, 2);
      await setConversationNotify(sam, ops, { muteMentions: true });
      await post(mark, ops, `${tag(sam)} muted and mentions muted`);
      assert.equal((await titles(sam.userId)).length, 2);
      await setConversationNotify(sam, ops, { notify: "mentions" });
      await post(mark, ops, `${tag(sam)} mentions muted only matters when muted`);
      assert.equal((await titles(sam.userId)).length, 3);
    });

    it("still counts unread and mentions in a muted room", async () => {
      const quiet = await room("quiet", [sam]);
      await setConversationNotify(sam, quiet, { notify: "mute", muteMentions: true });
      await post(mark, quiet, "Nobody is alerted");
      await post(mark, quiet, `${tag(sam)} counted, not alerted`);
      const entry = await sidebarEntry(sam, quiet);
      assert.equal(entry.notify, "mute");
      assert.equal(entry.muteMentions, true);
      assert.equal(entry.unread, 2);
      assert.equal(entry.mentions, 1);
      assert.equal((await listConversations(sam)).unreadConversations > 0, true);
      assert.deepEqual(await titles(sam.userId), []);
    });
  });

  describe("direct messages", () => {
    it("alerts All by default, nothing when muted, and refuses Mentions", async () => {
      const dm = await openDm(mark, sam.userId);
      assert.equal((await sidebarEntry(mark, dm.id)).notify, "default");
      await post(mark, dm.id, "Hello");
      assert.deepEqual(await titles(sam.userId), ["Mark sent you a message"]);
      await markConversationRead(sam, dm.id);
      await setConversationNotify(sam, dm.id, { notify: "mute" });
      await post(mark, dm.id, "Quiet");
      assert.deepEqual(await titles(sam.userId), ["Mark sent you a message"]);
      assert.equal((await sidebarEntry(sam, dm.id)).unread, 1);
      await refused(setConversationNotify(sam, dm.id, { notify: "mentions" }), /all messages or nothing/);
      await setConversationNotify(sam, dm.id, { notify: "all" });
      await markConversationRead(sam, dm.id);
      await post(mark, dm.id, "Loud");
      assert.equal((await titles(sam.userId)).length, 2);
    });
  });

  describe("thread replies", () => {
    it("alerts followers unless they muted the room, and still alerts a muted follower who is tagged", async () => {
      const deals = await room("deals", [sam, priya]);
      const root = await post(priya, deals, "Halden signed.");
      await post(sam, deals, "Nice", { parentId: root.message.id });
      assert.deepEqual(await titles(priya.userId), ["Sam replied in a thread in #deals"]);
      await setConversationNotify(priya, deals, { notify: "mute" });
      await markConversationRead(priya, deals);
      await sql("update crm.chat_thread_reads set last_read_at = now() where message_id = $1", [root.message.id]);
      await post(mark, deals, "Kick-off Monday", { parentId: root.message.id });
      assert.deepEqual(await titles(priya.userId), ["Sam replied in a thread in #deals"]);
      assert.deepEqual(await titles(sam.userId), ["Mark replied in a thread in #deals"]);
      await post(mark, deals, `${tag(priya)} can you run it?`, { parentId: root.message.id });
      assert.deepEqual(await titles(priya.userId), ["Sam replied in a thread in #deals", "Mark mentioned you in #deals"]);
      await setConversationNotify(priya, deals, { muteMentions: true });
      await post(mark, deals, `${tag(priya)} again`, { parentId: root.message.id });
      assert.equal((await titles(priya.userId)).length, 2);
    });

    it("alerts DM thread followers unless the DM is muted", async () => {
      const dm = await openDm(priya, sam.userId);
      const root = await post(priya, dm.id, "Thread me");
      await post(sam, dm.id, "Reply", { parentId: root.message.id });
      assert.ok((await titles(priya.userId)).includes("Sam replied in a thread"));
      const before = (await titles(priya.userId)).length;
      await setConversationNotify(priya, dm.id, { notify: "mute" });
      await sql("update crm.chat_thread_reads set last_read_at = now() where message_id = $1", [root.message.id]);
      await post(sam, dm.id, "Another", { parentId: root.message.id });
      assert.equal((await titles(priya.userId)).length, before);
    });
  });

  describe("@room", () => {
    it("alerts every member who takes mentions, counts as a mention and is never stored in mentions", async () => {
      const standup = await room("standup", [sam, priya]);
      await setConversationNotify(priya, standup, { notify: "mute", muteMentions: true });
      const posted = await post(mark, standup, "@room standup in five", { roomMention: true });
      assert.deepEqual(posted.message.mentions, []);
      assert.equal(posted.message.everyone, true);
      assert.deepEqual((await sql("select mentions::text[] as mentions from crm.chat_messages where id = $1", [posted.message.id])).rows[0].mentions, [ROOM_SENTINEL]);
      assert.deepEqual(await titles(sam.userId), ["Mark mentioned @room in #standup"]);
      assert.deepEqual(await titles(priya.userId), []);
      assert.deepEqual(await titles(mark.userId), []);
      assert.equal((await sidebarEntry(sam, standup)).mentions, 1);
      assert.equal((await sidebarEntry(priya, standup)).mentions, 1);
      assert.equal((await sidebarEntry(mark, standup)).mentions, 0);
      assert.equal((await listConversations(sam)).mentioned, true);
      await post(mark, standup, `${tag(sam)} and **@room** again`, { roomMention: true });
      assert.deepEqual(await titles(sam.userId), ["Mark mentioned @room in #standup", "Mark mentioned you in #standup"]);
    });

    it("alerts members when an edit adds @room, once", async () => {
      const edits = await room("edits", [sam]);
      const posted = await post(mark, edits, "Plain");
      await editMessage(mark, posted.message.id, "Plain @room", { roomMention: true });
      await editMessage(mark, posted.message.id, "Plain @room!", { roomMention: true });
      assert.deepEqual(await titles(sam.userId), ["Mark mentioned @room in #edits"]);
    });

    it("refuses @room in DMs, discussions, rooms over 50 people and from agents and workflows", async () => {
      const dm = await openDm(mark, sam.userId);
      await refused(post(mark, dm.id, "@room hi", { roomMention: true }), /@room only works in rooms\./);
      const task = (await createTask(mark, { title: "Chase the pilot", ownerId: mark.userId })).body.task;
      const { conversationId } = await openDiscussion(mark, { kind: "task", id: task.id });
      await refused(post(mark, conversationId, "@room hi", { roomMention: true }), /@room only works in rooms\./);
      const small = await room("small", [sam]);
      await refused(post(mark, small, "@room hi"), /Agents and workflows can't use @room/);
      await refused(postMessage(mark, { conversationId: small, body: "@room hi", clientKey: key() }, { roomMention: true, viaWorkflowId: "00000000-0000-4000-8000-000000000001" }), /can't use @room/);
      await refused(postChat(mark, { conversationId: small, text: "@room from MCP" }), /Agents and workflows can't use @room/);
      assert.deepEqual(await runTool(mark, "team_chat", { action: "post", conversationId: small, text: "@room from the assistant" }), {
        error: "Agents and workflows can't use @room. Tag people instead.",
        field: "body",
      });
      const plain = await post(mark, small, "Plain");
      await refused(editMessage(mark, plain.message.id, "Now @room"), /can't use @room/);

      const big = await room("big", [sam, priya]);
      const extra: string[] = [];
      for (let index = 0; index < 48; index += 1) extra.push((await createUser(`crowd${index}@notify.test`, `Crowd ${index}`)).userId);
      await sql("insert into crm.chat_members (conversation_id, user_id) select $1, unnest($2::uuid[])", [big, extra.slice(0, 47)]);
      await post(mark, big, "@room at fifty", { roomMention: true });
      await sql("insert into crm.chat_members (conversation_id, user_id) values ($1, $2)", [big, extra[47]]);
      await refused(post(mark, big, "@room at fifty one", { roomMention: true }), /@room works in rooms of up to 50 people/);
      await post(mark, big, "email@room.test and @roomy are fine", { roomMention: false });
    });

    it("treats a tag or @room inside Markdown code as text that neither alerts nor counts, anywhere", async () => {
      const coded = await room("coded", [sam]);
      const inline = await post(mark, coded, "Type `@room` to ping everyone", { format: "markdown" });
      const fenced = await post(mark, coded, "```\n@room\n" + tag(sam) + "\n```", { format: "markdown" });
      assert.deepEqual([inline.message.everyone, fenced.message.everyone, fenced.message.mentions], [false, false, []]);
      const entry = await sidebarEntry(sam, coded);
      assert.deepEqual([entry.unread, entry.mentions], [2, 0]);
      assert.deepEqual(await titles(sam.userId), []);
      const dm = await openDm(mark, sam.userId);
      await post(mark, dm.id, "In a DM `@room` is fine", { format: "markdown" });
      await postChat(mark, { conversationId: coded, text: "Agents can quote `@room` too" });
      await refused(postChat(mark, { conversationId: coded, text: "But not **@room**" }), /can't use @room/);
      assert.equal(usesRoomMention("`@room`", "markdown"), false);
      assert.equal(usesRoomMention("```\n@room\n```", "plain"), true);
      assert.equal(usesRoomMention("- @room", "markdown"), true);
      assert.equal(usesRoomMention("\u00a0@room", "plain"), false);
      assert.equal(usesRoomMention("`user`@room", "markdown"), false);
      assert.equal(usesRoomMention("[@room](https://x.com)", "markdown"), false);
      assert.equal(usesRoomMention("**[@room](https://x.com)**", "markdown"), false);
      assert.equal(usesRoomMention("`user` @room", "markdown"), true);
      assert.equal(usesRoomMention("**`user`** **@room**", "markdown"), true);
      const glued = await post(mark, coded, "`user`@room and [@room](https://x.com)", { format: "markdown" });
      assert.equal(glued.message.everyone, false);
    });

    it("refuses @room in a thread reply and on an edit of one", async () => {
      const threaded = await room("threaded", [sam]);
      const root = await post(sam, threaded, "Root");
      await refused(post(mark, threaded, "@room look", { parentId: root.message.id, roomMention: true }), /@room only works in the main room\./);
      const reply = await post(mark, threaded, "Reply", { parentId: root.message.id });
      await refused(editMessage(mark, reply.message.id, "Reply @room", { roomMention: true }), /@room only works in the main room\./);
    });

    it("counts @room as one of the 50 mentions", async () => {
      const crowd = await room("crowd", [sam]);
      const people = Array.from({ length: 50 }, (_, index) => `@[P${index}](member:${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000)`);
      await post(mark, crowd, `${people.slice(0, 49).join(" ")} @room`, { roomMention: true });
      await refused(post(mark, crowd, `${people.join(" ")} @room`, { roomMention: true }), /Tag up to 50 people/);
    });

    it("respects muted mentions when an edit adds a tag or @room", async () => {
      const quiet = await room("quiet-edits", [sam, priya]);
      await setConversationNotify(sam, quiet, { notify: "mute", muteMentions: true });
      await setConversationNotify(priya, quiet, { notify: "mute" });
      const posted = await post(mark, quiet, "Plain");
      await editMessage(mark, posted.message.id, `Plain ${tag(sam)} ${tag(priya)}`, { roomMention: true });
      const other = await post(mark, quiet, "Second");
      await editMessage(mark, other.message.id, "Second @room", { roomMention: true });
      assert.deepEqual(await titles(sam.userId), []);
      assert.deepEqual(await titles(priya.userId), ["Mark mentioned you in #quiet-edits", "Mark mentioned @room in #quiet-edits"]);
    });

    it("counts @room only when the server flagged it, so raw text from workflows and elsewhere never counts", async () => {
      const flows = await room("flows", [sam]);
      await sql("insert into crm.chat_messages (conversation_id, author_user_id, client_key, body) values ($1, $2, 'wf-room', '@room raw text')", [flows, mark.userId]);
      const entry = await sidebarEntry(sam, flows);
      assert.deepEqual([entry.unread, entry.mentions], [1, 0]);
    });

    it("strips @room from workflow posts and never counts it on hook messages", async () => {
      assert.equal(chatBody("Hi @room {{x}}", { x: "and @Room too" }), "Hi room and Room too");
      assert.equal(chatBody("**@room** (@room)", {}), "**room** (room)");
      assert.equal(stripRoomMention("@@room x@room @rooms"), "@@room x@room @rooms");
      assert.equal(mentionsRoom("_@room_"), true);
      assert.equal(mentionsRoom("https://x.test/@room"), false);
      const hooked = await room("hooked", [sam]);
      const { hook, secret } = await createHook(mark, hooked, "Deploys");
      await postViaHook({ hookId: hook.id, authorization: `Bearer ${secret}`, body: JSON.stringify({ text: "@room deploy finished" }) });
      const entry = await sidebarEntry(sam, hooked);
      assert.equal(entry.unread, 1);
      assert.equal(entry.mentions, 0);
      assert.deepEqual(await titles(sam.userId), []);
    });

    it("alerts members whose level is All when a webhook posts, once per unread burst", async () => {
      const alerts = await room("alerts", [sam, priya]);
      await setConversationNotify(priya, alerts, { notify: "all" });
      const { hook, secret } = await createHook(mark, alerts, "Deploys");
      const send = (text: string) => postViaHook({ hookId: hook.id, authorization: `Bearer ${secret}`, body: JSON.stringify({ text }) });
      await send("one");
      await send("two");
      assert.deepEqual(await titles(priya.userId), ["Deploys posted in #alerts"]);
      assert.deepEqual(await titles(sam.userId), []);
      assert.deepEqual(await titles(mark.userId), []);
      await markConversationRead(priya, alerts);
      await send("three");
      assert.equal((await titles(priya.userId)).length, 2);
    });
  });

  describe("mark unread", () => {
    it("moves the read mark to just before a message, survives a reload and broadcasts it", async () => {
      const notes = await room("notes", [sam]);
      const first = await post(sam, notes, "One");
      const second = await post(sam, notes, "Two");
      const third = await post(sam, notes, "Three");
      const reply = await post(mark, notes, "Reply", { parentId: second.message.id });
      await markConversationRead(mark, notes);
      assert.equal((await sidebarEntry(mark, notes)).unread, 0);
      const marked = await markConversationUnread(mark, notes, second.message.id);
      assert.equal(marked.messageId, second.message.id);
      assert.equal((await sidebarEntry(mark, notes)).unread, 2);
      const page = await listMessages(mark, notes, { around: "unread" });
      assert.equal(page.firstUnreadId, second.message.id);
      assert.ok(broadcasts.some((message) => message.topic === personTopic(mark.userId) && (message.payload as ChatLiveEvent).type === "unread"));
      assert.equal((await markConversationUnread(mark, notes, reply.message.id)).messageId, second.message.id);
      await markConversationRead(mark, notes, third.message.id);
      assert.equal((await sidebarEntry(mark, notes)).unread, 0);
      assert.equal((await markConversationUnread(mark, notes, null)).messageId, third.message.id);
      assert.equal((await sidebarEntry(mark, notes)).unread, 1);
      assert.equal((await markConversationUnread(mark, notes, first.message.id)).messageId, first.message.id);
      assert.equal((await sidebarEntry(mark, notes)).unread, 3);
      await refused(markConversationUnread(priya, notes, first.message.id), /not found/i);
      await refused(markConversationUnread(mark, notes, "00000000-0000-4000-8000-000000000009"), /not found/i);
      const empty = await room("empty", [sam]);
      await post(mark, empty, "Only mine");
      await refused(markConversationUnread(mark, empty, null), /nothing from anyone else/);
    });

    it("lists unread messages by conversation and marks everything read", async () => {
      const one = await room("one", [sam]);
      const two = await room("two", [sam]);
      const root = await post(sam, one, "Root");
      await post(mark, one, "Reply", { parentId: root.message.id });
      await post(mark, one, "Unread one");
      await post(mark, two, "Unread two");
      await setConversationNotify(sam, two, { starred: true });
      const unreads = await listUnreads(sam);
      const ids = unreads.groups.map((group) => group.conversation.id);
      assert.ok(ids.includes(one));
      assert.equal(ids[0], two);
      assert.deepEqual(
        unreads.groups.find((group) => group.conversation.id === one)?.messages.map((message) => message.body),
        ["Unread one"],
      );
      const archived = await room("archived", [sam]);
      const old = await post(sam, archived, "Old root");
      await post(mark, archived, "Old reply", { parentId: old.message.id });
      await sql("update crm.chat_conversations set archived_at = now() where id = $1", [archived]);
      const othersBefore = await sql("select conversation_id, last_read_at from crm.chat_members where user_id <> $1 order by 1, 2", [sam.userId]);
      const otherThreadsBefore = await sql("select message_id, user_id, last_read_at from crm.chat_thread_reads where user_id <> $1 order by 1, 2", [sam.userId]);
      const archivedBefore = await sql("select last_read_at from crm.chat_thread_reads where message_id = $1 and user_id = $2", [old.message.id, sam.userId]);
      broadcasts = [];
      await markAllChatRead(sam);
      const sidebar = await listConversations(sam);
      assert.equal(sidebar.unreadConversations, 0);
      assert.deepEqual(sidebar.threads, { unread: 0, mentions: 0 });
      assert.deepEqual((await listUnreads(sam)).groups, []);
      assert.deepEqual((await sql("select conversation_id, last_read_at from crm.chat_members where user_id <> $1 order by 1, 2", [sam.userId])).rows, othersBefore.rows);
      assert.deepEqual((await sql("select message_id, user_id, last_read_at from crm.chat_thread_reads where user_id <> $1 order by 1, 2", [sam.userId])).rows, otherThreadsBefore.rows);
      assert.deepEqual((await sql("select last_read_at from crm.chat_thread_reads where message_id = $1 and user_id = $2", [old.message.id, sam.userId])).rows, archivedBefore.rows);
      await chatWorkSettled();
      const events = broadcasts.filter((message) => message.topic === personTopic(sam.userId)).map((message) => message.payload as ChatLiveEvent);
      assert.ok(events.some((event) => event.type === "thread-read" && event.messageId === root.message.id));
      assert.ok(!events.some((event) => event.type === "thread-read" && event.messageId === old.message.id));
    });
  });

  describe("mark everything read", () => {
    it("leaves another person's conversation and thread read marks alone", async () => {
      const shared = await room("shared-reads", [sam, priya]);
      const root = await post(sam, shared, "Root");
      await post(priya, shared, "Reply", { parentId: root.message.id });
      await post(sam, shared, "Unread for everyone else");
      const others = async () =>
        (
          await sql(
            `select 'member' as kind, conversation_id as id, user_id, last_read_at from crm.chat_members where user_id <> $1
             union all
             select 'thread', message_id, user_id, last_read_at from crm.chat_thread_reads where user_id <> $1
             order by 1, 2, 3`,
            [mark.userId],
          )
        ).rows;
      const before = await others();
      await markAllChatRead(mark);
      assert.deepEqual(await others(), before);
      assert.equal((await sidebarEntry(mark, shared)).unread, 0);
      assert.equal((await sidebarEntry(priya, shared)).unread, 2);
    });

    it("never alerts from a webhook in an archived room", async () => {
      const closed = await room("closed-hooks", [sam]);
      await setConversationNotify(sam, closed, { notify: "all" });
      const { hook, secret } = await createHook(mark, closed, "Deploys");
      const posted = await postViaHook({ hookId: hook.id, authorization: `Bearer ${secret}`, body: JSON.stringify({ text: "before" }) });
      await sql("update crm.chat_conversations set archived_at = now() where id = $1", [closed]);
      assert.deepEqual((await sql("select user_id from private.chat_hook_listeners($1)", [posted.id])).rows, []);
    });
  });

  describe("system lines", () => {
    it("never show in All unreads and are never the Mark unread anchor", async () => {
      const topics = await room("topics", [sam]);
      const first = await post(sam, topics, "Before the topic");
      await markConversationRead(mark, topics);
      await updateRoom(sam, topics, { topic: "Q4 pipeline" });
      const events = await sql("select id from crm.chat_messages where conversation_id = $1 and kind = 'event'", [topics]);
      assert.equal(events.rows.length, 1);
      assert.equal((await markConversationUnread(mark, topics, null)).messageId, first.message.id);
      const group = (await listUnreads(mark)).groups.find((item) => item.conversation.id === topics);
      assert.deepEqual(group?.messages.map((message) => message.id), [first.message.id]);
      await refused(markConversationUnread(mark, topics, events.rows[0].id), /Message not found/);
      await markConversationRead(mark, topics);
      assert.equal((await listUnreads(mark)).groups.some((item) => item.conversation.id === topics), false);
    });
  });

  describe("@room in the picker", () => {
    it("waits for the people search unless the query is exactly room", () => {
      assert.equal(roomOfferPlace("ro", false), null);
      assert.equal(roomOfferPlace("ro", true), "last");
      assert.equal(roomOfferPlace("", true), "last");
      assert.equal(roomOfferPlace("Room", false), "first");
      assert.equal(roomOfferPlace("rooms", true), null);
      assert.equal(roomOfferPlace("sam", true), null);
    });
  });

  describe("read dedupe", () => {
    it("always sends a read with no message, and skips only a repeat of the same message", () => {
      const sent = new Map<string, string | null>([["room", "m1"], ["other", null]]);
      assert.equal(readNeeded(sent, "room", "m1"), false);
      assert.equal(readNeeded(sent, "room", "m2"), true);
      assert.equal(readNeeded(sent, "room", null), true);
      assert.equal(readNeeded(sent, "other", null), true);
      assert.equal(readNeeded(sent, "new", "m1"), true);
    });
  });

  describe("settings", () => {
    it("keeps both of two changes made at once and refuses bad input", async () => {
      const busy = await room("busy", [sam]);
      await Promise.all([setConversationNotify(sam, busy, { notify: "all" }), setConversationNotify(sam, busy, { starred: true }), setConversationNotify(sam, busy, { notify: "mute", muteMentions: true })]);
      const entry = await sidebarEntry(sam, busy);
      assert.ok(entry.notify === "all" || entry.notify === "mute");
      assert.equal(entry.starred, true);
      assert.equal(entry.muteMentions, true);
      assert.equal((await sidebarEntry(mark, busy)).starred, false);
      await refused(setConversationNotify(sam, busy, { notify: "loud" }), /Pick All messages, Mentions or Nothing/);
      await refused(setConversationNotify(sam, busy, {}), /Say what to change/);
      await refused(setConversationNotify(priya, busy, { starred: true }), /not found/i);
      const task = (await createTask(mark, { title: "Discuss", ownerId: mark.userId })).body.task;
      const { conversationId } = await openDiscussion(mark, { kind: "task", id: task.id });
      await refused(setConversationNotify(mark, conversationId, { starred: true }), /not found/i);
      await assert.rejects(sql("update crm.chat_members set notify = 'loud' where conversation_id = $1", [busy]), /chat_members_notify_check/);
    });
  });
});
