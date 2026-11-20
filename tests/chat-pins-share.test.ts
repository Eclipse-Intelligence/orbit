import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { runTool } from "@/lib/assistant/tools";
import { applyQuoteEvent, cachedQuote, loadQuotes, QUOTE_UNAVAILABLE, quoteView, requestQuote } from "@/lib/chat/quotes";
import { CHAT_PINS_MAX, CHAT_QUOTES_MAX, type ChatQuote } from "@/lib/chat/types";
import { chatWorkSettled, createRoom, deleteMessage, editMessage, getPins, listMessages, listThread, openDiscussion, openDm, openGroup, postMessage, setMessagePinned, setRoomArchived } from "@/lib/crm/chat";
import { searchChat } from "@/lib/crm/chat-search";
import { listSaved, setMessageSaved } from "@/lib/crm/chat-saved";
import { cleanQuoteIds, getMessages } from "@/lib/crm/chat-quotes";
import { createCompany } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createUser, queryAsUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

const MIGRATION = "20270301100000_chat_pins_share.sql";
const SECRET = "Acme floor price is 41k, keep it in sales";
const MISSING = "00000000-0000-4000-8000-000000000000";

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

async function pinned(actor: UserActor, conversationId: string) {
  return (await getPins(actor, conversationId)).pins.map((pin) => pin.message.id);
}

async function pinRows(conversationId: string) {
  return (await sql("select count(*)::int as n from crm.chat_pins where conversation_id = $1", [conversationId])).rows[0].n as number;
}

async function lines(conversationId: string) {
  const result = await sql("select body from crm.chat_messages where conversation_id = $1 and kind = 'event' order by created_at, id", [conversationId]);
  return result.rows.map((row) => row.body as string);
}

async function inTransactionAs(userId: string, statements: [string, unknown[]][]) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await client.query("set local role authenticated");
    let rows: unknown[] = [];
    for (const [text, values] of statements) rows = (await client.query(text, values)).rows;
    return rows;
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

async function mcp(actor: UserActor, name: string, args: Record<string, unknown>) {
  const server = createCrmMcpServer(actor, { personal: { tokenId: "00000000-0000-4000-8000-0000000000aa", canSend: false } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "pins-test", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const answer = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!answer.isError, answer.content[0].text);
    return answer.content[0].text;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("pins and shared messages", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let ada: UserActor;
  let olly: UserActor;
  let sales: string;
  let renewals: string;
  let broadcasts: LiveMessage[] = [];

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@pins.test", "Mark Ridgeon");
    sam = await join(await createUser("sam@pins.test", "Sam Okafor"), mark.workspaceId);
    priya = await join(await createUser("priya@pins.test", "Priya Nair"), mark.workspaceId);
    ada = await join(await createUser("ada@pins.test", "Ada Admin"), mark.workspaceId, "admin");
    olly = await createUser("olly@elsewhere.test", "Olly Outside");
    sales = (await createRoom(mark, { name: "sales", memberIds: [sam.userId] })).id;
    renewals = (await createRoom(mark, { name: "renewals", memberIds: [priya.userId] })).id;
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

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  describe("on the serverless pool", () => {
    useServerlessPool();

    it("lets any member pin and unpin, posts a system line each time and does nothing when repeated", async () => {
      const { message } = await postMessage(mark, { conversationId: sales, body: "Pricing sheet for 2027" });
      assert.deepEqual(await setMessagePinned(sam, message.id, true), { messageId: message.id, conversationId: sales, pinned: true, changed: true });
      assert.deepEqual(await setMessagePinned(sam, message.id, true), { messageId: message.id, conversationId: sales, pinned: true, changed: false });
      assert.deepEqual(await setMessagePinned(mark, message.id, true), { messageId: message.id, conversationId: sales, pinned: true, changed: false });
      assert.deepEqual(await pinned(mark, sales), [message.id]);
      const read = (await getPins(sam, sales)).pins[0];
      assert.equal(read.message.body, "Pricing sheet for 2027");
      assert.deepEqual(read.pinnedBy, { id: sam.userId, name: "Sam Okafor" });
      assert.deepEqual(await lines(sales), ["pinned a message"]);
      assert.deepEqual(await setMessagePinned(mark, message.id, false), { messageId: message.id, conversationId: sales, pinned: false, changed: true });
      assert.deepEqual(await setMessagePinned(mark, message.id, false), { messageId: message.id, conversationId: sales, pinned: false, changed: false });
      assert.deepEqual(await pinned(sam, sales), []);
      assert.deepEqual(await lines(sales), ["pinned a message", "unpinned a message"]);
      const events = await sql("select author_user_id, kind from crm.chat_messages where conversation_id = $1 and kind = 'event' order by created_at", [sales]);
      assert.deepEqual(events.rows.map((row) => row.author_user_id), [sam.userId, mark.userId]);
      await sql("delete from crm.chat_messages where conversation_id = $1 and kind = 'event'", [sales]);
    });

    it("lists the newest pinned first, replies included", async () => {
      const first = (await postMessage(mark, { conversationId: sales, body: "First" })).message;
      const second = (await postMessage(sam, { conversationId: sales, body: "Second" })).message;
      const reply = (await postMessage(sam, { conversationId: sales, parentId: first.id, body: "A reply" })).message;
      for (const message of [second, first, reply]) await setMessagePinned(mark, message.id, true);
      assert.deepEqual(await pinned(sam, sales), [reply.id, first.id, second.id]);
      const [top] = (await getPins(sam, sales)).pins;
      assert.equal(top.message.parentId, first.id);
      await sql("delete from crm.chat_pins");
      await sql("delete from crm.chat_messages where conversation_id = $1 and kind = 'event'", [sales]);
    });

    it("keeps pins to the conversation's members: owners, admins and outsiders see none and can't pin", async () => {
      const { message } = await postMessage(sam, { conversationId: sales, body: "Between sales" });
      await setMessagePinned(sam, message.id, true);
      for (const outsider of [priya, ada, olly]) {
        await refused(setMessagePinned(outsider, message.id, true), /^Message not found\.$/);
        await refused(setMessagePinned(outsider, message.id, false), /^Message not found\.$/);
        await refused(getPins(outsider, sales), /not found/i);
        assert.deepEqual(await queryAsUser(outsider.userId, "select message_id from crm.chat_pins"), []);
        await assert.rejects(queryAsUser(outsider.userId, "insert into crm.chat_pins (message_id, conversation_id) values ($1, $2)", [message.id, sales]), /permission denied/);
        await assert.rejects(queryAsUser(outsider.userId, "delete from crm.chat_pins"), /permission denied/);
      }
      for (const member of [mark, sam]) assert.equal((await queryAsUser(member.userId, "select message_id from crm.chat_pins")).length, 1);
      await refused(setMessagePinned(priya, MISSING, true), /^Message not found\.$/);
      await refused(setMessagePinned(priya, "not-an-id", true), /^Message not found\.$/);
      assert.equal(await pinRows(sales), 1);
      await sql("delete from crm.chat_pins");
      await sql("delete from crm.chat_messages where conversation_id = $1 and kind = 'event'", [sales]);
    });

    it("pins in direct messages and group messages, and refuses system lines, deleted messages and discussions", async () => {
      const dm = await openDm(sam, priya.userId);
      const spoken = (await postMessage(sam, { conversationId: dm.id, body: "Our offer" })).message;
      await setMessagePinned(priya, spoken.id, true);
      assert.deepEqual(await pinned(sam, dm.id), [spoken.id]);
      assert.deepEqual(await lines(dm.id), ["pinned a message"]);
      await refused(setMessagePinned(mark, spoken.id, true), /^Message not found\.$/);

      const group = await openGroup(mark, [sam.userId, priya.userId]);
      const hello = (await postMessage(mark, { conversationId: group.id, body: "Group plan" })).message;
      await setMessagePinned(priya, hello.id, true);
      assert.deepEqual(await pinned(sam, group.id), [hello.id]);
      await refused(getPins(ada, group.id), /not found/i);

      const line = (await sql("select id from crm.chat_messages where conversation_id = $1 and kind = 'event'", [dm.id])).rows[0].id as string;
      await refused(setMessagePinned(sam, line, true), /That can't be pinned\./);
      const gone = (await postMessage(sam, { conversationId: dm.id, body: "Oops" })).message;
      await deleteMessage(sam, gone.id);
      await refused(setMessagePinned(sam, gone.id, true), /That message was deleted\./);

      const companyId = (await createCompany(mark, { name: "Halden Group", domain: "halden.test" })).body.company.id;
      const task = (await createTask(mark, { title: "Send pricing", companyId, ownerId: sam.userId })).body.task;
      const { conversationId } = await openDiscussion(sam, { kind: "task", id: task.id });
      const comment = (await postMessage(sam, { conversationId, body: "Draft is ready" })).message;
      await refused(setMessagePinned(sam, comment.id, true), /^Message not found\.$/);
      await refused(getPins(sam, conversationId), /not found/i);
      assert.equal((await sql("select count(*)::int as n from crm.chat_pins where conversation_id = $1", [conversationId])).rows[0].n, 0);
      await sql("delete from crm.chat_pins");
    });

    it("removes a pin when its message is deleted, however it is deleted", async () => {
      const first = (await postMessage(mark, { conversationId: sales, body: "Pinned then deleted" })).message;
      const second = (await postMessage(sam, { conversationId: sales, body: "Deleted by SQL" })).message;
      for (const message of [first, second]) await setMessagePinned(sam, message.id, true);
      await deleteMessage(mark, first.id);
      assert.deepEqual(await pinned(sam, sales), [second.id]);
      const seenInside = await inTransactionAs(sam.userId, [
        ["update crm.chat_messages set deleted_at = now() where id = $1", [second.id]],
        ["select message_id from crm.chat_pins where conversation_id = $1", [sales]],
      ]);
      assert.deepEqual(seenInside, []);
      assert.equal(await pinRows(sales), 1);
      await sql("update crm.chat_messages set deleted_at = now() where id = $1", [second.id]);
      assert.equal(await pinRows(sales), 0);
      await sql("delete from crm.chat_messages where conversation_id = $1 and kind = 'event'", [sales]);
    });

    it("deletes pins with their conversation", async () => {
      const temporary = (await createRoom(mark, { name: "temporary" })).id;
      const { message } = await postMessage(mark, { conversationId: temporary, body: "Soon gone" });
      await setMessagePinned(mark, message.id, true);
      await sql("delete from crm.chat_conversations where id = $1", [temporary]);
      assert.equal(await pinRows(temporary), 0);
    });

    it("makes pins read only in an archived room and keeps them readable", async () => {
      const room = (await createRoom(mark, { name: "q3-launch", memberIds: [sam.userId] })).id;
      const keep = (await postMessage(mark, { conversationId: room, body: "Launch plan" })).message;
      const later = (await postMessage(sam, { conversationId: room, body: "Retro notes" })).message;
      await setMessagePinned(sam, keep.id, true);
      await setRoomArchived(mark, room, true);
      await refused(setMessagePinned(sam, later.id, true), /^This room is archived\.$/);
      await refused(setMessagePinned(sam, keep.id, false), /^This room is archived\.$/);
      assert.deepEqual(await pinned(sam, room), [keep.id]);
      await setRoomArchived(mark, room, false);
      await setMessagePinned(sam, keep.id, false);
      assert.deepEqual(await pinned(sam, room), []);
    });

    it("sends pin changes only to the members' person channels, with ids and no text", async () => {
      const { message } = await postMessage(mark, { conversationId: sales, body: SECRET });
      broadcasts = [];
      await setMessagePinned(sam, message.id, true);
      await chatWorkSettled();
      const topics = new Set(broadcasts.map((item) => item.topic));
      assert.deepEqual(topics, new Set([personTopic(mark.userId), personTopic(sam.userId)]));
      for (const item of broadcasts) assert.equal(item.event, "chat");
      const forMark = broadcasts.filter((item) => item.topic === personTopic(mark.userId)).map((item) => item.payload as { type: string; conversationId: string; message?: { kind: string; body: string } });
      assert.deepEqual(forMark.map((item) => item.type), ["message", "pins"]);
      assert.equal(forMark[0].message?.kind, "event");
      assert.equal(forMark[0].message?.body, "pinned a message");
      assert.deepEqual(forMark[1], { type: "pins", conversationId: sales });
      assert.ok(!JSON.stringify(broadcasts).includes(SECRET));
      broadcasts = [];
      await setMessagePinned(sam, message.id, true);
      await chatWorkSettled();
      assert.deepEqual(broadcasts, []);
      await sql("delete from crm.chat_pins");
      await sql("delete from crm.chat_messages where conversation_id = $1 and kind = 'event'", [sales]);
    });

    it("shares a message by id only: a member of the target who isn't in the source gets the id and nothing else", async () => {
      const original = (await postMessage(sam, { conversationId: sales, body: SECRET })).message;
      broadcasts = [];
      const shared = (await postMessage(mark, { conversationId: renewals, body: "Worth a look", quotedMessageId: original.id })).message;
      await chatWorkSettled();
      assert.equal(shared.quotedId, original.id);
      assert.equal(shared.body, "Worth a look");
      assert.deepEqual(new Set(broadcasts.map((item) => item.topic)), new Set([personTopic(mark.userId), personTopic(priya.userId)]));
      for (const item of broadcasts) {
        const payload = item.payload as { type: string; message: { quotedId: string; body: string } };
        assert.equal(payload.type, "message");
        assert.equal(payload.message.quotedId, original.id);
        assert.equal(payload.message.body, "Worth a look");
      }
      assert.ok(!JSON.stringify(broadcasts).includes(SECRET));

      const page = await listMessages(priya, renewals);
      assert.equal(page.messages.find((item) => item.id === shared.id)?.quotedId, original.id);
      assert.ok(!JSON.stringify(page).includes(SECRET));
      const thread = await listThread(priya, shared.id);
      assert.equal(thread.root.quotedId, original.id);
      assert.ok(!JSON.stringify(thread).includes(SECRET));

      const asked = await mcp(priya, "chat_read", { conversation_id: renewals });
      assert.ok(asked.includes(`"quotedMessageId": "${original.id}"`));
      assert.ok(!asked.includes(SECRET));
      const assistant = JSON.stringify(await runTool(priya, "team_chat", { action: "read", conversationId: renewals }));
      assert.ok(assistant.includes(original.id));
      assert.ok(!assistant.includes(SECRET));

      assert.deepEqual((await getMessages(priya, [original.id])).quotes, []);
      assert.deepEqual((await getMessages(ada, [original.id])).quotes, []);
      assert.deepEqual((await getMessages(olly, [original.id])).quotes, []);
      const seen = (await getMessages(mark, [original.id, shared.id, MISSING])).quotes;
      assert.deepEqual(
        seen.map((quote) => quote.id).sort(),
        [original.id, shared.id].sort(),
      );
      const quote = seen.find((item) => item.id === original.id)!;
      assert.equal(quote.excerpt, SECRET);
      assert.equal(quote.place, "#sales");
      assert.equal(quote.href, `/chat/${sales}?message=${original.id}`);
      assert.deepEqual(quote.author, { id: sam.userId, name: "Sam Okafor" });

      const found = await searchChat(priya, { text: "floor price" });
      assert.deepEqual(found.hits, []);
      const own = await searchChat(mark, { text: "floor price" });
      assert.ok(own.hits.some((hit) => hit.id === original.id));
      assert.ok(own.hits.every((hit) => hit.conversationId === sales));
      assert.ok(!own.hits.some((hit) => hit.id === shared.id));

      await setMessageSaved(priya, shared.id, true);
      const saved = await listSaved(priya);
      assert.equal(saved.items[0].message.quotedId, original.id);
      assert.ok(!JSON.stringify(saved).includes(SECRET));
      await sql("delete from crm.chat_saved");
    });

    it("shows nothing of the original to the target's members through alerts either", async () => {
      const dm = await openDm(mark, priya.userId);
      await sql("update crm.chat_members set notify = 'all' where conversation_id = $1", [dm.id]);
      const original = (await postMessage(sam, { conversationId: sales, body: SECRET })).message;
      await postMessage(mark, { conversationId: dm.id, body: "", quotedMessageId: original.id });
      await chatWorkSettled();
      const alerts = await sql("select to_jsonb(n)::text as text from crm.notifications n");
      const pushes = await sql("select to_jsonb(p)::text as text from crm.push_log p");
      assert.ok(alerts.rowCount! + pushes.rowCount! > 0);
      for (const row of [...alerts.rows, ...pushes.rows]) assert.ok(!(row.text as string).includes("floor price"));
    });

    it("refuses to share a message you can't see without saying whether it exists", async () => {
      const original = (await postMessage(sam, { conversationId: sales, body: SECRET })).message;
      const privateDm = await openDm(sam, mark.userId);
      const whisper = (await postMessage(sam, { conversationId: privateDm.id, body: "Just us" })).message;
      const attempts: [UserActor, string][] = [
        [priya, original.id],
        [ada, original.id],
        [olly, original.id],
        [priya, whisper.id],
        [ada, MISSING],
        [priya, MISSING],
      ];
      const targets = new Map<string, string>([
        [priya.userId, renewals],
        [ada.userId, (await createRoom(ada, { name: "admin-room" })).id],
        [olly.userId, (await createRoom(olly, { name: "elsewhere" })).id],
      ]);
      const before = (await sql("select count(*)::int as n from crm.chat_messages")).rows[0].n;
      const failures: unknown[] = [];
      for (const [actor, id] of attempts) {
        const target = targets.get(actor.userId)!;
        const error = await postMessage(actor, { conversationId: target, body: "Worth a look", quotedMessageId: id, clientKey: `try-${failures.length}` }).catch((caught) => caught);
        assert.ok(error instanceof CrmError);
        failures.push({ code: error.code, status: error.status, message: error.message });
      }
      assert.deepEqual(new Set(failures.map((item) => JSON.stringify(item))).size, 1);
      assert.deepEqual(failures[0], { code: "not_found", status: 404, message: "Message not found." });
      assert.equal((await sql("select count(*)::int as n from crm.chat_messages")).rows[0].n, before);
      await refused(postMessage(priya, { conversationId: renewals, body: "x", quotedMessageId: "not-an-id" }), /^Message not found\.$/);
      await assert.rejects(
        queryAsUser(priya.userId, "insert into crm.chat_messages (conversation_id, author_user_id, client_key, body, quoted_message_id) values ($1, $2, 'sneaky', 'hi', $3)", [renewals, priya.userId, original.id]),
        /row-level security/,
      );
      await assert.rejects(
        queryAsUser(ada.userId, "insert into crm.chat_messages (conversation_id, author_user_id, client_key, body, quoted_message_id) values ($1, $2, 'sneaky', 'hi', $3)", [sales, ada.userId, original.id]),
        /row-level security|violates/,
      );
    });

    it("lets a share go with no comment, keeps its quote through an edit and counts it as a message", async () => {
      const original = (await postMessage(sam, { conversationId: sales, body: "Renewal is on 1 December" })).message;
      const bare = (await postMessage(mark, { conversationId: renewals, body: "   ", quotedMessageId: original.id })).message;
      assert.equal(bare.body, "");
      assert.equal(bare.quotedId, original.id);
      const edited = await editMessage(mark, bare.id, "", {});
      assert.equal(edited.quotedId, original.id);
      const worded = await editMessage(mark, bare.id, "Please sign this off", {});
      assert.equal(worded.body, "Please sign this off");
      assert.equal(worded.quotedId, original.id);
      const plain = (await postMessage(mark, { conversationId: renewals, body: "No quote here" })).message;
      await refused(editMessage(mark, plain.id, "", {}), /Delete the message instead\./);
      await refused(postMessage(mark, { conversationId: renewals, body: "  " }), /Write a message first\./);
      assert.equal((await listMessages(priya, renewals)).messages.find((item) => item.id === bare.id)?.quotedId, original.id);
    });

    it("posts a share once however often the same key is sent", async () => {
      const original = (await postMessage(sam, { conversationId: sales, body: "Idempotent" })).message;
      const input = { conversationId: renewals, body: "Look", quotedMessageId: original.id, clientKey: "share-once" };
      const first = await postMessage(mark, input);
      const second = await postMessage(mark, input);
      assert.equal(first.duplicate, false);
      assert.equal(second.duplicate, true);
      assert.equal(second.message.id, first.message.id);
      assert.equal((await sql("select count(*)::int as n from crm.chat_messages where client_key = 'share-once'")).rows[0].n, 1);
      await deleteMessage(sam, original.id);
      const again = await postMessage(mark, input);
      assert.equal(again.duplicate, true);
    });

    it("refuses shares of deleted messages and system lines, in threads, and by workflows and agents", async () => {
      const original = (await postMessage(sam, { conversationId: sales, body: "To delete" })).message;
      const root = (await postMessage(mark, { conversationId: renewals, body: "Root" })).message;
      await refused(postMessage(mark, { conversationId: renewals, parentId: root.id, body: "In a thread", quotedMessageId: original.id }), /Share a message in the conversation, not in a thread\./);
      const line = (await sql("insert into crm.chat_messages (conversation_id, author_user_id, client_key, body, kind) values ($1, $2, 'line', 'renamed the room', 'event') returning id", [sales, mark.userId])).rows[0].id as string;
      await refused(postMessage(mark, { conversationId: renewals, body: "Look", quotedMessageId: line }), /That message can't be shared\./);
      await refused(postMessage(mark, { conversationId: renewals, body: "Look", quotedMessageId: original.id }, { charge: async () => undefined }), /Only people can share a message\./);
      await refused(postMessage(mark, { conversationId: renewals, body: "Look", quotedMessageId: original.id }, { viaWorkflowId: MISSING }), /Only people can share a message\./);
      await deleteMessage(sam, original.id);
      await refused(postMessage(mark, { conversationId: renewals, body: "Look", quotedMessageId: original.id }), /That message was deleted\./);
      await assert.rejects(
        sql("insert into crm.chat_messages (conversation_id, author_user_id, client_key, body, kind, quoted_message_id) values ($1, $2, 'bad', 'x', 'event', $3)", [sales, mark.userId, original.id]),
        /chat_messages_quote_check/,
      );
      await assert.rejects(
        sql("insert into crm.chat_messages (conversation_id, parent_id, author_user_id, client_key, body, quoted_message_id) values ($1, $2, $3, 'bad2', 'x', $4)", [renewals, root.id, mark.userId, original.id]),
        /chat_messages_quote_check/,
      );
    });

    it("shares from a task discussion, and people in the target who can't see the task get the id and no text", async () => {
      const companyId = (await createCompany(mark, { name: "Brightwell", domain: "brightwell.test" })).body.company.id;
      const task = (await createTask(mark, { title: "Chase Brightwell", companyId, ownerId: sam.userId })).body.task;
      const { conversationId } = await openDiscussion(sam, { kind: "task", id: task.id });
      const comment = (await postMessage(sam, { conversationId, body: "Their budget is 90k, not for renewals" })).message;
      const shared = (await postMessage(sam, { conversationId: sales, body: "FYI", quotedMessageId: comment.id })).message;
      assert.equal(shared.quotedId, comment.id);
      const quotes = (await getMessages(mark, [comment.id])).quotes;
      assert.equal(quotes.length, 1);
      assert.equal(quotes[0].place, "Task: Chase Brightwell");
      for (const outsider of [priya, ada, olly]) assert.deepEqual((await getMessages(outsider, [comment.id])).quotes, []);
      await refused(postMessage(priya, { conversationId: renewals, body: "FYI", quotedMessageId: comment.id }), /^Message not found\.$/);
      const sees = await listMessages(mark, sales);
      assert.equal(sees.messages.find((item) => item.id === shared.id)?.quotedId, comment.id);
      await refused(postMessage(sam, { conversationId, body: "Back in the task", quotedMessageId: comment.id }), /Share a message in a room or a direct message\./);
    });

    it("hides the original from everyone once it is deleted", async () => {
      const original = (await postMessage(sam, { conversationId: sales, body: "Short lived" })).message;
      await postMessage(mark, { conversationId: renewals, body: "Saw this", quotedMessageId: original.id });
      assert.equal((await getMessages(mark, [original.id])).quotes.length, 1);
      await deleteMessage(sam, original.id);
      assert.deepEqual((await getMessages(mark, [original.id])).quotes, []);
      assert.deepEqual((await getMessages(sam, [original.id])).quotes, []);
    });

    it("loses a share's quote with it when the share is deleted", async () => {
      const original = (await postMessage(sam, { conversationId: sales, body: "Kept" })).message;
      const shared = (await postMessage(mark, { conversationId: renewals, body: "Look", quotedMessageId: original.id })).message;
      await deleteMessage(mark, shared.id);
      const read = (await listMessages(priya, renewals)).messages.find((item) => item.id === shared.id);
      assert.equal(read?.quotedId ?? null, null);
      assert.equal(read?.body ?? "", "");
    });

    it("limits and checks the ids asked for", async () => {
      assert.deepEqual(cleanQuoteIds([]), []);
      assert.deepEqual(cleanQuoteIds([MISSING, MISSING.toUpperCase()]), [MISSING]);
      assert.throws(() => cleanQuoteIds(["nope"]), /isn't valid/);
      assert.throws(() => cleanQuoteIds([MISSING, 4]), /isn't valid/);
      const many = Array.from({ length: CHAT_QUOTES_MAX + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
      assert.throws(() => cleanQuoteIds(many), /up to 50 messages/);
      assert.equal(cleanQuoteIds(many.slice(0, CHAT_QUOTES_MAX)).length, CHAT_QUOTES_MAX);
      assert.deepEqual(await getMessages(mark, []), { quotes: [] });
    });

    it("runs the migration again without error and keeps the rows", async () => {
      const { message } = await postMessage(mark, { conversationId: sales, body: "Keep me" });
      await setMessagePinned(mark, message.id, true);
      await reapplyMigrationsFrom(MIGRATION);
      assert.deepEqual(await pinned(sam, sales), [message.id]);
      const policies = await sql("select policyname from pg_policies where tablename = 'chat_pins' order by policyname");
      assert.deepEqual(policies.rows.map((row) => row.policyname), ["chat_pins_select"]);
      const flags = await sql("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'crm.chat_pins'::regclass");
      assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
      const insert = await sql("select policyname from pg_policies where tablename = 'chat_messages' and policyname = 'chat_messages_insert_own'");
      assert.equal(insert.rowCount, 1);
      const present = await sql("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'chat_messages_body_present'");
      assert.match(present.rows[0].def, /quoted_message_id/);
      await sql("delete from crm.chat_pins");
    });
  });

  describe("the 50 pin limit", () => {
    it("holds at 50 when many people pin at once", async () => {
      const room = (await createRoom(mark, { name: "crowded", memberIds: [sam.userId, priya.userId] })).id;
      const people = [mark, sam, priya];
      const posted = [];
      for (let index = 0; index < 60; index += 1) posted.push((await postMessage(people[index % 3], { conversationId: room, body: `Message ${index}` })).message);
      const results = await Promise.allSettled(posted.map((message, index) => setMessagePinned(people[index % 3], message.id, true)));
      const failed = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
      assert.equal(results.length - failed.length, CHAT_PINS_MAX);
      assert.equal(failed.length, 10);
      for (const failure of failed) assert.match((failure.reason as CrmError).message, /up to 50 pinned messages/);
      assert.equal(await pinRows(room), CHAT_PINS_MAX);
      await chatWorkSettled();
      assert.equal((await lines(room)).length, CHAT_PINS_MAX);
      assert.equal((await getPins(mark, room)).pins.length, CHAT_PINS_MAX);
      const pinnedIds = new Set(await pinned(mark, room));
      const spare = posted.find((message) => !pinnedIds.has(message.id))!;
      await refused(setMessagePinned(sam, spare.id, true), /up to 50 pinned messages/);
      const first = [...pinnedIds][0];
      assert.equal((await setMessagePinned(sam, first, true)).changed, false);
      await setMessagePinned(priya, first, false);
      assert.equal((await setMessagePinned(sam, spare.id, true)).changed, true);
      assert.equal(await pinRows(room), CHAT_PINS_MAX);
    });

    it("never leaves a pin on a message that is deleted while it is being pinned", async () => {
      const room = (await createRoom(mark, { name: "racing", memberIds: [sam.userId] })).id;
      const posted = [];
      for (let index = 0; index < 20; index += 1) posted.push((await postMessage(sam, { conversationId: room, body: `Race ${index}` })).message);
      await Promise.allSettled(posted.flatMap((message) => [setMessagePinned(mark, message.id, true), deleteMessage(sam, message.id)]));
      const left = await sql("select count(*)::int as n from crm.chat_pins p join crm.chat_messages m on m.id = p.message_id where p.conversation_id = $1 and m.deleted_at is not null", [room]);
      assert.equal(left.rows[0].n, 0);
      assert.equal(await pinRows(room), 0);
    });

    it("never pins in a room that is archived at the same moment", async () => {
      const room = (await createRoom(mark, { name: "closing", memberIds: [sam.userId] })).id;
      const posted = [];
      for (let index = 0; index < 10; index += 1) posted.push((await postMessage(sam, { conversationId: room, body: `Close ${index}` })).message);
      await Promise.allSettled([...posted.map((message) => setMessagePinned(sam, message.id, true)), setRoomArchived(mark, room, true)]);
      const archived = (await sql("select archived_at is not null as archived from crm.chat_conversations where id = $1", [room])).rows[0].archived as boolean;
      assert.equal(archived, true);
      const before = await pinRows(room);
      await Promise.allSettled(posted.map((message) => setMessagePinned(sam, message.id, true)));
      assert.equal(await pinRows(room), before);
    });
  });

  describe("on the page", () => {
    const quote: ChatQuote = {
      id: MISSING,
      conversationId: sales,
      author: { id: null, name: "Sam Okafor" },
      excerpt: "Renewal is on 1 December",
      files: 0,
      createdAt: "2026-11-19T10:00:00.000Z",
      place: "#sales",
      href: `/chat/${sales}?message=${MISSING}`,
    };

    it("says Message unavailable when the viewer can't see the original, and holds none of its text", async () => {
      const original = (await postMessage(sam, { conversationId: sales, body: SECRET })).message;
      await loadQuotes([original.id], { load: async (ids) => (await getMessages(priya, ids)).quotes });
      assert.equal(cachedQuote(original.id), null);
      assert.equal(quoteView(cachedQuote(original.id), false), "unavailable");
      assert.equal(QUOTE_UNAVAILABLE, "Message unavailable");
      const seen = (await postMessage(sam, { conversationId: sales, body: SECRET })).message;
      await loadQuotes([seen.id], { load: async (ids) => (await getMessages(sam, ids)).quotes });
      assert.equal(cachedQuote(seen.id)?.excerpt, SECRET);
      assert.equal(quoteView(cachedQuote(seen.id), false), "shown");
    });

    it("tells loading, failed, unavailable and shown apart", () => {
      assert.equal(quoteView(undefined, false), "loading");
      assert.equal(quoteView(undefined, true), "failed");
      assert.equal(quoteView(null, false), "unavailable");
      assert.equal(quoteView(null, true), "unavailable");
      assert.equal(quoteView(quote, true), "shown");
      const source = readFileSync("components/chat/quoted-message.tsx", "utf8");
      assert.match(source, /QUOTE_UNAVAILABLE\}/);
    });

    it("loads each id once, in batches of 50, and keeps what it learned", async () => {
      const ids = Array.from({ length: 120 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
      const calls: string[][] = [];
      const load = async (wanted: string[]) => {
        calls.push(wanted);
        return wanted.filter((_, index) => index % 2 === 0).map((id) => ({ ...quote, id }));
      };
      await Promise.all([loadQuotes(ids, { load }), loadQuotes(ids.slice(0, 10), { load })]);
      assert.deepEqual(calls.map((call) => call.length), [50, 50, 20]);
      assert.equal(cachedQuote(ids[0])?.id, ids[0]);
      assert.equal(cachedQuote(ids[1]), null);
      await loadQuotes(ids, { load });
      assert.equal(calls.length, 3);
    });

    it("turns a cached quote unavailable on a delete event, refetches it on an edit event and drops a conversation's quotes when removed", async () => {
      const id = "00000000-0000-4000-8000-0000000000e1";
      const other = "00000000-0000-4000-8000-0000000000e2";
      const room = { a: "room-a", b: "room-b" };
      const elsewhere = "00000000-0000-4000-8000-0000000000e3";
      await loadQuotes([id, other, elsewhere], {
        load: async (wanted) => wanted.map((item) => ({ ...quote, id: item, conversationId: item === elsewhere ? room.b : room.a })),
      });
      let notified = 0;
      const { subscribeQuotes } = await import("@/lib/chat/quotes");
      const stop = subscribeQuotes(() => {
        notified += 1;
      });
      const real = globalThis.fetch;
      const asked: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return new Response(JSON.stringify({ quotes: [{ ...quote, id, conversationId: room.a, excerpt: "Renewal moved to 8 December" }] }), { status: 200 });
      }) as typeof fetch;
      try {
        const base = { conversationId: room.a, message: { id } as never };
        applyQuoteEvent({ type: "edit", ...base });
        assert.equal(cachedQuote(id)?.excerpt, "Renewal is on 1 December");
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(asked.length >= 1 && asked[0].includes(`id=${id}`), true);
        assert.equal(cachedQuote(id)?.excerpt, "Renewal moved to 8 December");
        assert.ok(notified > 0);
        applyQuoteEvent({ type: "edit", conversationId: room.a, message: { id: "00000000-0000-4000-8000-0000000000ff" } as never });
        const before = asked.length;
        applyQuoteEvent({ type: "delete", conversationId: room.a, messageId: other, parentId: null, root: null });
        assert.equal(cachedQuote(other), null);
        assert.equal(asked.length, before);
        applyQuoteEvent({ type: "removed", conversationId: room.b });
        assert.equal(cachedQuote(elsewhere), null);
        assert.equal(cachedQuote(id)?.conversationId, room.a);
        applyQuoteEvent({ type: "delete", conversationId: room.a, messageId: id, parentId: null, root: null });
        assert.equal(cachedQuote(id), null);
        assert.equal(quoteView(cachedQuote(id), false), "unavailable");
      } finally {
        globalThis.fetch = real;
        stop();
      }
    });

    it("asks once for the ids several messages want in the same moment", async () => {
      const real = globalThis.fetch;
      const asked: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return new Response(JSON.stringify({ quotes: [] }), { status: 200 });
      }) as typeof fetch;
      try {
        const [one, two] = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"];
        await Promise.all([requestQuote(one), requestQuote(two), requestQuote(one)]);
        assert.equal(asked.length, 1);
        assert.match(asked[0], new RegExp(`id=${one}&id=${two}`));
        assert.equal(cachedQuote(one), null);
      } finally {
        globalThis.fetch = real;
      }
    });
  });

  describe("the pins store", () => {
    it("keeps one request going per conversation and asks again once if told twice", async () => {
      const { useChatPins } = await import("@/stores/chat-pins-store");
      const real = globalThis.fetch;
      let calls = 0;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) await held;
        return new Response(JSON.stringify({ pins: [] }), { status: 200 });
      }) as typeof fetch;
      try {
        const store = useChatPins.getState();
        store.load("c1");
        store.load("c1");
        store.load("c1", { force: true });
        store.load("c1", { force: true });
        assert.equal(calls, 1);
        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(calls, 2);
        assert.deepEqual(useChatPins.getState().rooms.c1, []);
        useChatPins.getState().load("c1");
        assert.equal(calls, 2);
      } finally {
        globalThis.fetch = real;
      }
    });

    it("adds and removes pins for the room that has loaded and ignores the others", async () => {
      const { useChatPins } = await import("@/stores/chat-pins-store");
      const base = { conversationId: "c2", parentId: null, kind: "message" as const, author: { id: "a", name: "A" }, via: null, clientKey: null, body: "x", format: "plain" as const, mentions: [], replyCount: 0, lastReplyAt: null, replyAuthors: [], editedAt: null, deletedAt: null, createdAt: "2026-11-19T10:00:00.000Z", hook: null, attachments: [], previews: [], reactions: [], quotedId: null };
      useChatPins.setState({ rooms: { c2: [] } });
      useChatPins.getState().add({ ...base, id: "m1" }, { id: "p", name: "P" });
      useChatPins.getState().add({ ...base, id: "m1" }, { id: "p", name: "P" });
      useChatPins.getState().add({ ...base, id: "m2", conversationId: "other" }, { id: "p", name: "P" });
      assert.deepEqual(useChatPins.getState().rooms.c2?.map((pin) => pin.message.id), ["m1"]);
      assert.equal(useChatPins.getState().rooms.other, undefined);
      useChatPins.getState().edit({ ...base, id: "m1", body: "changed" });
      assert.equal(useChatPins.getState().rooms.c2?.[0].message.body, "changed");
      useChatPins.getState().remove("c2", "m1");
      assert.deepEqual(useChatPins.getState().rooms.c2, []);
      useChatPins.getState().forget("c2");
      assert.equal(useChatPins.getState().rooms.c2, undefined);
    });
  });
});
