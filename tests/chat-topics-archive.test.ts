import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runTool } from "@/lib/assistant/tools";
import { lastOwnMessage, startsGroup } from "@/lib/chat/timeline";
import { chatMessage, postChat } from "@/lib/chat/tools";
import type { ChatLiveEvent, ChatMessage } from "@/lib/chat/types";
import {
  addRoomMembers,
  chatWorkSettled,
  createRoom,
  deleteMessage,
  editMessage,
  findMyRooms,
  getConversation,
  getRoom,
  leaveRoom,
  listConversations,
  listMessages,
  listThread,
  listThreads,
  openDm,
  postMessage,
  removeRoomMember,
  searchMessages,
  setRoomArchived,
  updateRoom,
} from "@/lib/crm/chat";
import { createHook, postViaHook } from "@/lib/crm/chat-hooks";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createUser, queryAsUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

const ARCHIVED = /^This room is archived\.$/;

async function sql(text: string, values: unknown[] = []) {
  return getAdminPool().query(text, values);
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

async function refusedArchived(work: Promise<unknown>) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && error.status === 409 && ARCHIVED.test(error.message));
}

async function mcpPost(actor: UserActor, args: Record<string, unknown>) {
  const server = createCrmMcpServer(actor, { personal: { tokenId: "00000000-0000-4000-8000-0000000000ab", canSend: false } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "chat-archive-test", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    return (await client.callTool({ name: "chat_post", arguments: args })) as { content: { text: string }[]; isError?: boolean };
  } finally {
    await client.close();
    await server.close();
  }
}

function event(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m",
    conversationId: "c",
    parentId: null,
    kind: "message",
    author: { id: "me", name: "Mark Ridgeon" },
    via: null,
    clientKey: null,
    body: "Hello",
    format: "markdown",
    mentions: [],
    replyCount: 0,
    lastReplyAt: null,
    replyAuthors: [],
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-11-19T10:00:00.000Z",
    hook: null,
    ...overrides,
  };
}

describe("chat topics, system lines and archive", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let olly: UserActor;
  let broadcasts: LiveMessage[];

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@archive.test", "Mark Ridgeon");
    const samUser = await createUser("sam@archive.test", "Sam Okafor");
    const priyaUser = await createUser("priya@archive.test", "Priya Nair");
    olly = await createUser("olly@ridgeon.test", "Olly Owner");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')", [
      mark.workspaceId,
      samUser.userId,
      priyaUser.userId,
      olly.userId,
    ]);
    sam = { ...samUser, workspaceId: mark.workspaceId, role: "member" };
    priya = { ...priyaUser, workspaceId: mark.workspaceId, role: "member" };
  });

  after(async () => {
    setLiveTesting(null);
    await getPool().end();
  });

  beforeEach(() => {
    broadcasts = [];
    setLiveTesting({ batch: async (messages) => void broadcasts.push(...messages) });
  });

  afterEach(async () => {
    await chatWorkSettled();
  });

  useServerlessPool();

  function chatEvents(userId: string) {
    return broadcasts.filter((message) => message.topic === personTopic(userId) && message.event === "chat").map((message) => message.payload as ChatLiveEvent);
  }

  async function lastLine(viewer: UserActor, conversationId: string) {
    const messages = (await listMessages(viewer, conversationId)).messages;
    return messages[messages.length - 1];
  }

  it("runs its migration twice", async () => {
    await reapplyMigrationsFrom("20270224130000_chat_topics_archive.sql");
    await reapplyMigrationsFrom("20270224130000_chat_topics_archive.sql");
    const kinds = await sql("select count(*)::int as n from pg_proc where proname in ('chat_room_for_member', 'chat_update_room') and pronamespace = 'private'::regnamespace");
    assert.equal(kinds.rows[0].n, 2);
  });

  describe("topics", () => {
    it("lets any member set the topic, shows it, and posts a system line", async () => {
      const room = await createRoom(sam, { name: "sales", memberIds: [mark.userId, priya.userId] });
      const updated = await updateRoom(priya, room.id, { topic: "  Q4 pipeline\n and   pricing  " });
      assert.equal(updated.topic, "Q4 pipeline and pricing");
      assert.equal((await getConversation(mark, room.id)).topic, "Q4 pipeline and pricing");
      assert.equal((await listConversations(mark)).conversations.find((conversation) => conversation.id === room.id)?.topic, "Q4 pipeline and pricing");
      const line = await lastLine(mark, room.id);
      assert.equal(line.kind, "event");
      assert.equal(line.body, "set the topic: Q4 pipeline and pricing");
      assert.equal(line.author.id, priya.userId);
      assert.deepEqual(chatMessage(line), { ...chatMessage(line), event: true });
      await chatWorkSettled();
      assert.ok(chatEvents(mark.userId).some((item) => item.type === "message" && item.message.id === line.id && item.message.kind === "event"));
      assert.ok(chatEvents(sam.userId).some((item) => item.type === "conversation" && item.conversationId === room.id));

      await updateRoom(mark, room.id, { topic: "Q4 pipeline and pricing" });
      assert.equal((await lastLine(mark, room.id)).id, line.id);

      const cleared = await updateRoom(mark, room.id, { topic: "   " });
      assert.equal(cleared.topic, null);
      assert.equal((await lastLine(sam, room.id)).body, "cleared the topic");

      await refused(updateRoom(mark, room.id, { topic: "x".repeat(251) }), /Keep the topic to 250 characters\./);
      await assert.rejects(
        getAdminPool().query("select private.chat_update_room($1, $2, null, false, null, true, $3)", [mark.userId, room.id, "y".repeat(251)]),
        /Keep the topic to 250 characters\./,
      );
      await refused(updateRoom(olly, room.id, { topic: "Outsider" }), /Room not found\./);
      const dm = await openDm(mark, sam.userId);
      await refused(updateRoom(mark, dm.id, { topic: "DM topic" }), /Room not found\./);
    });
  });

  describe("system lines", () => {
    let roomId: string;
    let lineId: string;

    before(async () => {
      setLiveTesting({ batch: async () => undefined });
      roomId = (await createRoom(sam, { name: "events", memberIds: [mark.userId, priya.userId] })).id;
      await updateRoom(priya, roomId, { topic: "Launch week" });
      lineId = (await lastLine(priya, roomId)).id;
    });

    it("can't be inserted, edited, deleted or replied to by people", async () => {
      await assert.rejects(
        queryAsUser(priya.userId, "insert into crm.chat_messages (conversation_id, author_user_id, client_key, body, kind) values ($1, $2, 'sneaky', 'archived this room', 'event')", [roomId, priya.userId]),
        /permission denied/,
      );
      await assert.rejects(queryAsUser(priya.userId, "update crm.chat_messages set body = 'changed' where id = $1", [lineId]), /That message can't be changed\./);
      await assert.rejects(queryAsUser(priya.userId, "update crm.chat_messages set deleted_at = now() where id = $1", [lineId]), /That message can't be changed\./);
      await assert.rejects(queryAsUser(priya.userId, "update crm.chat_messages set kind = 'message' where id = $1", [lineId]), /permission denied/);
      await refused(editMessage(priya, lineId, "changed"), /That message can't be changed\./);
      await refused(deleteMessage(priya, lineId), /That message can't be changed\./);
      await refused(postMessage(mark, { conversationId: roomId, parentId: lineId, body: "Replying to a line" }), /Reply to a message in this conversation\./);
      const root = await postMessage(sam, { conversationId: roomId, body: "A real message" });
      await assert.rejects(getAdminPool().query("update crm.chat_messages set parent_id = $2 where id = $1", [lineId, root.message.id]), /chat_messages_kind_check/);
      await deleteMessage(sam, root.message.id);
      const stored = await sql("select body, deleted_at, reply_count from crm.chat_messages where id = $1", [lineId]);
      assert.deepEqual(stored.rows[0], { body: "set the topic: Launch week", deleted_at: null, reply_count: 0 });
    });

    it("never counts as unread, mentioned or the unread divider", async () => {
      await updateRoom(mark, roomId, { topic: "Launch week, day two" });
      const before = (await listConversations(sam)).conversations.find((conversation) => conversation.id === roomId)!;
      assert.equal(before.unread, 0);
      assert.equal(before.mentions, 0);
      assert.equal((await listMessages(sam, roomId)).firstUnreadId, null);
      const real = await postMessage(priya, { conversationId: roomId, body: "Kick off at ten" });
      const after = (await listConversations(sam)).conversations.find((conversation) => conversation.id === roomId)!;
      assert.equal(after.unread, 1);
      assert.equal((await listMessages(sam, roomId)).firstUnreadId, real.message.id);
      assert.equal((await listThreads(sam)).threads.filter((thread) => thread.conversation.id === roomId).length, 0);
    });

    it("is skipped by Up arrow editing and breaks message groups", () => {
      const own = event({ id: "own", author: { id: "me", name: "Mark Ridgeon" } });
      const line = event({ id: "line", kind: "event", body: "set the topic: Launch", createdAt: "2026-11-19T10:01:00.000Z" });
      assert.equal(lastOwnMessage([own, line], "me")?.id, "own");
      assert.equal(startsGroup(own, line, true), true);
      assert.equal(startsGroup(line, event({ id: "next", createdAt: "2026-11-19T10:02:00.000Z" }), true), true);
    });
  });

  describe("who can archive", () => {
    it("lets the creator and workspace owners who are members archive and unarchive", async () => {
      const room = await createRoom(sam, { name: "launch", workspaceId: mark.workspaceId, memberIds: [mark.userId, priya.userId, olly.userId] });
      assert.equal((await getRoom(sam, room.id)).canArchive, true);
      assert.equal((await getRoom(mark, room.id)).canArchive, true);
      assert.equal((await getRoom(priya, room.id)).canArchive, false);
      assert.equal((await getRoom(olly, room.id)).canArchive, false);

      await refused(setRoomArchived(priya, room.id, true), /Only the room's creator or a workspace owner can archive it\./);
      await refused(setRoomArchived(olly, room.id, true), /Only the room's creator or a workspace owner can archive it\./);
      const archived = await setRoomArchived(mark, room.id, true);
      assert.ok(archived.archivedAt);
      const line = await lastLine(priya, room.id);
      assert.equal(line.kind, "event");
      assert.equal(line.body, "archived this room");
      assert.equal(line.author.id, mark.userId);
      await chatWorkSettled();
      assert.ok(chatEvents(priya.userId).some((item) => item.type === "message" && item.message.id === line.id));
      assert.ok(chatEvents(priya.userId).some((item) => item.type === "conversation" && item.conversationId === room.id));

      await setRoomArchived(mark, room.id, true);
      assert.equal((await lastLine(priya, room.id)).id, line.id);

      await refused(setRoomArchived(priya, room.id, false), /Only the room's creator or a workspace owner can unarchive it\./);
      const back = await setRoomArchived(sam, room.id, false);
      assert.equal(back.archivedAt, null);
      assert.equal((await lastLine(priya, room.id)).body, "unarchived this room");
    });

    it("refuses an owner who isn't in the room", async () => {
      const room = await createRoom(sam, { name: "private-plans", memberIds: [priya.userId] });
      await refused(setRoomArchived(mark, room.id, true), /Room not found\./);
      await refused(getRoom(mark, room.id), /not found/i);
      const dm = await openDm(mark, sam.userId);
      await refused(setRoomArchived(mark, dm.id, true), /Room not found\./);
      assert.equal((await sql("select archived_at from crm.chat_conversations where id = $1", [room.id])).rows[0].archived_at, null);
    });

    it("lets an owner of any workspace archive an unlinked room they're in", async () => {
      const room = await createRoom(sam, { name: "unlinked", memberIds: [olly.userId] });
      assert.ok((await setRoomArchived(olly, room.id, true)).archivedAt);
    });
  });

  describe("an archived room", () => {
    let roomId: string;
    let rootId: string;
    let priyaMessage: string;
    let hook: { id: string; secret: string };

    before(async () => {
      setLiveTesting({ batch: async () => undefined });
      roomId = (await createRoom(sam, { name: "q3-launch", memberIds: [mark.userId, priya.userId] })).id;
      rootId = (await postMessage(sam, { conversationId: roomId, body: "Launch done. Thanks all" })).message.id;
      await postMessage(priya, { conversationId: roomId, parentId: rootId, body: "Great work" });
      priyaMessage = (await postMessage(priya, { conversationId: roomId, body: "Notes are in the doc" })).message.id;
      const created = await createHook(sam, roomId, "Alerts");
      hook = { id: created.hook.id, secret: created.secret };
      await chatWorkSettled();
      await setRoomArchived(sam, roomId, true);
    });

    it("still reads, but leaves the sidebar, Threads and room lookups", async () => {
      assert.ok((await getConversation(priya, roomId)).archivedAt);
      assert.ok((await getRoom(priya, roomId)).conversation.archivedAt);
      const page = await listMessages(priya, roomId);
      assert.deepEqual(
        page.messages.map((message) => message.body),
        ["Launch done. Thanks all", "Notes are in the doc", "archived this room"],
      );
      assert.equal((await listThread(priya, rootId)).replies.length, 1);
      assert.equal((await searchMessages(priya, roomId, "doc")).messages.length, 1);
      assert.equal((await listConversations(priya)).conversations.some((conversation) => conversation.id === roomId), false);
      assert.equal((await listThreads(sam)).threads.some((thread) => thread.root.id === rootId), false);
      assert.deepEqual(await findMyRooms(priya, { id: roomId }), []);
      assert.deepEqual(await findMyRooms(priya, { name: "q3-launch" }, { archived: true }), [{ id: roomId, name: "q3-launch", workspaceId: null, archived: true }]);
    });

    it("refuses posts from every writer with the same message", async () => {
      await refusedArchived(postMessage(priya, { conversationId: roomId, body: "One more thing" }));
      await refusedArchived(postMessage(priya, { conversationId: roomId, parentId: rootId, body: "Late reply" }));
      let charged = false;
      await refusedArchived(
        postChat(
          priya,
          { conversationId: roomId, text: "Via MCP" },
          {
            charge: async () => {
              charged = true;
            },
          },
        ),
      );
      assert.equal(charged, false);
      await refusedArchived(postChat(priya, { threadId: rootId, text: "Via MCP in a thread" }));
      const mcp = await mcpPost(priya, { conversation_id: roomId, text: "Through the MCP server" });
      assert.equal(mcp.isError, true);
      assert.equal(mcp.content[0].text, "conflict: This room is archived.");
      const assistant = (await runTool(priya, "team_chat", { action: "post", conversationId: roomId, text: "Via the assistant" })) as { error?: string };
      assert.equal(assistant.error, "This room is archived.");
      await refusedArchived(postViaHook({ hookId: hook.id, authorization: `Bearer ${hook.secret}`, body: JSON.stringify({ text: "Alert" }) }));
      await refused(postViaHook({ hookId: hook.id, authorization: "Bearer wrong", body: JSON.stringify({ text: "Alert" }) }), /Authorization: Bearer/);
      await assert.rejects(queryAsUser(priya.userId, "insert into crm.chat_messages (conversation_id, author_user_id, body) values ($1, $2, 'Raw')", [roomId, priya.userId]), /row-level security/);
      await refusedArchived(editMessage(priya, priyaMessage, "Edited"));
      await refusedArchived(deleteMessage(priya, priyaMessage));
      const bodies = (await sql("select body from crm.chat_messages where conversation_id = $1 order by created_at", [roomId])).rows.map((row) => row.body);
      assert.deepEqual(bodies, ["Launch done. Thanks all", "Great work", "Notes are in the doc", "archived this room"]);
    });

    it("refuses rename, topic, add and remove, but lets people leave and the creator unarchive", async () => {
      await refusedArchived(updateRoom(sam, roomId, { name: "renamed" }));
      await refusedArchived(updateRoom(sam, roomId, { topic: "New topic" }));
      await refusedArchived(addRoomMembers(sam, roomId, [mark.userId]));
      await refusedArchived(removeRoomMember(sam, roomId, priya.userId));
      assert.equal((await getRoom(sam, roomId)).members.length, 3);
      await leaveRoom(priya, roomId);
      assert.deepEqual((await getRoom(sam, roomId)).members.map((member) => member.id).sort(), [mark.userId, sam.userId].sort());
      await setRoomArchived(sam, roomId, false);
      assert.ok((await listConversations(mark)).conversations.some((conversation) => conversation.id === roomId));
      const posted = await postMessage(mark, { conversationId: roomId, body: "Back again" });
      assert.equal(posted.duplicate, false);
      assert.equal((await updateRoom(sam, roomId, { name: "q4-launch" })).name, "q4-launch");
    });
  });
});
