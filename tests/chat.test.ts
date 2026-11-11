import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { ChatLiveEvent } from "@/lib/chat/types";
import {
  addRoomMembers,
  createRoom,
  deleteMessage,
  editMessage,
  getRoom,
  leaveRoom,
  listChatPeople,
  listConversations,
  listMessages,
  listThread,
  listThreads,
  markConversationRead,
  markThreadRead,
  openDm,
  postMessage,
  removeRoomMember,
  chatWorkSettled,
  searchMessages,
  updateRoom,
} from "@/lib/crm/chat";
import { CrmError } from "@/lib/crm/errors";
import { removeMember } from "@/lib/crm/team";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { openChatTyping, watchChat, watchLiveActivity } from "@/lib/docs/live/client";
import { memoryHub } from "@/lib/docs/live/transport";
import { canonicalTopic, chatTopic, parseTopic, personTopic } from "@/lib/docs/live/protocol";
import { relayAllows, relayEventAllowed, relayPayload } from "@/lib/docs/live/relay-access";
import { upToBody } from "@/lib/chat/http";
import { savePushSubscription } from "@/lib/push";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

after(async () => {
  await getPool().end();
});

async function sql(text: string, values: unknown[] = []) {
  return getAdminPool().query(text, values);
}

async function until(check: () => Promise<boolean> | boolean, label: string) {
  for (let tries = 0; tries < 400; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function tag(person: UserActor) {
  return `@[${person.fullName}](member:${person.userId})`;
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

async function notifications(userId: string) {
  return (await sql("select title, href, source from crm.notifications where user_id = $1 order by created_at, id", [userId])).rows as { title: string; href: string; source: string }[];
}

describe("chat", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let olly: UserActor;
  let ridgeon: string;
  let broadcasts: LiveMessage[];

  function chatEvents(userId: string) {
    return broadcasts.filter((message) => message.topic === personTopic(userId) && message.event === "chat").map((message) => message.payload as ChatLiveEvent);
  }

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@eclipse.test", "Mark Ridgeon");
    const samUser = await createUser("sam@eclipse.test", "Sam Okafor");
    const priyaUser = await createUser("priya@eclipse.test", "Priya Nair");
    olly = await createUser("olly@elsewhere.test", "Olly Outside");
    const ridgeonOwner = await createUser("owner@ridgeon.test", "Ridgeon Owner");
    ridgeon = ridgeonOwner.workspaceId;
    await sql("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    await sql("update crm.workspaces set name = 'Ridgeon' where id = $1", [ridgeon]);
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')", [mark.workspaceId, samUser.userId, priyaUser.userId]);
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [ridgeon, mark.userId]);
    sam = { ...samUser, workspaceId: mark.workspaceId, role: "member" };
    priya = { ...priyaUser, workspaceId: mark.workspaceId, role: "member" };
  });

  beforeEach(async () => {
    broadcasts = [];
    setLiveTesting({ batch: async (messages) => void broadcasts.push(...messages) });
    await sql("truncate crm.push_log, crm.notifications");
  });

  afterEach(() => {
    setLiveTesting(null);
  });

  describe("creating", () => {
    it("creates a room with its members and refuses people outside your workspaces", async () => {
      const room = await createRoom(mark, { name: "#sales", memberIds: [sam.userId, priya.userId] });
      assert.equal(room.kind, "room");
      assert.equal(room.name, "sales");
      const detail = await getRoom(sam, room.id);
      assert.deepEqual(detail.members.map((member) => member.id).sort(), [mark.userId, sam.userId, priya.userId].sort());
      assert.equal(detail.createdBy, mark.userId);
      await refused(createRoom(mark, { name: "mixed", memberIds: [olly.userId] }), /Someone you picked doesn't share a workspace with you\./);
      await refused(createRoom(mark, { name: "  " }), /Give the room a name\./);
      await refused(createRoom(olly, { name: "elsewhere", workspaceId: mark.workspaceId }), /Pick one of your workspaces\./);
      await until(() => chatEvents(sam.userId).some((event) => event.type === "conversation" && event.conversationId === room.id), "room broadcast");
    });

    it("limits a linked room to its workspace's members", async () => {
      await refused(createRoom(mark, { name: "ridgeon-only", workspaceId: ridgeon, memberIds: [sam.userId] }), /Someone you picked isn't in this room's workspace/);
      const room = await createRoom(mark, { name: "eclipse-only", workspaceId: mark.workspaceId, memberIds: [sam.userId] });
      assert.equal(room.workspaceName, "Eclipse");
      await refused(updateRoom(mark, room.id, { workspaceId: ridgeon }), /Sam Okafor isn't in that workspace/);
      const unlinked = await updateRoom(sam, room.id, { name: "renamed", workspaceId: null });
      assert.equal(unlinked.workspaceId, null);
      assert.equal(unlinked.name, "renamed");
    });

    it("gives two people starting a DM at once the same conversation", async () => {
      const [one, two, three] = await Promise.all([openDm(mark, sam.userId), openDm(sam, mark.userId), openDm(mark, sam.userId)]);
      assert.equal(one.id, two.id);
      assert.equal(one.id, three.id);
      assert.equal(one.name, "Sam Okafor");
      assert.equal(two.name, "Mark Ridgeon");
      const rows = await sql("select count(*)::int as n from crm.chat_conversations where kind = 'dm'");
      assert.equal(rows.rows[0].n, 1);
      assert.equal((await sql("select count(*)::int as n from crm.chat_members where conversation_id = $1", [one.id])).rows[0].n, 2);
      await refused(openDm(mark, olly.userId), /share a workspace/);
      await refused(openDm(mark, mark.userId), /other than yourself/);
    });

    it("hides an empty DM from the person who didn't open it", async () => {
      const dm = await openDm(priya, sam.userId);
      assert.ok((await listConversations(priya)).conversations.some((conversation) => conversation.id === dm.id));
      assert.ok(!(await listConversations(sam)).conversations.some((conversation) => conversation.id === dm.id));
      await postMessage(priya, { conversationId: dm.id, body: "Hello", clientKey: "dm-hello" });
      assert.ok((await listConversations(sam)).conversations.some((conversation) => conversation.id === dm.id));
    });

    it("lists people who share a workspace with you", async () => {
      const people = await listChatPeople(mark);
      const ids = people.map((person) => person.id);
      assert.ok(ids.includes(sam.userId) && ids.includes(priya.userId));
      assert.ok(!ids.includes(mark.userId) && !ids.includes(olly.userId));
      const linked = await listChatPeople(mark, { workspaceId: ridgeon });
      assert.ok(!linked.some((person) => person.id === sam.userId));
    });
  });

  describe("access", () => {
    let room: string;
    let message: string;

    before(async () => {
      room = (await createRoom(mark, { name: "private-room", memberIds: [sam.userId] })).id;
      message = (await postMessage(mark, { conversationId: room, body: "Members only", clientKey: "access-1" })).message.id;
    });

    it("keeps a room's conversation, members and messages from non-members", async () => {
      for (const table of ["chat_conversations", "chat_members"]) {
        const column = table === "chat_conversations" ? "id" : "conversation_id";
        assert.equal((await queryAsUser(priya.userId, `select 1 from crm.${table} where ${column} = $1`, [room])).length, 0);
        assert.equal((await queryAsUser(sam.userId, `select 1 from crm.${table} where ${column} = $1`, [room])).length > 0, true);
      }
      assert.equal((await queryAsUser(priya.userId, "select 1 from crm.chat_messages where id = $1", [message])).length, 0);
      await refused(listMessages(priya, room), /Conversation not found\./);
      await refused(getRoom(olly, room), /Conversation not found\./);
      await refused(searchMessages(priya, room, "Members"), /Conversation not found\./);
      await refused(listThread(priya, message), /Thread not found\./);
    });

    it("refuses posts from non-members, through the service and straight into the table", async () => {
      await refused(postMessage(priya, { conversationId: room, body: "Let me in" }), /Conversation not found\./);
      await assert.rejects(
        queryAsUser(priya.userId, "insert into crm.chat_messages (conversation_id, author_user_id, body) values ($1, $2, 'sneaky')", [room, priya.userId]),
        /row-level security/,
      );
      await assert.rejects(
        queryAsUser(sam.userId, "insert into crm.chat_messages (conversation_id, author_user_id, body) values ($1, $2, 'as Mark')", [room, mark.userId]),
        /row-level security/,
      );
      await assert.rejects(queryAsUser(sam.userId, "insert into crm.chat_members (conversation_id, user_id) values ($1, $2)", [room, priya.userId]), /permission denied/);
      await assert.rejects(queryAsUser(sam.userId, "update crm.chat_conversations set name = 'x' where id = $1", [room]), /permission denied/);
    });

    it("lets people edit and delete only their own messages", async () => {
      await refused(editMessage(sam, message, "Changed by Sam"), /only change your own messages/);
      await refused(deleteMessage(sam, message), /only change your own messages/);
      const touched = await queryAsUser(sam.userId, "update crm.chat_messages set body = 'x' where id = $1 returning id", [message]);
      assert.equal(touched.length, 0);
      await assert.rejects(queryAsUser(sam.userId, "update crm.chat_messages set reply_count = 9 where id = $1", [message]), /permission denied/);
      await assert.rejects(queryAsUser(mark.userId, "delete from crm.chat_messages where id = $1", [message]), /permission denied/);
      const edited = await editMessage(mark, message, `Members only, ${tag(sam)}`);
      assert.ok(edited.editedAt);
      assert.deepEqual(edited.mentions, [sam.userId]);
      await until(() => chatEvents(sam.userId).some((event) => event.type === "edit" && event.message.id === message), "edit broadcast");
      await deleteMessage(mark, message);
      const page = await listMessages(sam, room);
      assert.ok(!page.messages.some((item) => item.id === message));
      await refused(editMessage(mark, message, "Back"), /was deleted/);
      await until(() => chatEvents(sam.userId).some((event) => event.type === "delete" && event.messageId === message), "delete broadcast");
    });

    it("lets only members follow a chat topic over the relay", async () => {
      assert.equal(await relayAllows(sam, chatTopic(room), false), true);
      assert.equal(await relayAllows(sam, chatTopic(room), true), true);
      assert.equal(await relayAllows(priya, chatTopic(room), false), false);
      assert.equal(await relayAllows(olly, chatTopic(room), true), false);
      assert.deepEqual(parseTopic(`chat:${room.toUpperCase()}`), { kind: "chat", id: room });
      assert.equal(canonicalTopic(`chat:${room.toUpperCase()}`), `chat:${room}`);
      assert.equal(parseTopic("chat:nope"), null);
    });
  });

  describe("posting", () => {
    let room: string;

    before(async () => {
      room = (await createRoom(mark, { name: "sales", memberIds: [sam.userId, priya.userId] })).id;
    });

    it("treats a repeated client key as the same message", async () => {
      const first = await postMessage(sam, { conversationId: room, body: "Once", clientKey: "same-key" });
      const again = await postMessage(sam, { conversationId: room, body: "Once", clientKey: "same-key" });
      assert.equal(first.duplicate, false);
      assert.equal(again.duplicate, true);
      assert.equal(again.message.id, first.message.id);
      assert.equal((await sql("select count(*)::int as n from crm.chat_messages where client_key = 'same-key'")).rows[0].n, 1);
      assert.equal(first.message.author.name, "Sam Okafor");
      const other = await openDm(sam, mark.userId);
      await refused(postMessage(sam, { conversationId: other.id, body: "Once", clientKey: "same-key" }), /already used/);
      await refused(postMessage(sam, { conversationId: room, body: "   " }), /Write a message first\./);
      await refused(postMessage(sam, { conversationId: room, body: "x".repeat(10_001) }), /10,000 characters/);
    });

    it("broadcasts each new message once to every member's person channel", async () => {
      const posted = await postMessage(priya, { conversationId: room, body: "Broadcast me", clientKey: "broadcast-1" });
      await until(() => broadcasts.filter((message) => (message.payload as ChatLiveEvent).type === "message" && (message.payload as { message: { id: string } }).message.id === posted.message.id).length === 3, "message broadcasts");
      for (const person of [mark, sam, priya]) {
        const events = chatEvents(person.userId).filter((event) => event.type === "message" && event.message.id === posted.message.id);
        assert.equal(events.length, 1);
      }
      assert.ok(!broadcasts.some((message) => message.topic === personTopic(olly.userId)));
      assert.ok(!broadcasts.some((message) => message.topic === chatTopic(room)));
    });

    it("never alerts for a room message without a mention", async () => {
      await postMessage(mark, { conversationId: room, body: "Plain update", clientKey: "plain-1" });
      await chatWorkSettled();
      assert.equal((await sql("select count(*)::int as n from crm.notifications")).rows[0].n, 0);
    });

    it("alerts people mentioned in a room, generically, and only members", async () => {
      const posted = await postMessage(mark, { conversationId: room, body: `${tag(sam)} ${tag(olly)} can you send the pricing?`, clientKey: "mention-1" });
      assert.deepEqual(posted.message.mentions.sort(), [sam.userId, olly.userId].sort());
      await until(async () => (await notifications(sam.userId)).length === 1, "mention alert");
      const [alert] = await notifications(sam.userId);
      assert.deepEqual(alert, { title: "Mark mentioned you in #sales", href: `/chat/${room}?message=${posted.message.id}`, source: "chat" });
      assert.equal((await notifications(olly.userId)).length, 0);
      assert.equal((await notifications(priya.userId)).length, 0);
    });

    it("alerts DMs once per unread burst", async () => {
      const dm = await openDm(mark, priya.userId);
      await postMessage(mark, { conversationId: dm.id, body: "One", clientKey: "dm-1" });
      await until(async () => (await notifications(priya.userId)).length === 1, "first DM alert");
      await postMessage(mark, { conversationId: dm.id, body: "Two", clientKey: "dm-2" });
      await chatWorkSettled();
      assert.equal((await notifications(priya.userId)).length, 1);
      assert.equal((await notifications(priya.userId))[0].title, "Mark sent you a message");
      await markConversationRead(priya, dm.id);
      await postMessage(mark, { conversationId: dm.id, body: "Three", clientKey: "dm-3" });
      await until(async () => (await notifications(priya.userId)).length === 2, "second DM alert");
      assert.equal((await notifications(mark.userId)).length, 0);
    });

    it("counts replies, follows threads and alerts followers", async () => {
      const root = await postMessage(priya, { conversationId: room, body: "Halden signed the pilot.", clientKey: "root-1" });
      const reply = await postMessage(sam, { conversationId: room, parentId: root.message.id, body: "Who's running kick-off?", clientKey: "reply-1" });
      assert.equal(reply.root?.replyCount, 1);
      assert.deepEqual(reply.root?.replyAuthors, [{ id: sam.userId, name: "Sam Okafor" }]);
      await until(async () => (await notifications(priya.userId)).length === 1, "thread alert to root author");
      assert.equal((await notifications(priya.userId))[0].title, "Sam replied in a thread in #sales");
      assert.equal((await notifications(priya.userId))[0].href, `/chat/${room}?thread=${root.message.id}`);
      assert.equal((await notifications(mark.userId)).length, 0);
      const second = await postMessage(mark, { conversationId: room, parentId: root.message.id, body: `${tag(priya)} is.`, clientKey: "reply-2" });
      await until(async () => (await notifications(sam.userId)).length === 1, "thread alert to replier");
      await until(async () => (await notifications(priya.userId)).length === 2, "mention in thread");
      assert.equal((await notifications(priya.userId))[1].title, "Mark mentioned you in #sales");
      const thread = await listThread(priya, root.message.id);
      assert.equal(thread.root.replyCount, 2);
      assert.deepEqual(
        thread.replies.map((item) => item.id),
        [reply.message.id, second.message.id],
      );
      assert.equal(thread.following, true);
      await deleteMessage(sam, reply.message.id);
      const after = await listThread(priya, root.message.id);
      assert.equal(after.root.replyCount, 1);
      assert.equal(after.root.lastReplyAt, second.message.createdAt);
      await refused(postMessage(sam, { conversationId: room, parentId: reply.message.id, body: "Nested" }), /deleted|Reply to a message/);
      await refused(postMessage(sam, { conversationId: room, parentId: second.message.id, body: "Nested" }), /Reply to a message in this conversation\./);
      const elsewhere = await createRoom(sam, { name: "elsewhere", memberIds: [] });
      await refused(postMessage(sam, { conversationId: elsewhere.id, parentId: root.message.id, body: "Wrong room" }), /Reply to a message in this conversation\./);
    });
  });

  describe("reading", () => {
    let room: string;
    let ids: string[];

    before(async () => {
      room = (await createRoom(mark, { name: "paging", memberIds: [sam.userId] })).id;
      ids = [];
      for (let index = 0; index < 120; index += 1) {
        ids.push((await postMessage(index < 60 ? mark : sam, { conversationId: room, body: `Message ${index}`, clientKey: `page-${index}` })).message.id);
      }
    });

    it("pages by keyset in both directions", async () => {
      const latest = await listMessages(mark, room, { limit: 50 });
      assert.deepEqual(
        latest.messages.map((message) => message.id),
        ids.slice(70),
      );
      assert.equal(latest.hasOlder, true);
      assert.equal(latest.hasNewer, false);
      const older = await listMessages(mark, room, { before: latest.messages[0].id, limit: 50 });
      assert.deepEqual(
        older.messages.map((message) => message.id),
        ids.slice(20, 70),
      );
      const oldest = await listMessages(mark, room, { before: older.messages[0].id, limit: 50 });
      assert.deepEqual(
        oldest.messages.map((message) => message.id),
        ids.slice(0, 20),
      );
      assert.equal(oldest.hasOlder, false);
      const newer = await listMessages(mark, room, { after: ids[9], limit: 10 });
      assert.deepEqual(
        newer.messages.map((message) => message.id),
        ids.slice(10, 20),
      );
      assert.equal(newer.hasNewer, true);
    });

    it("opens around the unread divider and counts unread in the sidebar", async () => {
      const sidebar = await listConversations(mark);
      const entry = sidebar.conversations.find((conversation) => conversation.id === room)!;
      assert.equal(entry.unread, 60);
      assert.equal(entry.mentions, 0);
      const page = await listMessages(mark, room, { around: "unread", limit: 20 });
      assert.equal(page.firstUnreadId, ids[60]);
      assert.deepEqual(
        page.messages.map((message) => message.id),
        ids.slice(50, 80),
      );
      assert.equal(page.hasOlder, true);
      assert.equal(page.hasNewer, true);
      await markConversationRead(mark, room, ids[89]);
      assert.equal((await listConversations(mark)).conversations.find((conversation) => conversation.id === room)!.unread, 30);
      await markConversationRead(mark, room, ids[10]);
      assert.equal((await listConversations(mark)).conversations.find((conversation) => conversation.id === room)!.unread, 30);
      await markConversationRead(mark, room);
      assert.equal((await listConversations(mark)).conversations.find((conversation) => conversation.id === room)!.unread, 0);
      await until(() => chatEvents(mark.userId).some((event) => event.type === "read" && event.conversationId === room), "read broadcast");
    });

    it("searches within one conversation", async () => {
      const found = await searchMessages(sam, room, "Message 11");
      assert.deepEqual(found.messages.map((message) => message.body).sort(), ["Message 11", "Message 110", "Message 111", "Message 112", "Message 113", "Message 114", "Message 115", "Message 116", "Message 117", "Message 118", "Message 119"].sort());
      assert.deepEqual((await searchMessages(sam, room, "100%")).messages, []);
    });

    it("lists followed room and DM threads with unread replies first", async () => {
      const root = await postMessage(sam, { conversationId: room, body: "Thread root", clientKey: "threads-root" });
      await postMessage(mark, { conversationId: room, parentId: root.message.id, body: "First reply", clientKey: "threads-r1" });
      await postMessage(mark, { conversationId: room, parentId: root.message.id, body: "Second reply", clientKey: "threads-r2" });
      await postMessage(mark, { conversationId: room, parentId: root.message.id, body: `Third ${tag(sam)}`, clientKey: "threads-r3" });
      const sidebar = await listConversations(sam);
      assert.ok(sidebar.threads.unread >= 1);
      assert.ok(sidebar.threads.mentions >= 1);
      assert.equal(sidebar.mentioned, true);
      const view = await listThreads(sam);
      const card = view.threads.find((item) => item.root.id === root.message.id)!;
      assert.equal(card.unread, 3);
      assert.equal(card.mentions, 1);
      assert.equal(card.earlier, 1);
      assert.deepEqual(
        card.latest.map((message) => message.body),
        ["Second reply", `Third ${tag(sam)}`],
      );
      assert.deepEqual(card.conversation, { id: room, kind: "room", name: "paging" });
      assert.equal(view.threads[0].unread > 0, true);
      await markThreadRead(sam, root.message.id);
      assert.equal((await listThreads(sam)).threads.find((item) => item.root.id === root.message.id)!.unread, 0);
      assert.deepEqual(await markThreadRead(priya, root.message.id).catch((error: Error) => error.message), "Thread not found.");
    });
  });

  describe("membership", () => {
    it("lets any member add and remove people, and refuses a removed member's writes", async () => {
      const room = await createRoom(mark, { name: "ops", memberIds: [sam.userId] });
      const added = await addRoomMembers(sam, room.id, [priya.userId]);
      assert.deepEqual(added.added, [priya.userId]);
      await refused(addRoomMembers(sam, room.id, [olly.userId]), /doesn't share a workspace with you/);
      await removeRoomMember(sam, room.id, priya.userId);
      await until(() => chatEvents(priya.userId).some((event) => event.type === "removed" && event.conversationId === room.id), "removed event");
      await refused(postMessage(priya, { conversationId: room.id, body: "Still here?" }), /Conversation not found\./);
      await refused(removeRoomMember(priya, room.id, sam.userId), /Room not found\./);
      assert.equal(await relayAllows(priya, chatTopic(room.id), true), false);
      await leaveRoom(sam, room.id);
      const left = await leaveRoom(mark, room.id);
      assert.equal(left.deleted, true);
      assert.equal((await sql("select count(*)::int as n from crm.chat_conversations where id = $1", [room.id])).rows[0].n, 0);
    });

    it("removes people who leave a workspace from its linked rooms and from conversations they no longer share a workspace in", async () => {
      const samHomeId = (await sql("select private.home_workspace_id($1) as id", [sam.userId])).rows[0].id as string;
      await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [samHomeId, olly.userId]);
      const linked = await createRoom(mark, { name: "eclipse-team", workspaceId: mark.workspaceId, memberIds: [sam.userId, priya.userId] });
      const open = await createRoom(mark, { name: "friends", memberIds: [sam.userId] });
      const bridged = await createRoom(sam, { name: "bridge", memberIds: [mark.userId, olly.userId] });
      const dm = await openDm(mark, sam.userId);
      await postMessage(sam, { conversationId: linked.id, body: "Bye", clientKey: "leave-1" });
      await postMessage(sam, { conversationId: dm.id, body: "Keep this", clientKey: "leave-2" });
      const movedRows = await sql("select count(*)::int as n from crm.chat_messages where author_user_id = $1", [sam.userId]);
      await removeMember(mark, sam.userId);
      for (const gone of [linked.id, open.id, dm.id]) {
        assert.ok(chatEvents(sam.userId).some((event) => event.type === "removed" && event.conversationId === gone), `removed from ${gone}`);
        assert.ok(chatEvents(mark.userId).some((event) => event.type === "conversation" && event.conversationId === gone));
      }
      assert.ok(!chatEvents(sam.userId).some((event) => event.type === "removed" && event.conversationId === bridged.id));
      assert.ok(chatEvents(priya.userId).some((event) => event.type === "conversation" && event.conversationId === linked.id));
      const samHome: UserActor = { ...sam, workspaceId: samHomeId };
      const ids = (await listConversations(samHome)).conversations.map((conversation) => conversation.id);
      assert.deepEqual(
        [linked.id, open.id, dm.id, bridged.id].map((id) => ids.includes(id)),
        [false, false, false, true],
      );
      assert.equal((await sql("select count(*)::int as n from crm.chat_members where conversation_id = $1", [open.id])).rows[0].n, 1);
      assert.equal((await sql("select count(*)::int as n from crm.chat_messages where author_user_id = $1", [sam.userId])).rows[0].n, movedRows.rows[0].n);
      const history = await listMessages(mark, linked.id);
      assert.equal(history.messages.find((message) => message.body === "Bye")?.author.name, "Sam Okafor");
      const markDm = (await listConversations(mark)).conversations.find((conversation) => conversation.id === dm.id)!;
      assert.equal(markDm.name, "Sam Okafor");
      await refused(postMessage(mark, { conversationId: dm.id, body: "Are you there?" }), /no longer share a workspace/);
      const room = await getRoom(mark, bridged.id);
      assert.equal(room.members.find((member) => member.id === olly.userId)?.name, "Olly Outside");
      await postMessage(mark, { conversationId: bridged.id, body: `${tag(olly)} welcome`, clientKey: "leave-3" });
      await chatWorkSettled();
      assert.ok((await notifications(olly.userId)).some((alert) => alert.title === "Mark mentioned you in #bridge"));
      await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [samHomeId, olly.userId]);
      await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, sam.userId]);
    });
  });

  describe("realtime policies", () => {
    let room: string;

    before(async () => {
      const admin = getAdminPool();
      const exists = await admin.query<{ found: boolean }>("select to_regclass('realtime.messages') is not null as found");
      if (!exists.rows[0].found) await admin.query(readFileSync("supabase/bootstrap/local-realtime.sql", "utf8"));
      await admin.query(readFileSync("supabase/migrations/20261216100000_docs_realtime.sql", "utf8"));
      await admin.query(readFileSync("supabase/migrations/20270116120000_chat.sql", "utf8"));
      room = (await createRoom(mark, { name: "live", memberIds: [sam.userId] })).id;
    });

    async function access(userId: string, topic: string) {
      const client = await getAdminPool().connect();
      try {
        await client.query("begin");
        await client.query("insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true)", [topic]);
        await client.query("select set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)", [
          JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" }),
          topic,
        ]);
        await client.query("set local role authenticated");
        const read = (await client.query("select id from realtime.messages where topic = $1 and extension = 'broadcast'", [topic])).rows.length > 0;
        await client.query("savepoint send");
        let write = true;
        try {
          await client.query("insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true)", [topic]);
        } catch {
          write = false;
          await client.query("rollback to savepoint send");
        }
        return { read, write };
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    }

    it("lets members join and type on chat topics, and nobody else", async () => {
      assert.deepEqual(await access(sam.userId, chatTopic(room)), { read: true, write: true });
      assert.deepEqual(await access(priya.userId, chatTopic(room)), { read: false, write: false });
      assert.deepEqual(await access(olly.userId, chatTopic(room)), { read: false, write: false });
      assert.deepEqual(await access(sam.userId, "chat:not-a-uuid"), { read: false, write: false });
    });
  });

  describe("live client", () => {
    it("shares the person channel with the bell, keeps only chat events and carries typing on the chat topic", async () => {
      const hub = memoryHub();
      const transport = hub.transport();
      const userId = "00000000-0000-4000-8000-0000000000ee";
      const conversationId = "00000000-0000-4000-8000-0000000000ff";
      const events: ChatLiveEvent[] = [];
      const alerts: string[] = [];
      let joined = false;
      const stopBell = await watchLiveActivity(transport, { workspaceId: conversationId, userId }, null, () => {}, (message) => alerts.push(message.source));
      const stopChat = await watchChat(transport, userId, (event) => events.push(event), (value) => (joined = value));
      await until(() => joined, "chat joins");
      hub.publish(personTopic(userId), "chat", { type: "read", conversationId, lastReadAt: "2026-11-11T09:00:00.000Z" });
      hub.publish(personTopic(userId), "chat", { type: "forged", conversationId });
      hub.publish(personTopic(userId), "alert", { source: "chat" });
      await until(() => events.length === 1 && alerts.length === 1, "chat and alert arrive");
      assert.deepEqual(events, [{ type: "read", conversationId, lastReadAt: "2026-11-11T09:00:00.000Z" }]);
      const seen: string[] = [];
      const other = hub.transport();
      const listener = await openChatTyping(other, conversationId, (typing) => seen.push(`${typing.user.name}:${typing.typing}`));
      const typist = await openChatTyping(transport, conversationId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      typist.send({ conversationId, user: { id: userId, name: "Sam" }, typing: true });
      await until(() => seen.length === 1, "typing arrives");
      assert.deepEqual(seen, ["Sam:true"]);
      typist.close();
      listener.close();
      stopChat();
      stopBell();
    });
  });

  describe("review fixes", () => {
    it("keeps alerting a DM after a thread reply, keyed on the conversation for roots and the thread for replies", async () => {
      const dm = await openDm(sam, priya.userId);
      await markConversationRead(priya, dm.id);
      const root = await postMessage(sam, { conversationId: dm.id, body: "Root one", clientKey: "dmt-root-1" });
      await until(async () => (await notifications(priya.userId)).length === 1, "root alert");
      await markConversationRead(priya, dm.id);
      await postMessage(sam, { conversationId: dm.id, parentId: root.message.id, body: "Reply one", clientKey: "dmt-reply-1" });
      await until(async () => (await notifications(priya.userId)).length === 2, "reply alert");
      await postMessage(sam, { conversationId: dm.id, body: "Root two", clientKey: "dmt-root-2" });
      await until(async () => (await notifications(priya.userId)).length === 3, "root alert after a reply alert");
      await markThreadRead(priya, root.message.id);
      await postMessage(sam, { conversationId: dm.id, parentId: root.message.id, body: "Reply two", clientKey: "dmt-reply-2" });
      await until(async () => (await notifications(priya.userId)).length === 4, "reply alert after reading the thread");
      assert.deepEqual(
        (await notifications(priya.userId)).map((alert) => alert.title),
        ["Sam sent you a message", "Sam replied in a thread", "Sam sent you a message", "Sam replied in a thread"],
      );
      const bodies = await sql("select distinct body from crm.notifications where user_id = $1", [priya.userId]);
      assert.deepEqual(bodies.rows, [{ body: null }]);
      const card = (await listThreads(priya)).threads.find((thread) => thread.root.id === root.message.id);
      assert.equal(card?.unread, 1);
      assert.equal(card?.conversation.kind, "dm");
    });

    it("keeps reply counts right under concurrent replies and deletes", async () => {
      const room = (await createRoom(mark, { name: "busy", memberIds: [sam.userId, priya.userId] })).id;
      const root = (await postMessage(mark, { conversationId: room, body: "Busy root", clientKey: "busy-root" })).message.id;
      const early: string[] = [];
      for (let index = 0; index < 8; index += 1) early.push((await postMessage(sam, { conversationId: room, parentId: root, body: `Early ${index}`, clientKey: `busy-early-${index}` })).message.id);
      await Promise.all([
        ...early.map((id) => deleteMessage(sam, id)),
        ...Array.from({ length: 8 }, (_, index) => postMessage(index % 2 ? priya : mark, { conversationId: room, parentId: root, body: `Late ${index}`, clientKey: `busy-late-${index}` })),
      ]);
      const check = await sql(
        `select r.reply_count, r.last_reply_at = (select max(created_at) from crm.chat_messages where parent_id = r.id and deleted_at is null) as latest_ok,
           (select count(*)::int from crm.chat_messages where parent_id = r.id and deleted_at is null) as actual
         from crm.chat_messages r where r.id = $1`,
        [root],
      );
      assert.equal(check.rows[0].reply_count, 8);
      assert.equal(check.rows[0].actual, 8);
      assert.equal(check.rows[0].latest_ok, true);
    });

    it("leaves chat untouched when personal rows move workspace", async () => {
      const before = await listConversations(priya);
      const counts = async () =>
        (await sql("select (select count(*)::int from crm.chat_members where user_id = $1) as members, (select count(*)::int from crm.chat_messages where author_user_id = $1) as messages", [priya.userId])).rows[0];
      const was = await counts();
      const home = (await sql("select private.home_workspace_id($1) as id", [priya.userId])).rows[0].id as string;
      await savePushSubscription({ ...priya, workspaceId: home }, { endpoint: "https://web.push.apple.com/priya-move", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
      const device = async () => (await sql("select workspace_id from crm.push_subscriptions where user_id = $1", [priya.userId])).rows[0]?.workspace_id;
      assert.equal(await device(), home);
      await sql("select private.move_personal_rows($1, $2, $3)", [priya.userId, home, mark.workspaceId]);
      assert.equal(await device(), mark.workspaceId);
      assert.deepEqual(await counts(), was);
      assert.deepEqual(
        (await listConversations(priya)).conversations.map((conversation) => conversation.id),
        before.conversations.map((conversation) => conversation.id),
      );
    });

    it("keeps a DM, thread follows and read marks from everyone else", async () => {
      const dm = await openDm(mark, sam.userId);
      const posted = await postMessage(mark, { conversationId: dm.id, body: "Just us", clientKey: "private-dm" });
      await refused(listMessages(priya, dm.id), /Conversation not found\./);
      assert.equal((await queryAsUser(priya.userId, "select 1 from crm.chat_messages where conversation_id = $1", [dm.id])).length, 0);
      assert.equal((await queryAsUser(priya.userId, "select 1 from crm.chat_members where conversation_id = $1", [dm.id])).length, 0);
      await postMessage(sam, { conversationId: dm.id, parentId: posted.message.id, body: "Reply", clientKey: "private-dm-reply" });
      assert.equal((await queryAsUser(priya.userId, "select 1 from crm.chat_thread_reads where message_id = $1", [posted.message.id])).length, 0);
      assert.equal((await queryAsUser(sam.userId, "select 1 from crm.chat_thread_reads where user_id = $1", [mark.userId])).length, 0);
      const moved = await queryAsUser(sam.userId, "update crm.chat_members set last_read_at = now() where conversation_id = $1 and user_id = $2 returning 1", [dm.id, mark.userId]);
      assert.equal(moved.length, 0);
      await assert.rejects(queryAsUser(sam.userId, "insert into crm.chat_thread_reads (message_id, user_id) values ($1, $2)", [posted.message.id, mark.userId]), /row-level security/);
      await assert.rejects(queryAsUser(priya.userId, "insert into crm.chat_thread_reads (message_id, user_id) values ($1, $2)", [posted.message.id, priya.userId]), /row-level security/);
    });

    it("shows task and doc discussions to whoever can see the task or the shared doc, and follows only them", async () => {
      const task = (await sql("insert into crm.tasks (workspace_id, title, owner_id, created_by_user_id) values ($1, 'Send pricing', $2, $3) returning id", [mark.workspaceId, priya.userId, mark.userId])).rows[0].id;
      const taskChat = (await sql("insert into crm.chat_conversations (kind, task_id) values ('task', $1) returning id", [task])).rows[0].id;
      const shared = (await sql("insert into crm.pages (workspace_id, user_id, title, shared) values ($1, $2, 'Plan', true) returning id", [mark.workspaceId, mark.userId])).rows[0].id;
      const hidden = (await sql("insert into crm.pages (workspace_id, user_id, title, shared) values ($1, $2, 'Mine', false) returning id", [mark.workspaceId, mark.userId])).rows[0].id;
      const sharedChat = (await sql("insert into crm.chat_conversations (kind, page_id) values ('doc', $1) returning id", [shared])).rows[0].id;
      const hiddenChat = (await sql("insert into crm.chat_conversations (kind, page_id) values ('doc', $1) returning id", [hidden])).rows[0].id;
      const sees = async (userId: string, id: string) => (await queryAsUser(userId, "select 1 from crm.chat_conversations where id = $1", [id])).length > 0;
      assert.equal(await sees(priya.userId, taskChat), true);
      assert.equal(await sees(mark.userId, taskChat), true);
      assert.equal(await sees(sam.userId, taskChat), false);
      assert.equal(await sees(sam.userId, sharedChat), true);
      assert.equal(await sees(olly.userId, sharedChat), false);
      assert.equal(await sees(sam.userId, hiddenChat), false);
      assert.equal(await sees(mark.userId, hiddenChat), false);
      const root = (await sql("insert into crm.chat_messages (conversation_id, author_user_id, body) values ($1, $2, 'Root') returning id", [taskChat, mark.userId])).rows[0].id;
      await sql("insert into crm.chat_messages (conversation_id, parent_id, author_user_id, body, mentions) values ($1, $2, $3, 'Reply', $4)", [taskChat, root, mark.userId, [sam.userId, priya.userId]]);
      const followers = (await sql("select user_id from crm.chat_thread_reads where message_id = $1 order by user_id", [root])).rows.map((row) => row.user_id);
      assert.deepEqual(followers, [mark.userId, priya.userId].sort());
    });

    it("refuses a removed member's reads, edits and deletes", async () => {
      const room = (await createRoom(mark, { name: "temporary", memberIds: [priya.userId] })).id;
      const own = (await postMessage(priya, { conversationId: room, body: "Mine", clientKey: "temporary-1" })).message.id;
      await removeRoomMember(mark, room, priya.userId);
      await refused(listMessages(priya, room), /Conversation not found\./);
      await refused(getRoom(priya, room), /Conversation not found\./);
      await refused(listThread(priya, own), /Thread not found\./);
      await refused(editMessage(priya, own, "Changed"), /Message not found\./);
      await refused(deleteMessage(priya, own), /Message not found\./);
      await refused(markConversationRead(priya, room), /Conversation not found\./);
    });

    it("lets only typing through the relay on chat topics, stamped with the sender", () => {
      const topic = chatTopic("00000000-0000-4000-8000-000000000001");
      assert.equal(relayEventAllowed(topic, "typing"), true);
      assert.equal(relayEventAllowed(topic, "update"), false);
      assert.equal(relayEventAllowed(topic, "chat"), false);
      assert.equal(relayEventAllowed("doc:00000000-0000-4000-8000-000000000001", "typing"), false);
      assert.equal(relayEventAllowed("doc:00000000-0000-4000-8000-000000000001", "update"), true);
      assert.deepEqual(relayPayload(sam, topic, "typing", { user: { id: mark.userId, name: "Mark" }, typing: true }), {
        conversationId: "00000000-0000-4000-8000-000000000001",
        user: { id: sam.userId, name: "Sam Okafor" },
        typing: true,
      });
    });

    it("lists people with their names and emails", async () => {
      const people = await listChatPeople(mark);
      assert.deepEqual(
        people.find((person) => person.id === priya.userId),
        { id: priya.userId, name: "Priya Nair", email: "priya@eclipse.test" },
      );
    });

    it("refuses unknown cursors, opens a reply's root page and reports both edges", async () => {
      const room = (await createRoom(mark, { name: "cursors", memberIds: [sam.userId] })).id;
      const ids: string[] = [];
      for (let index = 0; index < 6; index += 1) ids.push((await postMessage(mark, { conversationId: room, body: `C${index}`, clientKey: `cursor-${index}` })).message.id);
      const reply = (await postMessage(sam, { conversationId: room, parentId: ids[3], body: "In thread", clientKey: "cursor-reply" })).message.id;
      const unknown = "00000000-0000-4000-8000-0000000000aa";
      await refused(listMessages(mark, room, { before: unknown }), /Message not found\./);
      await refused(listMessages(mark, room, { after: unknown }), /Message not found\./);
      await refused(listMessages(mark, room, { around: unknown }), /Message not found\./);
      await refused(listThread(mark, ids[3], { before: unknown }), /Message not found\./);
      const around = await listMessages(mark, room, { around: reply, limit: 2 });
      assert.deepEqual(
        around.messages.map((message) => message.id),
        [ids[2], ids[3], ids[4]],
      );
      const oldest = await listMessages(mark, room, { before: ids[1], limit: 5 });
      assert.deepEqual(
        oldest.messages.map((message) => message.id),
        [ids[0]],
      );
      assert.equal(oldest.hasOlder, false);
      assert.equal(oldest.hasNewer, true);
      const newest = await listMessages(mark, room, { after: ids[4], limit: 5 });
      assert.deepEqual(
        newest.messages.map((message) => message.id),
        [ids[5]],
      );
      assert.equal(newest.hasNewer, false);
      assert.equal(newest.hasOlder, true);
      await deleteMessage(mark, ids[5]);
      const afterDelete = await listMessages(mark, room, { before: ids[5], limit: 10 });
      assert.equal(afterDelete.hasNewer, false);
    });

    it("pages Threads by keyset without skipping or repeating", async () => {
      const room = (await createRoom(mark, { name: "many-threads", memberIds: [sam.userId] })).id;
      for (let index = 0; index < 7; index += 1) {
        const root = (await postMessage(sam, { conversationId: room, body: `T${index}`, clientKey: `many-${index}` })).message.id;
        await postMessage(mark, { conversationId: room, parentId: root, body: `R${index}`, clientKey: `many-reply-${index}` });
        if (index % 2 === 0) await markThreadRead(sam, root);
      }
      const all = await listThreads(sam, { limit: 50 });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof listThreads>> = await listThreads(sam, { limit: 3, cursor });
        seen.push(...page.threads.map((thread) => thread.root.id));
        cursor = page.next;
      } while (cursor);
      assert.deepEqual(
        seen,
        all.threads.map((thread) => thread.root.id),
      );
      assert.equal(new Set(seen).size, seen.length);
      await refused(listThreads(sam, { cursor: "not-a-cursor" }), /isn't valid/);
    });

    it("needs a message id when a read mark has a body", async () => {
      const post = (body: string) => new Request("https://orbit.test/api/chat/x/read", { method: "POST", body });
      assert.equal(await upToBody(new Request("https://orbit.test/api/chat/x/read", { method: "POST" })), null);
      assert.equal(await upToBody(post(JSON.stringify({ upTo: "00000000-0000-4000-8000-000000000001" }))), "00000000-0000-4000-8000-000000000001");
      for (const body of ["{}", '{"upTo":"later"}', "nonsense"]) {
        await assert.rejects(upToBody(post(body)), (error: unknown) => error instanceof CrmError && error.status === 400);
      }
    });

    it("hides other people's client keys and cleans bodies and mentions", async () => {
      const room = (await createRoom(mark, { name: "keys", memberIds: [sam.userId] })).id;
      const posted = await postMessage(sam, { conversationId: room, body: "Hi\u0000 there @[Ghost](member:zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz)", clientKey: "secret-key" });
      assert.equal(posted.message.clientKey, "secret-key");
      assert.ok(!posted.message.body.includes("\u0000"));
      assert.deepEqual(posted.message.mentions, []);
      const page = await listMessages(mark, room);
      assert.equal(page.messages.find((message) => message.id === posted.message.id)?.clientKey, null);
      await until(() => chatEvents(mark.userId).some((event) => event.type === "message" && event.message.id === posted.message.id), "broadcast to Mark");
      const toMark = chatEvents(mark.userId).find((event) => event.type === "message" && event.message.id === posted.message.id);
      const toSam = chatEvents(sam.userId).find((event) => event.type === "message" && event.message.id === posted.message.id);
      assert.equal(toMark?.type === "message" ? toMark.message.clientKey : "missing", null);
      assert.equal(toSam?.type === "message" ? toSam.message.clientKey : "missing", "secret-key");
    });

    it("caps mentions on edit and refuses empty bodies in the database", async () => {
      const room = (await createRoom(mark, { name: "caps", memberIds: [sam.userId] })).id;
      const posted = await postMessage(mark, { conversationId: room, body: "Short", clientKey: "caps-1" });
      const ids = Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
      await refused(editMessage(mark, posted.message.id, ids.map((id, index) => `@[P${index}](member:${id})`).join(" ")), /Tag up to 50 people/);
      await assert.rejects(queryAsUser(mark.userId, "update crm.chat_messages set mentions = $2::uuid[] where id = $1", [posted.message.id, ids]), /Tag up to 50 people/);
      await assert.rejects(queryAsUser(mark.userId, "update crm.chat_messages set body = '  ' where id = $1", [posted.message.id]), /chat_messages_body_present/);
      await assert.rejects(queryAsUser(mark.userId, "insert into crm.chat_messages (conversation_id, author_user_id, body) values ($1, $2, '')", [room, mark.userId]), /chat_messages_body_present/);
    });

    it("answers a retried reply as a duplicate after its root was deleted", async () => {
      const room = (await createRoom(mark, { name: "retry", memberIds: [sam.userId] })).id;
      const root = await postMessage(mark, { conversationId: room, body: "Root", clientKey: "retry-root" });
      const reply = await postMessage(sam, { conversationId: room, parentId: root.message.id, body: "Reply", clientKey: "retry-reply" });
      await deleteMessage(mark, root.message.id);
      const again = await postMessage(sam, { conversationId: room, parentId: root.message.id, body: "Reply", clientKey: "retry-reply" });
      assert.equal(again.duplicate, true);
      assert.equal(again.message.id, reply.message.id);
    });
  });

  describe("review round 3", () => {
    async function teammate(email: string, name: string) {
      const user = await createUser(email, name);
      await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, user.userId]);
      return { ...user, workspaceId: mark.workspaceId, role: "member" as const };
    }

    it("alerts and follows people newly tagged in an edit, once per message", async () => {
      const room = (await createRoom(mark, { name: "edits", memberIds: [sam.userId, priya.userId] })).id;
      const root = await postMessage(mark, { conversationId: room, body: "Plain", clientKey: "edit-root" });
      await editMessage(mark, root.message.id, `Plain ${tag(sam)}`);
      await chatWorkSettled();
      assert.deepEqual(
        (await notifications(sam.userId)).map((alert) => alert.title),
        ["Mark mentioned you in #edits"],
      );
      assert.equal((await sql("select count(*)::int as n from crm.chat_thread_reads where message_id = $1 and user_id = $2", [root.message.id, sam.userId])).rows[0].n, 1);
      await editMessage(mark, root.message.id, `Plain again ${tag(sam)}`);
      await chatWorkSettled();
      assert.equal((await notifications(sam.userId)).length, 1);

      const thread = await postMessage(priya, { conversationId: room, body: "Question", clientKey: "edit-thread" });
      const reply = await postMessage(sam, { conversationId: room, parentId: thread.message.id, body: "Answer", clientKey: "edit-reply" });
      await chatWorkSettled();
      assert.deepEqual(
        (await notifications(priya.userId)).map((alert) => alert.title),
        ["Sam replied in a thread in #edits"],
      );
      await editMessage(sam, reply.message.id, `Answer ${tag(priya)} ${tag(mark)}`);
      await chatWorkSettled();
      assert.equal((await notifications(priya.userId)).length, 1);
      assert.deepEqual(
        (await notifications(mark.userId)).map((alert) => alert.title),
        ["Sam mentioned you in #edits"],
      );
      assert.equal((await sql("select count(*)::int as n from crm.chat_thread_reads where message_id = $1 and user_id = $2", [thread.message.id, mark.userId])).rows[0].n, 1);

      const dm = await openDm(mark, priya.userId);
      const direct = await postMessage(mark, { conversationId: dm.id, body: "Hi", clientKey: "edit-dm" });
      await chatWorkSettled();
      const before = (await notifications(priya.userId)).length;
      await editMessage(mark, direct.message.id, `Hi ${tag(priya)}`);
      await chatWorkSettled();
      assert.equal((await notifications(priya.userId)).length, before);
    });

    it("links DM alerts to the conversation", async () => {
      const juno = await teammate("juno@eclipse.test", "Juno Park");
      const dm = await openDm(mark, juno.userId);
      await postMessage(mark, { conversationId: dm.id, body: "First", clientKey: "dm-link" });
      await chatWorkSettled();
      assert.deepEqual(await notifications(juno.userId), [{ title: "Mark sent you a message", href: `/chat/${dm.id}`, source: "chat" }]);
    });

    it("lists a DM while it has something to show, and for whoever opened it", async () => {
      const lena = await teammate("lena@eclipse.test", "Lena Brandt");
      const kai = await teammate("kai@eclipse.test", "Kai Moss");
      const listed = async (person: UserActor, id: string) => (await listConversations(person)).conversations.some((conversation) => conversation.id === id);
      const empty = await openDm(lena, kai.userId);
      assert.equal(await listed(lena, empty.id), true);
      assert.equal(await listed(kai, empty.id), false);
      await openDm(kai, lena.userId);
      assert.equal(await listed(kai, empty.id), true);
      const dm = await openDm(mark, lena.userId);
      const root = await postMessage(mark, { conversationId: dm.id, body: "Root", clientKey: "listed-root" });
      const reply = await postMessage(lena, { conversationId: dm.id, parentId: root.message.id, body: "Reply", clientKey: "listed-reply" });
      await deleteMessage(mark, root.message.id);
      assert.equal(await listed(lena, dm.id), true);
      await deleteMessage(lena, reply.message.id);
      assert.equal(await listed(lena, dm.id), false);
      assert.equal(await listed(mark, dm.id), true);
    });

    it("counts every unread mention, not only those among the newest messages", async () => {
      const room = (await createRoom(sam, { name: "counting", memberIds: [mark.userId] })).id;
      for (let index = 0; index < 3; index += 1) await postMessage(sam, { conversationId: room, body: `${tag(mark)} ${index}`, clientKey: `count-mention-${index}` });
      await sql(
        `insert into crm.chat_messages (conversation_id, author_user_id, body) select $1, $2, 'Filler ' || n from generate_series(1, 105) as n`,
        [room, sam.userId],
      );
      const entry = (await listConversations(mark)).conversations.find((conversation) => conversation.id === room)!;
      assert.equal(entry.unread, 100);
      assert.equal(entry.mentions, 3);
    });

    it("refuses bad cursors and read marks from elsewhere with 400 and 404", async () => {
      const forged = Buffer.from(JSON.stringify({ u: 0, t: "1", id: "00000000-0000-4000-8000-000000000001" })).toString("base64url");
      await assert.rejects(listThreads(mark, { cursor: forged }), (error: unknown) => error instanceof CrmError && error.status === 400);
      const one = (await createRoom(mark, { name: "one", memberIds: [sam.userId] })).id;
      const two = (await createRoom(mark, { name: "two", memberIds: [sam.userId] })).id;
      const elsewhere = (await postMessage(sam, { conversationId: two, body: "Elsewhere", clientKey: "upto-elsewhere" })).message.id;
      await assert.rejects(markConversationRead(mark, one, elsewhere), (error: unknown) => error instanceof CrmError && error.status === 404);
      const root = (await postMessage(sam, { conversationId: one, body: "Root", clientKey: "upto-root" })).message.id;
      await postMessage(mark, { conversationId: one, parentId: root, body: "Reply", clientKey: "upto-reply" });
      await assert.rejects(markThreadRead(sam, root, elsewhere), (error: unknown) => error instanceof CrmError && error.status === 404);
    });

    it("says clearly when a client key belongs to a message you can no longer see", async () => {
      const room = (await createRoom(mark, { name: "gone", memberIds: [priya.userId] })).id;
      await postMessage(priya, { conversationId: room, body: "Before", clientKey: "hidden-key" });
      await removeRoomMember(mark, room, priya.userId);
      const dm = await openDm(priya, mark.userId);
      await assert.rejects(
        postMessage(priya, { conversationId: dm.id, body: "After", clientKey: "hidden-key" }),
        (error: unknown) => error instanceof CrmError && error.status === 409 && /new key/.test(error.message),
      );
    });

    it("refuses invisible room names and doesn't search author names", async () => {
      await refused(createRoom(mark, { name: "​ ⁠﻿" }), /Give the room a name\./);
      await assert.rejects(sql("select private.chat_room_name($1)", ["​‌ "]), /Give the room a name\./);
      const room = (await createRoom(mark, { name: "search", memberIds: [sam.userId] })).id;
      await postMessage(sam, { conversationId: room, body: "Hello there", clientKey: "search-author" });
      assert.deepEqual((await searchMessages(mark, room, "Okafor")).messages, []);
      assert.equal((await searchMessages(mark, room, "hello")).messages.length, 1);
    });

    it("stamps messages in commit order within a conversation", async () => {
      const room = (await createRoom(mark, { name: "order", memberIds: [sam.userId] })).id;
      const client = await getAdminPool().connect();
      try {
        await client.query("begin");
        const first = (await client.query("insert into crm.chat_messages (conversation_id, author_user_id, body) values ($1, $2, 'Slow') returning id", [room, mark.userId])).rows[0].id;
        let settled = false;
        const second = postMessage(sam, { conversationId: room, body: "Fast", clientKey: "order-fast" }).then((posted) => {
          settled = true;
          return posted;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(settled, false);
        await client.query("commit");
        const posted = await second;
        const order = await sql("select (select created_at from crm.chat_messages where id = $1) < (select created_at from crm.chat_messages where id = $2) as ordered", [first, posted.message.id]);
        assert.equal(order.rows[0].ordered, true);
      } finally {
        client.release();
      }
    });
  });
});
