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
} from "@/lib/crm/chat";
import { createHook, postViaHook } from "@/lib/crm/chat-hooks";
import { CrmError } from "@/lib/crm/errors";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { mentionsRoom, stripRoomMention } from "@/lib/mentions";
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

  function post(person: UserActor, conversationId: string, body: string, extra: { parentId?: string; roomMention?: boolean } = {}) {
    return postMessage(person, { conversationId, parentId: extra.parentId, body, clientKey: key() }, { roomMention: extra.roomMention });
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
      await markAllChatRead(sam);
      const sidebar = await listConversations(sam);
      assert.equal(sidebar.unreadConversations, 0);
      assert.deepEqual(sidebar.threads, { unread: 0, mentions: 0 });
      assert.deepEqual((await listUnreads(sam)).groups, []);
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
