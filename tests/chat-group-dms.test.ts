import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runTool } from "@/lib/assistant/tools";
import { chatJumps } from "@/lib/chat/jump";
import { savedPlace } from "@/lib/chat/saved";
import { chatEmoji } from "@/lib/chat/emoji";
import { postChat } from "@/lib/chat/tools";
import { CHAT_GROUP_MAX, groupName, type ChatConversation, type ChatLiveEvent } from "@/lib/chat/types";
import {
  addRoomMembers,
  chatWorkSettled,
  getConversation,
  getRoom,
  listConversations,
  listMessages,
  listThreads,
  listUnreads,
  markAllChatRead,
  markConversationRead,
  openDm,
  openGroup,
  postMessage,
  reactToMessage,
  removeRoomMember,
  roomsLostOnLeaving,
  searchMessages,
  setConversationNotify,
  setRoomArchived,
  updateRoom,
} from "@/lib/crm/chat";
import { chatFileLink, prepareChatUpload } from "@/lib/crm/chat-attachments";
import { createHook } from "@/lib/crm/chat-hooks";
import { listSaved, setMessageSaved } from "@/lib/crm/chat-saved";
import { searchChat } from "@/lib/crm/chat-search";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Actor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { resetStorageBucketCache } from "@/lib/storage";
import { createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const SUPABASE = "https://project.supabase.test";
const BUCKET = "email-attachments";
const MIGRATION = "supabase/migrations/20270228100000_chat_group_dms.sql";

type Answer = { content: { type: string; text: string }[]; isError?: boolean };

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

async function titles(userId: string) {
  await chatWorkSettled();
  return (await sql<{ title: string }>("select title from crm.notifications where user_id = $1 order by created_at, id", [userId])).map((row) => row.title);
}

function storage() {
  const objects = new Map<string, { bytes: number; type: string }>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === `${SUPABASE}/storage/v1/bucket`) return Response.json({ name: BUCKET });
    const uploadSign = url.match(/\/storage\/v1\/object\/upload\/sign\/email-attachments\/(.+)$/);
    if (uploadSign) return Response.json({ url: `/object/upload/sign/${BUCKET}/${uploadSign[1]}?token=up` });
    const sign = url.match(/\/storage\/v1\/object\/sign\/email-attachments\/(.+)$/);
    if (sign && method === "POST") return Response.json({ signedURL: `/object/sign/${BUCKET}/${sign[1]}?token=down` });
    const object = url.match(/\/storage\/v1\/object\/email-attachments\/(.+)$/);
    if (object && method === "HEAD") {
      const stored = objects.get(object[1]);
      if (!stored) return new Response(null, { status: 400 });
      return new Response(null, { status: 200, headers: { "content-type": stored.type, "content-length": String(stored.bytes) } });
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { fetchImpl, objects };
}

async function connect(actor: Actor) {
  const server = (await import("@/server/mcp/server")).createCrmMcpServer(actor, { personal: { tokenId: "00000000-0000-4000-8000-0000000000bb", canSend: false } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "group-dm-test", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Answer,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function mcp<T>(actor: Actor, name: string, args: Record<string, unknown> = {}) {
  const session = await connect(actor);
  try {
    const answer = await session.call(name, args);
    return { error: answer.isError ? answer.content[0].text : null, value: answer.isError ? (null as T | null) : (JSON.parse(answer.content[0].text) as T) };
  } finally {
    await session.close();
  }
}

describe("group direct messages", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let ada: UserActor;
  let olly: UserActor;
  let quin: UserActor;
  let crowd: UserActor[];
  let broadcasts: LiveMessage[];
  let counter = 0;

  async function member(email: string, name: string, workspaceId = mark.workspaceId): Promise<UserActor> {
    const user = await createUser(email, name);
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [workspaceId, user.userId]);
    return { ...user, workspaceId, role: "member", scopes: scopesForRole("member") };
  }

  function say(actor: UserActor, conversationId: string, body: string, parentId: string | null = null) {
    counter += 1;
    return postMessage(actor, { conversationId, parentId, body, clientKey: `group-${counter}` });
  }

  async function sidebarEntry(person: UserActor, conversationId: string) {
    return (await listConversations(person)).conversations.find((conversation) => conversation.id === conversationId);
  }

  async function memberIds(conversationId: string) {
    return (await sql<{ user_id: string }>("select user_id from crm.chat_members where conversation_id = $1 order by user_id", [conversationId])).map((row) => row.user_id).sort();
  }

  async function makeGroup(creator: UserActor, others: UserActor[]) {
    return openGroup(creator, others.map((person) => person.userId));
  }

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@group.test", "Mark Ridgeon");
    sam = await member("sam@group.test", "Sam Okafor");
    priya = await member("priya@group.test", "Priya Nair");
    ada = await member("ada@group.test", "Ada Admin");
    olly = await createUser("olly@elsewhere.test", "Olly Outside");
    quin = await createUser("quin@second.test", "Quin Second");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [quin.workspaceId, mark.userId]);
    crowd = [];
    for (let index = 1; index <= 6; index += 1) crowd.push(await member(`crowd${index}@group.test`, `Crowd ${String.fromCharCode(64 + index)}`));
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
    await chatWorkSettled();
    await getPool().end();
    await getAdminPool().end();
  });

  const pool = useServerlessPool();

  it("runs its migration twice", async () => {
    pool.allowNestedConnections();
    await applyMigrationSql(getAdminPool(), readFileSync(MIGRATION, "utf8"));
    const kinds = await sql<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'chat_conversations_kind_check'");
    assert.match(kinds[0].def, /group_dm/);
    assert.equal((await sql("select 1 from pg_proc where proname = 'chat_open_group'")).length, 1);
  });

  it("opens one conversation per member set, whoever opens it and in whatever order", async () => {
    const first = await makeGroup(mark, [sam, priya]);
    assert.equal(first.kind, "group_dm");
    assert.equal(first.name, "Priya Nair and Sam Okafor");
    assert.deepEqual(first.people.map((person) => person.name), ["Priya Nair", "Sam Okafor"]);
    assert.equal(first.dmUser, null);
    assert.equal(first.notify, "default");
    const again = await openGroup(priya, [sam.userId, mark.userId, sam.userId, priya.userId]);
    assert.equal(again.id, first.id);
    assert.equal(again.name, "Mark Ridgeon and Sam Okafor");
    const third = await openGroup(sam, [priya.userId, mark.userId]);
    assert.equal(third.id, first.id);
    assert.equal(third.name, "Mark Ridgeon and Priya Nair");
    assert.deepEqual(await memberIds(first.id), [mark.userId, sam.userId, priya.userId].sort());
    const key = (await sql<{ dm_key: string }>("select dm_key from crm.chat_conversations where id = $1", [first.id]))[0].dm_key;
    assert.equal(key, [mark.userId, sam.userId, priya.userId].sort().join(":"));
    assert.equal((await sql("select 1 from crm.chat_conversations where kind = 'group_dm' and dm_key = $1", [key])).length, 1);
    assert.equal(groupName(["Ana", "Ben", "Sam"]), "Ana, Ben and Sam");
    assert.equal(groupName(["Ana"]), "Ana");
  });

  it("opens a normal direct message for one other person, however it is asked for", async () => {
    const dm = await openGroup(mark, [sam.userId]);
    assert.equal(dm.kind, "dm");
    assert.equal(dm.id, (await openDm(mark, sam.userId)).id);
    assert.equal((await openGroup(sam, [mark.userId, sam.userId])).id, dm.id);
    await refused(openGroup(mark, []), /Pick someone to message/);
    await refused(openGroup(mark, [mark.userId]), /Pick someone to message/);
    await refused(openGroup(mark, ["not-an-id"]), /Pick people from the list/);
  });

  it("takes up to eight people including the creator, and refuses more or anyone who shares no workspace", async () => {
    const seven = [sam, priya, ada, ...crowd.slice(0, 4)];
    const full = await makeGroup(mark, seven);
    assert.equal(full.kind, "group_dm");
    assert.equal((await memberIds(full.id)).length, CHAT_GROUP_MAX);
    const nine = [...seven, crowd[4]];
    await refused(makeGroup(mark, nine), /up to 8 people/);
    await refused(openGroup(mark, [...nine.map((person) => person.userId), crowd[5].userId]), /up to 8 people/);
    await assert.rejects(sql("select private.chat_open_group($1, $2::uuid[])", [mark.userId, nine.map((person) => person.userId)]), /up to 8 people/);
    const before = (await sql<{ n: number }>("select count(*)::int as n from crm.chat_conversations where kind = 'group_dm'"))[0].n;
    await refused(makeGroup(mark, [sam, olly]), /share a workspace with you/);
    await refused(makeGroup(sam, [mark, quin]), /share a workspace with you/);
    assert.equal((await sql<{ n: number }>("select count(*)::int as n from crm.chat_conversations where kind = 'group_dm'"))[0].n, before);
    const bridged = await makeGroup(mark, [sam, quin]);
    assert.equal(bridged.kind, "group_dm");
    assert.deepEqual((await memberIds(bridged.id)).length, 3);
  });

  it("can't be built outside the rules in the database", async () => {
    await assert.rejects(
      sql("insert into crm.chat_conversations (kind, dm_key) values ('group_dm', $1)", [`${mark.userId}:${sam.userId}`]),
      /chat_conversations_shape_check/,
    );
    await assert.rejects(
      sql("insert into crm.chat_conversations (kind, dm_key, name) values ('group_dm', $1, 'x')", [[mark.userId, sam.userId, priya.userId].join(":")]),
      /chat_conversations_shape_check/,
    );
    await assert.rejects(
      queryAsUser(mark.userId, "insert into crm.chat_conversations (kind, dm_key, created_by) values ('group_dm', $1, $2)", [[mark.userId, sam.userId, ada.userId].join(":"), mark.userId]),
      /permission denied|row-level security/,
    );
  });

  it("opens two creators of the same set at once into one conversation", async () => {
    const people = [mark, sam, ada];
    const key = people.map((person) => person.userId).sort().join(":");
    const admin = getAdminPool();
    const first = await admin.connect();
    const second = await admin.connect();
    try {
      await first.query("begin");
      await second.query("begin");
      const opened = await first.query<{ id: string }>("select private.chat_open_group($1, $2::uuid[]) as id", [mark.userId, [sam.userId, ada.userId]]);
      const racing = second.query<{ id: string }>("select private.chat_open_group($1, $2::uuid[]) as id", [sam.userId, [ada.userId, mark.userId]]);
      let waiting = false;
      for (let attempt = 0; attempt < 50 && !waiting; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        waiting = (await sql("select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%chat_open_group%' and pid <> pg_backend_pid()")).length > 0;
      }
      assert.ok(waiting, "The second creator should be waiting on the first one's row");
      await first.query("commit");
      const joined = await racing;
      await second.query("commit");
      assert.equal(joined.rows[0].id, opened.rows[0].id);
    } finally {
      first.release();
      second.release();
    }
    assert.equal((await sql("select 1 from crm.chat_conversations where dm_key = $1", [key])).length, 1);
    assert.deepEqual(await memberIds((await sql<{ id: string }>("select id from crm.chat_conversations where dm_key = $1", [key]))[0].id), people.map((person) => person.userId).sort());
  });

  it("opens the same set from three people at the same moment into one conversation", async () => {
    const people = [mark, sam, priya, ada, crowd[0]];
    const opened = await Promise.all(people.map((person) => openGroup(person, people.filter((other) => other !== person).map((other) => other.userId))));
    assert.equal(new Set(opened.map((conversation) => conversation.id)).size, 1);
    assert.equal((await memberIds(opened[0].id)).length, people.length);
  });

  describe("access", () => {
    let group: ChatConversation;
    let message: { id: string };
    let reply: { id: string };

    before(async () => {
      group = await makeGroup(mark, [sam, priya]);
      message = (await say(mark, group.id, "Quokka plan for the offsite")).message;
      reply = (await say(sam, group.id, "Quokka reply", message.id)).message;
      await reactToMessage(priya, message.id, "👍");
      await setMessageSaved(sam, message.id, true);
    });

    it("never shows the conversation, its messages, reactions, saved items or search hits to someone outside it", async () => {
      for (const outsider of [ada, olly, quin]) {
        assert.ok(!(await listConversations(outsider)).conversations.some((conversation) => conversation.id === group.id));
        await refused(getConversation(outsider, group.id), /Conversation not found/);
        await refused(getRoom(outsider, group.id), /Conversation not found/);
        await refused(listMessages(outsider, group.id), /Conversation not found/);
        await refused(searchMessages(outsider, group.id, "quokka"), /Conversation not found/);
        await refused(postMessage(outsider, { conversationId: group.id, body: "Let me in", clientKey: `intruder-${outsider.userId}` }), /Conversation not found/);
        await refused(reactToMessage(outsider, message.id, "👍"), /not found/i);
        await refused(markConversationRead(outsider, group.id), /not found/i);
        await refused(setConversationNotify(outsider, group.id, { notify: "mute" }), /not found/i);
        await refused(setMessageSaved(outsider, message.id, true), /./);
        assert.deepEqual((await searchChat(outsider, { text: "quokka" })).hits, []);
        assert.deepEqual((await searchChat(outsider, { text: "quokka", in: group.id })).hits, []);
        assert.ok(!(await listSaved(outsider)).items.some((item) => item.message.id === message.id));
        assert.ok(!(await listThreads(outsider)).threads.some((card) => card.conversation.id === group.id));
        assert.ok(!(await listUnreads(outsider)).groups.some((item) => item.conversation.id === group.id));
        const rows = async (table: string, column: string, id: string) => (await queryAsUser(outsider.userId, `select 1 from ${table} where ${column} = $1`, [id])).length;
        assert.equal(await rows("crm.chat_conversations", "id", group.id), 0);
        assert.equal(await rows("crm.chat_members", "conversation_id", group.id), 0);
        assert.equal(await rows("crm.chat_messages", "conversation_id", group.id), 0);
        assert.equal(await rows("crm.chat_reactions", "message_id", message.id), 0);
        assert.equal(await rows("crm.chat_saved", "message_id", message.id), 0);
        assert.equal(await rows("crm.chat_thread_reads", "message_id", message.id), 0);
        assert.equal(await queryAsUser(outsider.userId, "select 1 from crm.chat_messages where id = any($1::uuid[])", [[message.id, reply.id]]).then((found) => found.length), 0);
      }
    });

    it("shows it to every member, with the other members' names, threads and unread counts", async () => {
      for (const person of [mark, sam, priya]) {
        const entry = await sidebarEntry(person, group.id);
        assert.ok(entry, `${person.fullName} should see the group`);
        assert.equal(entry.kind, "group_dm");
        assert.ok(!entry.name.includes(person.fullName ?? "?"));
        assert.equal(entry.people.length, 2);
        assert.equal((await listMessages(person, group.id)).messages.length, 1);
      }
      assert.equal((await sidebarEntry(priya, group.id))?.name, "Mark Ridgeon and Sam Okafor");
      const card = (await listThreads(mark)).threads.find((item) => item.conversation.id === group.id);
      assert.equal(card?.conversation.kind, "group_dm");
      assert.equal(card?.conversation.name, "Priya Nair and Sam Okafor");
      assert.equal(card?.conversation.people.length, 2);
      const saved = (await listSaved(sam)).items.find((item) => item.message.id === message.id);
      assert.equal(saved?.conversation.kind, "group_dm");
      assert.equal(saved?.conversation.name, "Mark Ridgeon and Priya Nair");
      assert.equal(savedPlace(saved!.conversation), "Mark Ridgeon and Priya Nair");
      const room = await getRoom(priya, group.id);
      assert.deepEqual(room.members.map((person) => person.name).sort(), ["Mark Ridgeon", "Priya Nair", "Sam Okafor"]);
      assert.equal(room.canArchive, false);
    });

    it("finds its messages for members only, named for each of them", async () => {
      const forMark = (await searchChat(mark, { text: "quokka" })).hits;
      assert.deepEqual(forMark.map((hit) => hit.id).sort(), [message.id, reply.id].sort());
      assert.ok(forMark.every((hit) => hit.conversation.kind === "group_dm" && hit.conversation.name === "Priya Nair and Sam Okafor"));
      const forSam = (await searchChat(sam, { text: "quokka", in: group.id })).hits;
      assert.equal(forSam.length, 2);
      assert.ok(forSam.every((hit) => hit.conversation.name === "Mark Ridgeon and Priya Nair"));
      assert.equal(forSam[0].href, `/chat/${group.id}?thread=${message.id}&message=${reply.id}`);
      const agent = (await searchChat(priya, { text: "quokka" }, { agent: true })).hits;
      assert.equal(agent.length, 2);
      const sidebar = await listConversations(mark);
      assert.ok(chatJumps(sidebar, "priya sam", false).some((item) => item.id === group.id));
      assert.ok(!chatJumps(await listConversations(ada), "priya sam", false).some((item) => item.id === group.id));
      assert.ok(!chatJumps(await listConversations(olly), "priya sam", false).some((item) => item.id === group.id));
    });

    it("lets members react and keeps files to members", async () => {
      const reacted = await reactToMessage(sam, message.id, "🎉");
      assert.equal(reacted.changed, true);
      assert.deepEqual((await listMessages(mark, group.id)).messages[0].reactions.map((item) => item.emoji).sort(), [chatEmoji("🎉"), chatEmoji("👍")].sort());
      process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
      process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
      resetStorageBucketCache();
      try {
        const env = storage();
        const files = await prepareChatUpload(priya, group.id, [{ name: "plan.pdf", size: 1024, contentType: "application/pdf" }], env.fetchImpl);
        env.objects.set(`team-chat/${group.id}/${files[0].id}`, { bytes: 1024, type: "application/pdf" });
        const posted = await postMessage(priya, { conversationId: group.id, body: "", clientKey: "group-file", attachmentIds: [files[0].id] }, { fetchImpl: env.fetchImpl });
        assert.equal(posted.message.attachments[0].name, "plan.pdf");
        assert.match(await chatFileLink(mark, files[0].id, {}, env.fetchImpl), /\/object\/sign\//);
        for (const outsider of [ada, olly]) {
          await refused(prepareChatUpload(outsider, group.id, [{ name: "x.pdf", size: 10, contentType: "application/pdf" }], env.fetchImpl), /Conversation not found/);
          await refused(chatFileLink(outsider, files[0].id, {}, env.fetchImpl), /File not found/);
        }
        assert.equal((await sql<{ ok: boolean }>("select private.chat_attachment_open_to($1, $2) as ok", [group.id, ada.userId]))[0].ok, false);
        assert.equal((await sql<{ ok: boolean }>("select private.chat_attachment_open_to($1, $2) as ok", [group.id, sam.userId]))[0].ok, true);
        assert.ok((await titles(mark.userId)).includes("Priya sent your group a file"));
      } finally {
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      }
    });

    it("sends live events to its members only, and treats a group like a direct message in the badge", async () => {
      broadcasts.length = 0;
      await say(mark, group.id, "Live only for us");
      await chatWorkSettled();
      const targets = broadcasts.filter((item) => (item.payload as ChatLiveEvent).type === "message").map((item) => item.topic).sort();
      assert.deepEqual(targets, [mark.userId, sam.userId, priya.userId].map((id) => personTopic(id)).sort());
      const sidebar = await listConversations(sam);
      assert.equal(sidebar.mentioned, true);
    });

    it("is not a room: no settings, members, archive or hooks", async () => {
      await refused(addRoomMembers(mark, group.id, [ada.userId]), /Room not found/);
      await refused(removeRoomMember(mark, group.id, sam.userId), /Room not found/);
      await refused(updateRoom(mark, group.id, { topic: "Nope" }), /Room not found/);
      await refused(setRoomArchived(mark, group.id, true), /Room not found/);
      await refused(createHook(mark, group.id, "Nope"), /not found/i);
      await refused(postMessage(mark, { conversationId: group.id, body: "@room hi", format: "markdown", clientKey: "group-room" }, { roomMention: true }), /@room only works in rooms/);
    });
  });

  describe("alerts and unread counts", () => {
    it("alert members like a direct message, once per unread burst, and honour Nothing", async () => {
      const group = await makeGroup(mark, [sam, priya, ada]);
      assert.equal(await sidebarEntry(sam, group.id), undefined);
      await say(mark, group.id, "First");
      await say(mark, group.id, "Second");
      assert.deepEqual(await titles(sam.userId), ["Mark sent your group a message"]);
      assert.deepEqual(await titles(priya.userId), ["Mark sent your group a message"]);
      assert.deepEqual(await titles(mark.userId), []);
      const alert = (await sql<{ href: string; body: string | null; source: string }>("select href, body, source from crm.notifications where user_id = $1", [sam.userId]))[0];
      assert.deepEqual(alert, { href: `/chat/${group.id}`, body: null, source: "chat" });
      const entry = await sidebarEntry(sam, group.id);
      assert.equal(entry?.unread, 2);
      assert.equal(entry?.notify, "default");
      assert.equal((await listConversations(sam)).unreadConversations >= 1, true);
      assert.ok((await listUnreads(sam)).groups.some((item) => item.conversation.id === group.id && item.messages.length === 2));

      await setConversationNotify(priya, group.id, { notify: "mute" });
      await markConversationRead(sam, group.id);
      await say(mark, group.id, "Third");
      assert.deepEqual(await titles(sam.userId), ["Mark sent your group a message", "Mark sent your group a message"]);
      assert.deepEqual(await titles(priya.userId), ["Mark sent your group a message"]);
      assert.equal((await sidebarEntry(priya, group.id))?.unread, 3);
      assert.equal((await sidebarEntry(priya, group.id))?.notify, "mute");

      await refused(setConversationNotify(sam, group.id, { notify: "mentions" }), /all messages or nothing/);
      await setConversationNotify(sam, group.id, { notify: "all", starred: true });
      assert.equal((await sidebarEntry(sam, group.id))?.starred, true);

      await markAllChatRead(sam);
      assert.equal((await sidebarEntry(sam, group.id))?.unread, 0);
      await markConversationRead(ada, group.id);
      await markConversationRead(mark, group.id);
      await chatWorkSettled();
      await sql("truncate crm.push_log, crm.notifications");
      await say(sam, group.id, "Mark, are you there? @[Mark Ridgeon](member:" + mark.userId + ")");
      assert.deepEqual(await titles(mark.userId), ["Sam sent your group a message"]);
      assert.deepEqual(await titles(ada.userId), ["Sam sent your group a message"]);
    });

    it("alerts for files and thread replies without leaking text, and never as a task or doc discussion", async () => {
      const group = await makeGroup(mark, [sam, ada]);
      const root = (await say(mark, group.id, "Thread root")).message;
      await markConversationRead(sam, group.id);
      await markConversationRead(ada, group.id);
      await chatWorkSettled();
      await sql("truncate crm.push_log, crm.notifications");
      await say(sam, group.id, "A reply", root.id);
      await chatWorkSettled();
      const names = (await sql<{ title: string; body: string | null; source: string }>("select title, body, source from crm.notifications order by created_at, id"));
      assert.ok(names.length > 0);
      assert.ok(names.every((row) => row.source === "chat" && row.body === null));
      assert.ok(names.every((row) => row.title === "Sam replied in a thread"));
      const followers = (await sql<{ user_id: string }>("select user_id from crm.chat_thread_reads where message_id = $1", [root.id])).map((row) => row.user_id).sort();
      assert.deepEqual(followers, [mark.userId, sam.userId, ada.userId].sort());
      assert.deepEqual(await titles(mark.userId), ["Sam replied in a thread"]);
      assert.deepEqual(await titles(ada.userId), ["Sam replied in a thread"]);
    });
  });

  describe("a member who leaves", () => {
    it("is removed once they share no workspace with anyone left, and the rest keep reading and writing", async () => {
      const wanda = await member("wanda@group.test", "Wanda Wells");
      const group = await makeGroup(mark, [wanda, priya]);
      const earlier = (await say(wanda, group.id, "Before leaving")).message;
      const lost = await roomsLostOnLeaving(mark.workspaceId, wanda.userId);
      assert.deepEqual(lost.map((item) => item.conversationId), [group.id]);
      assert.deepEqual(lost[0].memberIds.sort(), [mark.userId, priya.userId].sort());
      await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, wanda.userId]);
      assert.deepEqual(await memberIds(group.id), [mark.userId, priya.userId].sort());
      await refused(listMessages(wanda, group.id), /Conversation not found/);
      assert.ok(!(await listConversations(wanda)).conversations.some((conversation) => conversation.id === group.id));
      const history = await listMessages(priya, group.id);
      assert.equal(history.messages.find((item) => item.id === earlier.id)?.author.name, "Wanda Wells");
      assert.equal((await sidebarEntry(priya, group.id))?.name, "Mark Ridgeon");
      await say(priya, group.id, "Still here");
      assert.equal((await listMessages(mark, group.id)).messages.length, 2);
      assert.equal((await openGroup(mark, [wanda.userId, priya.userId])).id, group.id);
      assert.deepEqual(await memberIds(group.id), [mark.userId, priya.userId].sort());
      await refused(openGroup(wanda, [mark.userId, priya.userId]), /share a workspace with you/);
      await refused(listMessages(wanda, group.id), /Conversation not found/);
    });

    it("starts a new conversation when the remaining set is opened, and keeps people who still share another workspace", async () => {
      const gus = await member("gus@group.test", "Gus Grant");
      const group = await makeGroup(mark, [gus, priya, ada]);
      await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, gus.userId]);
      const rest = await makeGroup(mark, [priya, ada]);
      assert.equal(rest.kind, "group_dm");
      assert.notEqual(rest.id, group.id);
      assert.equal((await openGroup(priya, [mark.userId, ada.userId])).id, rest.id);
      assert.deepEqual((await sql("select 1 from crm.chat_conversations where id = $1", [group.id])).length, 1);

      const hannah = await member("hannah@group.test", "Hannah Hart");
      const ned = await member("ned@group.test", "Ned Nye");
      for (const person of [hannah, ned]) await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [quin.workspaceId, person.userId]);
      const shared = await makeGroup(mark, [hannah, ned]);
      await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, hannah.userId]);
      assert.deepEqual(await memberIds(shared.id), [mark.userId, ned.userId, hannah.userId].sort());
      await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [quin.workspaceId, hannah.userId]);
      assert.deepEqual(await memberIds(shared.id), [mark.userId, ned.userId].sort());
    });

    it("refuses new messages once everyone else has gone", async () => {
      const ivy = await member("ivy@group.test", "Ivy Ives");
      const jon = await member("jon@group.test", "Jon Jay");
      const group = await makeGroup(mark, [ivy, jon]);
      await sql("delete from crm.chat_members where conversation_id = $1 and user_id <> $2", [group.id, mark.userId]);
      assert.equal((await getConversation(mark, group.id)).name, "Former teammate");
      await refused(say(mark, group.id, "Hello?"), /Everyone else has left this group/);
      assert.equal((await listMessages(mark, group.id)).messages.length, 0);
    });
  });

  describe("agents", () => {
    let group: ChatConversation;
    let first: { id: string };

    before(async () => {
      group = await makeGroup(mark, [sam, priya, crowd[5]]);
      first = (await say(sam, group.id, "Narwhal budget for the offsite")).message;
    });

    it("list, read, search, post and react in a group message like in a direct message", async () => {
      const listed = await mcp<{ conversations: { id: string; kind: string; name: string; person: unknown; people?: { name: string }[] }[] }>(mark, "chat_list");
      const entry = listed.value?.conversations.find((item) => item.id === group.id);
      assert.equal(entry?.kind, "group_dm");
      assert.equal(entry?.name, "Crowd F, Priya Nair and Sam Okafor");
      assert.equal(entry?.person, null);
      assert.deepEqual(entry?.people?.map((person) => person.name), ["Crowd F", "Priya Nair", "Sam Okafor"]);

      const read = await mcp<{ conversation: { kind: string }; messages: { id: string; text: string }[] }>(mark, "chat_read", { conversation_id: group.id });
      assert.equal(read.value?.conversation.kind, "group_dm");
      assert.deepEqual(read.value?.messages.map((item) => item.id), [first.id]);

      const found = await mcp<{ results: { id: string; conversation: { kind: string; name: string } }[] }>(mark, "chat_search", { query: "narwhal" });
      assert.deepEqual(found.value?.results.map((hit) => [hit.id, hit.conversation.kind, hit.conversation.name]), [[first.id, "group_dm", "Crowd F, Priya Nair and Sam Okafor"]]);
      const scoped = await mcp<{ results: { id: string }[] }>(priya, "chat_search", { query: "narwhal", conversation_id: group.id });
      assert.deepEqual(scoped.value?.results.map((hit) => hit.id), [first.id]);

      const posted = await mcp<{ posted: boolean; conversationId: string }>(mark, "chat_post", { conversation_id: group.id, text: "Agreed", idempotency_key: "agent-group-1" });
      assert.equal(posted.value?.conversationId, group.id);
      const reacted = await mcp<{ changed: boolean }>(mark, "chat_react", { message_id: first.id, emoji: "👍" });
      assert.equal(reacted.value?.changed, true);
      assert.deepEqual((await titles(sam.userId)).filter((title) => title === "Mark sent your group a message").length >= 1, true);

      const viaTool = (await runTool(priya, "team_chat", { action: "read" })) as { conversations: { id: string; kind: string }[] };
      assert.ok(viaTool.conversations.some((item) => item.id === group.id && item.kind === "group_dm"));
      const toolRead = (await runTool(priya, "team_chat", { action: "read", conversationId: group.id })) as { messages: { id: string }[] };
      assert.ok(toolRead.messages.some((item) => item.id === first.id));
      const toolSearch = (await runTool(priya, "team_chat", { action: "search", query: "narwhal" })) as { results: { id: string }[] };
      assert.deepEqual(toolSearch.results.map((hit) => hit.id), [first.id]);
      const toolPost = await postChat(priya, { conversationId: group.id, text: "From the assistant", key: "agent-group-2" });
      assert.equal(toolPost.conversationId, group.id);
    });

    it("refuse a group message the person isn't in, and never start one", async () => {
      for (const outsider of [ada, olly]) {
        const read = await mcp(outsider, "chat_read", { conversation_id: group.id });
        assert.match(read.error ?? "", /^not_found: /);
        const post = await mcp(outsider, "chat_post", { conversation_id: group.id, text: "Hi" });
        assert.match(post.error ?? "", /^not_found: /);
        const react = await mcp(outsider, "chat_react", { message_id: first.id, emoji: "👍" });
        assert.match(react.error ?? "", /^not_found: /);
        const search = await mcp<{ results: unknown[] }>(outsider, "chat_search", { query: "narwhal" });
        assert.deepEqual(search.value?.results, []);
        const scoped = await mcp(outsider, "chat_search", { query: "narwhal", conversation_id: group.id });
        assert.match(scoped.error ?? "", /^not_found: /);
        const listed = await mcp<{ conversations: { id: string }[] }>(outsider, "chat_list");
        assert.ok(!listed.value?.conversations.some((item) => item.id === group.id));
        const tool = (await runTool(outsider, "team_chat", { action: "read", conversationId: group.id })) as { error?: string };
        assert.match(tool.error ?? "", /not found/i);
      }
      const byPerson = (await runTool(sam, "team_chat", { action: "read", person: priya.userId })) as { conversation: unknown; messages: unknown[]; note?: string };
      assert.equal(byPerson.conversation, null);
      assert.deepEqual(byPerson.messages, []);
    });
  });
});
