import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chatEmoji, emojiByCode, searchEmoji, withTone } from "@/lib/chat/emoji";
import { shortcodeAt } from "@/lib/chat/compose";
import { DEFAULT_RECENT_EMOJI } from "@/lib/chat/client";
import { applyReactions, chatReducer, EMPTY_CHAT, toggledReactions } from "@/lib/chat/timeline";
import { CHAT_REACTION_MAX, type ChatLiveEvent, type ChatMessage } from "@/lib/chat/types";
import {
  chatWorkSettled,
  createRoom,
  deleteMessage,
  listMessages,
  listThread,
  openDiscussion,
  openDm,
  postMessage,
  reactToMessage,
} from "@/lib/crm/chat";
import { createCompany } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const THUMBS = "\u{1F44D}️";
const TADA = "\u{1F389}";
const ROCKET = "\u{1F680}";

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

async function mcp(actor: UserActor, name: string, args: Record<string, unknown>) {
  const server = createCrmMcpServer(actor, { personal: { tokenId: "00000000-0000-4000-8000-0000000000ab", canSend: false } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "reactions-test", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const answer = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { error: answer.isError === true, text: answer.content[0].text };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("emoji list", () => {
  it("accepts emoji from the list in any presentation and refuses anything else", () => {
    assert.equal(chatEmoji("\u{1F44D}"), THUMBS);
    assert.equal(chatEmoji(THUMBS), THUMBS);
    assert.equal(chatEmoji(ROCKET), ROCKET);
    assert.equal(chatEmoji("\u{1F44D}\u{1F3FD}"), "\u{1F44D}\u{1F3FD}");
    assert.equal(withTone(THUMBS, 3), "\u{1F44D}\u{1F3FD}");
    assert.equal(withTone(ROCKET, 3), ROCKET);
    for (const bad of ["", "hello", "\u{1F44D}\u{1F44D}", `${THUMBS} `, "\u{1F680}\u{1F3FD}", "\u{1F44D}\u{1F3FB}\u{1F3FD}", "<script>", 42, null, "a".repeat(80)]) {
      assert.equal(chatEmoji(bad), null, String(bad));
    }
    for (const emoji of DEFAULT_RECENT_EMOJI) assert.equal(chatEmoji(emoji), emoji);
    assert.equal(emojiByCode(":tada:"), TADA);
    assert.equal(emojiByCode("thumbsup"), THUMBS);
    assert.equal(emojiByCode(":nope_nothing:"), null);
  });

  it("finds shortcodes after a colon and two letters, never inside times", () => {
    assert.deepEqual(shortcodeAt("Shipped :ro", 11), { start: 8, end: 11, query: "ro" });
    assert.equal(shortcodeAt("Shipped :r", 10), null);
    assert.equal(shortcodeAt("Call at 10:30", 13), null);
    assert.equal(shortcodeAt("Shipped:ro", 10), null);
    assert.equal(searchEmoji("ro")[0].codes.some((code) => code.startsWith("ro")), true);
    assert.equal(searchEmoji("rocket")[0].emoji, ROCKET);
    assert.equal(searchEmoji("tada")[0].emoji, TADA);
  });
});

describe("reactions in the timeline", () => {
  const me = { id: "me", name: "Me" };
  const base = {
    id: "m1",
    conversationId: "c1",
    parentId: null,
    author: { id: "sam", name: "Sam" },
    via: null,
    clientKey: null,
    body: "Hi",
    format: "plain",
    mentions: [],
    replyCount: 0,
    lastReplyAt: null,
    replyAuthors: [],
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-11-19T10:00:00.000Z",
    hook: null,
    reactions: [],
  } satisfies ChatMessage;

  it("toggles on and off locally and ignores an older live event", () => {
    const on = toggledReactions([], TADA, me);
    assert.deepEqual(on, [{ emoji: TADA, count: 1, mine: true, people: [me] }]);
    assert.deepEqual(toggledReactions(on, TADA, me), []);
    const shared = [{ emoji: TADA, count: 1, mine: false, people: [{ id: "sam", name: "Sam" }] }];
    assert.equal(toggledReactions(shared, TADA, me)[0].count, 2);
    const newer = applyReactions([base], "m1", on, "2026-11-19T10:00:02.000Z");
    assert.deepEqual(applyReactions(newer, "m1", [], "2026-11-19T10:00:01.000Z"), newer);
    const state = chatReducer(
      { ...EMPTY_CHAT, timelines: { c1: { messages: [base], hasOlder: false, hasNewer: false, firstUnreadId: null, lastReadAt: null, status: "ready", error: null, stale: false, after: null, gone: [] } } },
      { type: "reactions", conversationId: "c1", messageId: "m1", parentId: null, reactions: on, at: "2026-11-19T10:00:03.000Z" },
    );
    assert.deepEqual(state.timelines.c1.messages[0].reactions, on);
  });
});

describe("reactions", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let ada: UserActor;
  let olly: UserActor;
  let room: string;
  let broadcasts: LiveMessage[];

  function reactionEvents(userId: string) {
    return broadcasts
      .filter((message) => message.topic === personTopic(userId) && message.event === "chat")
      .map((message) => message.payload as ChatLiveEvent)
      .filter((event): event is Extract<ChatLiveEvent, { type: "reaction" }> => event.type === "reaction");
  }

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@react.test", "Mark Ridgeon");
    sam = await join(await createUser("sam@react.test", "Sam Okafor"), mark.workspaceId);
    priya = await join(await createUser("priya@react.test", "Priya Nair"), mark.workspaceId);
    ada = await join(await createUser("ada@react.test", "Ada Admin"), mark.workspaceId, "admin");
    olly = await createUser("olly@elsewhere.test", "Olly Outside");
    room = (await createRoom(mark, { name: "sales", memberIds: [sam.userId] })).id;
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
  });

  describe("on the serverless pool", () => {
    useServerlessPool();

    it("toggles a reaction on and off and shows who reacted in message reads", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Acme signed" });
      const added = await reactToMessage(mark, message.id, "\u{1F389}");
      assert.equal(added.added, true);
      assert.deepEqual(added.reactions, [{ emoji: TADA, count: 1, mine: true, people: [{ id: mark.userId, name: "Mark Ridgeon" }] }]);
      await reactToMessage(sam, message.id, TADA);
      const page = await listMessages(sam, room);
      const read = page.messages.find((item) => item.id === message.id)!;
      assert.deepEqual(read.reactions, [
        {
          emoji: TADA,
          count: 2,
          mine: true,
          people: [
            { id: mark.userId, name: "Mark Ridgeon" },
            { id: sam.userId, name: "Sam Okafor" },
          ],
        },
      ]);
      const removed = await reactToMessage(mark, message.id, TADA);
      assert.equal(removed.added, false);
      assert.deepEqual(
        removed.reactions.map((reaction) => [reaction.emoji, reaction.count, reaction.mine]),
        [[TADA, 1, false]],
      );
      await reactToMessage(sam, message.id, TADA);
      assert.deepEqual((await listMessages(mark, room)).messages.find((item) => item.id === message.id)!.reactions, []);
    });

    it("sends the live event to each member on their own channel with their own mine, and alerts no one", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Pricing agreed" });
      broadcasts = [];
      const reacted = await reactToMessage(mark, message.id, ROCKET);
      await chatWorkSettled();
      const forMark = reactionEvents(mark.userId);
      const forSam = reactionEvents(sam.userId);
      assert.equal(forMark.length, 1);
      assert.equal(forSam.length, 1);
      assert.deepEqual(
        { ...forSam[0], reactions: undefined },
        { type: "reaction", conversationId: room, messageId: message.id, parentId: null, reactions: undefined, at: reacted.at },
      );
      assert.equal(forMark[0].reactions[0].mine, true);
      assert.equal(forSam[0].reactions[0].mine, false);
      assert.equal(reactionEvents(priya.userId).length, 0);
      assert.ok(broadcasts.every((item) => item.topic.startsWith("person:") || !item.topic.startsWith("chat:")));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await sql("select count(*)::int as n from crm.notifications")).rows[0].n, 0);
    });

    it("reacts to thread replies and in direct messages", async () => {
      const { message: root } = await postMessage(mark, { conversationId: room, body: "Thread start" });
      const { message: reply } = await postMessage(sam, { conversationId: room, parentId: root.id, body: "Reply" });
      const reacted = await reactToMessage(mark, reply.id, THUMBS);
      assert.equal(reacted.parentId, root.id);
      const thread = await listThread(sam, root.id);
      assert.equal(thread.replies[0].reactions[0].emoji, THUMBS);
      const dm = await openDm(mark, sam.userId);
      const { message } = await postMessage(mark, { conversationId: dm.id, body: "Private" });
      assert.equal((await reactToMessage(sam, message.id, ROCKET)).added, true);
      await refused(reactToMessage(priya, message.id, ROCKET), /Message not found\./);
    });

    it("refuses people outside the conversation, and they never see its reactions", async () => {
      const { message } = await postMessage(mark, { conversationId: room, body: "Members only" });
      await reactToMessage(sam, message.id, THUMBS);
      await refused(reactToMessage(olly, message.id, THUMBS), /Message not found\./);
      await refused(reactToMessage(priya, message.id, THUMBS), /Message not found\./);
      await refused(reactToMessage(ada, message.id, THUMBS), /Message not found\./);
      await refused(reactToMessage(priya, "00000000-0000-4000-8000-000000000000", THUMBS), /Message not found\./);
      for (const outsider of [olly, priya, ada]) {
        const seen = await queryAsUser<{ n: number }>(outsider.userId, "select count(*)::int as n from crm.chat_reactions where message_id = $1", [message.id]);
        assert.equal(seen[0].n, 0);
      }
      const member = await queryAsUser<{ n: number }>(sam.userId, "select count(*)::int as n from crm.chat_reactions where message_id = $1", [message.id]);
      assert.equal(member[0].n, 1);
      assert.equal((await sql("select count(*)::int as n from crm.chat_reactions where message_id = $1", [message.id])).rows[0].n, 1);
      await assert.rejects(queryAsUser(sam.userId, "insert into crm.chat_reactions (message_id, user_id, emoji) values ($1, $2, $3)", [message.id, sam.userId, ROCKET]), /permission denied/);
      await assert.rejects(queryAsUser(sam.userId, "delete from crm.chat_reactions where message_id = $1", [message.id]), /permission denied/);
    });

    it("lets people on a task react in its discussion, and no one else, admins included", async () => {
      const companyId = (await createCompany(mark, { name: "Halden Group", domain: "halden.test" })).body.company.id;
      const task = (await createTask(mark, { title: "Send Halden pricing", companyId, ownerId: sam.userId })).body.task;
      const { conversationId } = await openDiscussion(sam, { kind: "task", id: task.id });
      const { message } = await postMessage(sam, { conversationId, body: "Draft is in the doc" });
      broadcasts = [];
      assert.equal((await reactToMessage(mark, message.id, THUMBS)).added, true);
      await chatWorkSettled();
      assert.equal(reactionEvents(sam.userId).length, 1);
      assert.equal(reactionEvents(priya.userId).length, 0);
      assert.equal(reactionEvents(ada.userId).length, 0);
      await refused(reactToMessage(priya, message.id, THUMBS), /Message not found\./);
      await refused(reactToMessage(ada, message.id, THUMBS), /Message not found\./);
      for (const outsider of [priya, ada, olly]) {
        const seen = await queryAsUser<{ n: number }>(outsider.userId, "select count(*)::int as n from crm.chat_reactions where message_id = $1", [message.id]);
        assert.equal(seen[0].n, 0);
      }
      const read = await listMessages(sam, conversationId);
      assert.equal(read.messages[0].reactions[0].people[0].id, mark.userId);
    });

    it("refuses deleted messages, archived conversations and emoji outside the list", async () => {
      const { message } = await postMessage(mark, { conversationId: room, body: "Going away" });
      await reactToMessage(sam, message.id, THUMBS);
      for (const bad of ["hello", "\u{1F44D}\u{1F44D}", "", ":thumbsup:"]) await refused(reactToMessage(mark, message.id, bad), /Pick an emoji from the list\./);
      await deleteMessage(mark, message.id);
      await refused(reactToMessage(sam, message.id, ROCKET), /That message was deleted\./);
      const archived = (await createRoom(mark, { name: "q3-launch", memberIds: [sam.userId] })).id;
      const { message: old } = await postMessage(mark, { conversationId: archived, body: "Launch done" });
      await sql("update crm.chat_conversations set archived_at = now() where id = $1", [archived]);
      await refused(reactToMessage(sam, old.id, ROCKET), /This room is archived\./);
      assert.equal((await sql("select count(*)::int as n from crm.chat_reactions where message_id = $1", [old.id])).rows[0].n, 0);
    });

    it("reads and adds reactions over MCP in rooms and DMs, and refuses discussions", async () => {
      const { message } = await postMessage(sam, { conversationId: room, body: "Ship it" });
      const added = await mcp(mark, "chat_react", { message_id: message.id, emoji: ":tada:" });
      assert.equal(added.error, false, added.text);
      assert.deepEqual(JSON.parse(added.text).changed, true);
      const again = await mcp(mark, "chat_react", { message_id: message.id, emoji: TADA });
      assert.equal(JSON.parse(again.text).changed, false);
      const read = JSON.parse((await mcp(sam, "chat_read", { conversation_id: room })).text) as { messages: { id: string; reactions: { emoji: string; mine: boolean; people: { name: string }[] }[] }[] };
      const seen = read.messages.find((item) => item.id === message.id)!;
      assert.deepEqual(seen.reactions.map((reaction) => [reaction.emoji, reaction.mine, reaction.people[0].name]), [[TADA, false, "Mark Ridgeon"]]);
      const removed = await mcp(mark, "chat_react", { message_id: message.id, emoji: TADA, remove: true });
      assert.equal(JSON.parse(removed.text).changed, true);
      assert.deepEqual(JSON.parse(removed.text).reactions, []);
      const dm = await openDm(mark, sam.userId);
      const { message: direct } = await postMessage(sam, { conversationId: dm.id, body: "Lunch?" });
      assert.equal(JSON.parse((await mcp(mark, "chat_react", { message_id: direct.id, emoji: THUMBS })).text).changed, true);
      const companyId = (await createCompany(mark, { name: "Quillfeather", domain: "quill.test" })).body.company.id;
      const task = (await createTask(mark, { title: "Quillfeather pilot", companyId, ownerId: mark.userId })).body.task;
      const { conversationId } = await openDiscussion(mark, { kind: "task", id: task.id });
      const { message: note } = await postMessage(mark, { conversationId, body: "Pilot scope" });
      const discussion = await mcp(mark, "chat_react", { message_id: note.id, emoji: THUMBS });
      assert.equal(discussion.error, true);
      assert.match(discussion.text, /^not_found: .*discussions aren't reachable here/);
      assert.equal((await sql("select count(*)::int as n from crm.chat_reactions where message_id = $1", [note.id])).rows[0].n, 0);
      const outsider = await mcp(olly, "chat_react", { message_id: message.id, emoji: THUMBS });
      assert.match(outsider.text, /^not_found: /);
      const nonsense = await mcp(mark, "chat_react", { message_id: message.id, emoji: "not an emoji" });
      assert.match(nonsense.text, /^invalid_input: /);
    });
  });

  describe("under concurrent writes", () => {
    it(`holds the ${CHAT_REACTION_MAX} different emoji cap when people react at once`, async () => {
      const { message } = await postMessage(mark, { conversationId: room, body: "Vote" });
      const pool = ["\u{1F600}", "\u{1F603}", "\u{1F604}", "\u{1F601}", "\u{1F606}", "\u{1F605}", "\u{1F923}", "\u{1F602}", "\u{1F642}", "\u{1F643}", "\u{1F609}", "\u{1F60A}", "\u{1F607}", "\u{1F970}", "\u{1F60D}", "\u{1F929}", "\u{1F618}", "\u{1F617}", "\u{1F61A}", "\u{1F619}", "\u{1F60B}", "\u{1F61B}", "\u{1F61C}", "\u{1F92A}", "\u{1F61D}", "\u{1F911}", "\u{1F917}", "\u{1F92D}", "\u{1F92B}", "\u{1F914}"];
      for (const emoji of pool) assert.ok(chatEmoji(emoji), emoji);
      const results = await Promise.allSettled(pool.map((emoji, index) => reactToMessage(index % 2 === 0 ? mark : sam, message.id, emoji)));
      const distinct = (await sql("select count(distinct emoji)::int as n from crm.chat_reactions where message_id = $1", [message.id])).rows[0].n;
      assert.equal(distinct, CHAT_REACTION_MAX);
      const failures = results.filter((result) => result.status === "rejected");
      assert.equal(failures.length, pool.length - CHAT_REACTION_MAX);
      for (const failure of failures) assert.match(((failure as PromiseRejectedResult).reason as Error).message, /up to 20 different reactions/);
      const existing = (await sql("select emoji from crm.chat_reactions where message_id = $1 and user_id = $2 limit 1", [message.id, mark.userId])).rows[0].emoji as string;
      assert.equal((await reactToMessage(sam, message.id, existing)).added, true);
      await refused(reactToMessage(sam, message.id, ROCKET), /up to 20 different reactions/);
    });
  });
});
