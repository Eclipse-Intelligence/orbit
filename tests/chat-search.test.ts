import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { isWriteCall, runTool } from "@/lib/assistant/tools";
import type { ChatSearchHit } from "@/lib/chat/types";
import {
  chatWorkSettled,
  createRoom,
  deleteMessage,
  editMessage,
  openDiscussion,
  openDm,
  postMessage,
  removeRoomMember,
  setRoomArchived,
  updateRoom,
} from "@/lib/crm/chat";
import { searchChat } from "@/lib/crm/chat-search";
import { createCompany } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask } from "@/lib/crm/tasks";
import type { Actor, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createDoc } from "@/lib/docs/store";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase, useServerlessPool } from "./helpers";

type Answer = { content: { type: string; text: string }[]; isError?: boolean };

type AgentHit = { id: string; threadId: string | null; conversation: { id: string; kind: string; name: string }; author: { id: string | null; name: string }; text: string; attachments?: { name: string }[]; at: string };

const TOKEN = "heliotrope";
const PROVENANCE = { operation: "chat_search_test", source: "test" };

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let ada: UserActor;
let olly: UserActor;
let rooms: { sales: string; ops: string; outside: string; markSam: string; samPriya: string };
let discussions: { task: string; doc: string; mail: string };
let taskId: string;
let counter = 0;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function say(actor: UserActor, conversationId: string, body: string, parentId: string | null = null) {
  counter += 1;
  return (await postMessage(actor, { conversationId, body, parentId, clientKey: `search-${counter}` })).message;
}

async function stamp(messageId: string, at: string) {
  await sql("update crm.chat_messages set created_at = $2 where id = $1", [messageId, at]);
}

async function attach(messageId: string, conversationId: string, authorId: string, names: string[]) {
  const ids: string[] = [];
  for (const name of names) {
    const rows = await sql<{ id: string }>(
      "insert into crm.chat_attachments (conversation_id, message_id, uploaded_by, name, content_type, size) values ($1, $2, $3, $4, 'application/pdf', 1000) returning id",
      [conversationId, messageId, authorId, name],
    );
    ids.push(rows[0].id);
  }
  await sql("update crm.chat_messages set attachment_ids = $2::uuid[], attachment_count = $3 where id = $1", [messageId, ids, ids.length]);
  return ids;
}

async function find(actor: UserActor, text: string, extra: Record<string, unknown> = {}) {
  return searchChat(actor, { text, ...extra });
}

async function hitIds(actor: UserActor, text: string, extra: Record<string, unknown> = {}) {
  return (await find(actor, text, extra)).hits.map((hit) => hit.id);
}

function conversationsOf(hits: ChatSearchHit[]) {
  return [...new Set(hits.map((hit) => hit.conversationId))].sort();
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

async function connect(actor: Actor) {
  const server = createCrmMcpServer(actor, actor.type === "user" ? { personal: { tokenId: "00000000-0000-4000-8000-0000000000aa", canSend: false } } : {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "chat-search-test", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Answer,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function mcp(actor: Actor, args: Record<string, unknown>) {
  const session = await connect(actor);
  try {
    return await session.call("chat_search", args);
  } finally {
    await session.close();
  }
}

async function mcpOk<T>(actor: Actor, args: Record<string, unknown>) {
  const answer = await mcp(actor, args);
  assert.ok(!answer.isError, answer.content[0].text);
  return JSON.parse(answer.content[0].text) as T;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@search.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@search.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@search.test", "Priya Nair"), "member");
  ada = await join(await createUser("ada@search.test", "Ada Admin"), "admin");
  olly = await createUser("olly@elsewhere.test", "Olly Outside");
  const company = (await createCompany(mark, { name: "Halden Group", domain: "halden.test" })).body.company.id;

  const sales = await createRoom(mark, { name: "sales", memberIds: [sam.userId] });
  const ops = await createRoom(sam, { name: "ops", memberIds: [priya.userId] });
  const outside = await createRoom(olly, { name: "outside", memberIds: [] });
  const markSam = await openDm(mark, sam.userId);
  const samPriya = await openDm(sam, priya.userId);
  rooms = { sales: sales.id, ops: ops.id, outside: outside.id, markSam: markSam.id, samPriya: samPriya.id };

  const task = (await createTask(mark, { title: "Chase Halden", companyId: company, ownerId: sam.userId })).body.task;
  taskId = task.id;
  const doc = await createDoc(mark, { title: "Halden kick-off", content: "Agenda", shared: true }, PROVENANCE);
  const account = (await sql<{ id: string }>("insert into crm.calendar_accounts (workspace_id, user_id, email, status) values ($1, $2, 'mark@search.test', 'disconnected') returning id", [mark.workspaceId, mark.userId]))[0].id;
  const source = (await sql<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, account_id, email) values ($1, $2, $3, 'mark@search.test') returning id", [mark.workspaceId, mark.userId, account]))[0].id;
  const folder = (
    await sql<{ id: string }>(
      "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role, sync_state) values ($1, $2, $3, 'f-inbox', 'inbox', 'inbox', 'skipped') returning id",
      [mark.workspaceId, mark.userId, source],
    )
  )[0].id;
  await sql(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, snippet, body_text, from_email, from_name, to_recipients, bcc_recipients, sent_at, is_draft, web_link)
     values ($1, $2, $3, $4, 'm-1', 'conv-search', 'Revised pricing for Halden', 'x', 'x', 'tom@halden.test', 'Tom Becker', '[]'::jsonb, '[]'::jsonb, '2026-10-04T09:00:00Z', false, 'https://outlook.office.com/x')`,
    [mark.workspaceId, mark.userId, source, folder],
  );
  const share = (await sql<{ id: string }>("insert into crm.mail_shares (owner_user_id, source_id, thread_key) values ($1, $2, 'conv-search') returning id", [mark.userId, source]))[0].id;
  await sql("insert into crm.mail_share_members (share_id, user_id, added_by) values ($1, $2, $3)", [share, sam.userId, mark.userId]);
  discussions = {
    task: (await openDiscussion(mark, { kind: "task", id: task.id })).conversationId,
    doc: (await openDiscussion(mark, { kind: "doc", id: doc.id })).conversationId,
    mail: (await openDiscussion(mark, { kind: "mail_thread", id: share })).conversationId,
  };

  await say(mark, rooms.sales, `${TOKEN} in sales`);
  await say(sam, rooms.ops, `${TOKEN} in ops, mark and ada are not here`);
  await say(olly, rooms.outside, `${TOKEN} outside`);
  await say(mark, rooms.markSam, `${TOKEN} between mark and sam`);
  await say(sam, rooms.samPriya, `${TOKEN} between sam and priya`);
  await say(mark, discussions.task, `${TOKEN} on the task`);
  await say(mark, discussions.doc, `${TOKEN} on the doc`);
  await say(mark, discussions.mail, `${TOKEN} on the shared email`);
});

beforeEach(() => {
  setLiveTesting({ batch: async () => undefined });
});

afterEach(async () => {
  await chatWorkSettled();
  setLiveTesting(null);
});

after(async () => {
  await getPool().end();
});

describe("who can find what", () => {
  useServerlessPool();

  const expectations: [string, () => UserActor, () => string[]][] = [
    ["the owner of the workspace, who is in the sales room and one DM", () => mark, () => [rooms.sales, rooms.markSam, discussions.task, discussions.doc, discussions.mail]],
    ["a member of two rooms and two DMs, on the task and the shared email", () => sam, () => [rooms.sales, rooms.ops, rooms.markSam, rooms.samPriya, discussions.task, discussions.doc, discussions.mail]],
    ["a member who isn't on the task or the shared email", () => priya, () => [rooms.ops, rooms.samPriya, discussions.doc]],
    ["an admin who is in no room, DM or task", () => ada, () => [discussions.doc]],
    ["someone in another workspace", () => olly, () => [rooms.outside]],
  ];

  for (const [label, who, expected] of expectations) {
    it(`gives ${label} exactly what they can open`, async () => {
      const found = await find(who(), TOKEN);
      assert.deepEqual(conversationsOf(found.hits), [...expected()].sort());
      assert.equal(found.hits.length, expected().length);
      assert.equal(found.next, null);
    });
  }

  it("never leaks a snippet, a name or a count from a conversation someone can't open", async () => {
    const secrets = ["in ops", "mark and ada are not here", "between sam and priya", "between mark and sam", "on the task", "on the shared email", "in sales", "Revised pricing", "Chase Halden", "outside"];
    const adaSees = JSON.stringify(await find(ada, TOKEN));
    for (const secret of secrets) assert.ok(!adaSees.includes(secret), secret);
    assert.ok(adaSees.includes("on the doc"));
    const ollySees = JSON.stringify(await find(olly, TOKEN));
    for (const secret of secrets.filter((item) => item !== "outside")) assert.ok(!ollySees.includes(secret), secret);
    assert.ok(!ollySees.includes("Halden kick-off") && !ollySees.includes("on the doc"));
    const priyaSees = JSON.stringify(await find(priya, TOKEN));
    for (const secret of ["in sales", "between mark and sam", "on the task", "on the shared email", "Chase Halden", "Revised pricing"]) assert.ok(!priyaSees.includes(secret), secret);
  });

  it("treats a conversation someone isn't in the same as one that doesn't exist", async () => {
    const stranger = "11111111-1111-4111-8111-111111111111";
    const filtered = await find(mark, TOKEN, { in: rooms.ops });
    assert.deepEqual(filtered, await find(mark, TOKEN, { in: stranger }));
    assert.deepEqual(filtered, { hits: [], next: null });
    assert.deepEqual(await find(ada, TOKEN, { in: discussions.task }), { hits: [], next: null });
    assert.deepEqual(await find(priya, TOKEN, { in: discussions.mail }), { hits: [], next: null });
    assert.deepEqual(await find(olly, TOKEN, { in: rooms.sales }), { hits: [], next: null });
  });

  it("keeps file names to the people who can see the message", async () => {
    const ops = await say(sam, rooms.ops, "The numbers are attached");
    await attach(ops.id, rooms.ops, sam.userId, ["quokka-forecast.pdf"]);
    const task = await say(mark, discussions.task, "Contract attached");
    await attach(task.id, discussions.task, mark.userId, ["quokka-contract.pdf"]);
    assert.deepEqual(await hitIds(priya, "quokka"), [ops.id]);
    assert.deepEqual((await find(priya, "quokka")).hits[0].files.map((file) => file.name), ["quokka-forecast.pdf"]);
    assert.deepEqual(await hitIds(sam, "quokka"), [task.id, ops.id]);
    assert.deepEqual(await hitIds(mark, "quokka"), [task.id]);
    assert.deepEqual(await hitIds(ada, "quokka"), []);
    assert.deepEqual(await hitIds(olly, "quokka"), []);
  });

  it("follows who can see a task: tagging grants access and removing it takes it away", async () => {
    const note = await say(mark, discussions.task, "Quarterly zeppelin plan");
    assert.deepEqual(await hitIds(priya, "zeppelin"), []);
    await sql("insert into crm.task_participants (task_id, user_id, added_by) values ($1, $2, $3)", [taskId, priya.userId, mark.userId]);
    assert.deepEqual(await hitIds(priya, "zeppelin"), [note.id]);
    await sql("delete from crm.task_participants where task_id = $1 and user_id = $2", [taskId, priya.userId]);
    assert.deepEqual(await hitIds(priya, "zeppelin"), []);
    assert.deepEqual(await hitIds(ada, "zeppelin"), []);
  });

  it("never shows another workspace's task or doc discussions, to anyone in this one", async () => {
    const task = (await createTask(olly, { title: "Outside chase", ownerId: olly.userId })).body.task;
    const doc = await createDoc(olly, { title: "Outside plan", content: "Agenda", shared: true }, PROVENANCE);
    const onTask = await say(olly, (await openDiscussion(olly, { kind: "task", id: task.id })).conversationId, "Wyvern budget on the outside task");
    const onDoc = await say(olly, (await openDiscussion(olly, { kind: "doc", id: doc.id })).conversationId, "Wyvern notes on the outside doc");
    assert.deepEqual((await hitIds(olly, "wyvern")).sort(), [onTask.id, onDoc.id].sort());
    for (const outsider of [mark, sam, priya, ada]) assert.deepEqual(await hitIds(outsider, "wyvern"), []);
  });

  it("stops showing a room's history to someone who was removed from it", async () => {
    const room = await createRoom(mark, { name: "leavers", memberIds: [sam.userId, priya.userId] });
    const kept = await say(sam, room.id, "Notes about the narwhal launch");
    assert.deepEqual(await hitIds(priya, "narwhal"), [kept.id]);
    await removeRoomMember(mark, room.id, priya.userId);
    assert.deepEqual(await hitIds(priya, "narwhal"), []);
    assert.deepEqual(await hitIds(sam, "narwhal"), [kept.id]);
  });

  it("is executable by the app role only", async () => {
    const rows = await sql<{ role: string; allowed: boolean }>(
      `select r.role, has_function_privilege(r.role, 'private.chat_search_all(uuid, text, jsonb, integer, jsonb)', 'execute') as allowed
       from (values ('crm_app'), ('authenticated'), ('anon'), ('crm_agent')) as r(role)`,
    );
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.role, row.allowed])), { crm_app: true, authenticated: false, anon: false, crm_agent: false });
  });
});

describe("what a search matches", () => {
  useServerlessPool();

  it("matches text anywhere in a message, ignoring case, newest first", async () => {
    const room = (await createRoom(mark, { name: "matching", memberIds: [sam.userId] })).id;
    const first = await say(mark, room, "Renewal for Acme is due");
    const second = await say(sam, room, "the RENEWAL date moved");
    const third = await say(mark, room, "Nothing to see");
    await stamp(first.id, "2026-01-01T10:00:00Z");
    await stamp(second.id, "2026-01-02T10:00:00Z");
    await stamp(third.id, "2026-01-03T10:00:00Z");
    const found = await find(mark, "renewal", { in: room });
    assert.deepEqual(found.hits.map((hit) => hit.id), [second.id, first.id]);
    assert.equal(found.hits[0].conversation.name, "matching");
    assert.equal(found.hits[0].conversation.kind, "room");
    assert.deepEqual(found.hits[0].author, { id: sam.userId, name: "Sam Okafor" });
    assert.equal(found.hits[0].excerpt, "the RENEWAL date moved");
    assert.equal(found.hits[0].href, `/chat/${room}?message=${second.id}`);
  });

  it("treats percent signs, underscores and backslashes in the search as plain text", async () => {
    const room = (await createRoom(mark, { name: "wildcards", memberIds: [] })).id;
    const percent = await say(mark, room, "Growth was 100% last year");
    await say(mark, room, "Growth was 1000 last year");
    const underscore = await say(mark, room, "Use snake_case names");
    await say(mark, room, "Use snakeXcase names");
    const slash = await say(mark, room, "Path is C:\\temp\\files");
    assert.deepEqual(await hitIds(mark, "100%"), [percent.id]);
    assert.deepEqual(await hitIds(mark, "snake_case"), [underscore.id]);
    assert.deepEqual(await hitIds(mark, "C:\\temp"), [slash.id]);
  });

  it("finds a message once when its text and its file name both match", async () => {
    const room = (await createRoom(mark, { name: "files", memberIds: [] })).id;
    const both = await say(mark, room, "The aardvark report is attached");
    await attach(both.id, room, mark.userId, ["aardvark-report.pdf", "aardvark-chart.pdf"]);
    const onlyFile = await say(mark, room, "See attached");
    await attach(onlyFile.id, room, mark.userId, ["Aardvark Summary.pdf"]);
    const found = await find(mark, "aardvark", { in: room });
    assert.deepEqual(found.hits.map((hit) => hit.id), [onlyFile.id, both.id]);
    assert.deepEqual(found.hits.find((hit) => hit.id === both.id)?.files.map((file) => file.name), ["aardvark-report.pdf", "aardvark-chart.pdf"]);
    assert.equal(new Set(found.hits.map((hit) => hit.id)).size, found.hits.length);
  });

  it("includes thread replies, opens them through their thread, and skips deleted, edited-away and system lines", async () => {
    const room = (await createRoom(mark, { name: "threads", memberIds: [sam.userId] })).id;
    const root = await say(mark, room, "Kickoff agenda");
    const reply = await say(sam, room, "Please add the platypus review", root.id);
    const gone = await say(sam, room, "Delete this platypus note");
    await deleteMessage(sam, gone.id);
    const edited = await say(sam, room, "An obsolete platypus draft");
    await editMessage(sam, edited.id, "Now something else");
    await updateRoom(mark, room, { topic: "Platypus planning" });
    const found = await find(mark, "platypus", { in: room });
    assert.deepEqual(found.hits.map((hit) => hit.id), [reply.id]);
    assert.equal(found.hits[0].parentId, root.id);
    assert.equal(found.hits[0].href, `/chat/${room}?thread=${root.id}`);
  });

  it("opens task, doc and shared email hits through the thing they are about", async () => {
    const hits = (await find(sam, TOKEN)).hits;
    const bySubject = Object.fromEntries(hits.filter((hit) => hit.subject).map((hit) => [hit.subject!.kind, hit]));
    assert.equal(bySubject.task.subject?.title, "Chase Halden");
    assert.equal(bySubject.task.href, `/tasks?task=${taskId}`);
    assert.equal(bySubject.doc.subject?.title, "Halden kick-off");
    assert.match(bySubject.doc.href, /^\/docs\/.+\?discussion=1$/);
    assert.equal(bySubject.mail_thread.subject?.title, "Revised pricing for Halden");
    assert.match(bySubject.mail_thread.href, /^\/mail\?shared=.+&discussion=1$/);
  });

  it("names a direct message after the other person and keeps the author name", async () => {
    const found = (await find(sam, "between mark and sam")).hits[0];
    assert.equal(found.conversation.kind, "dm");
    assert.equal(found.conversation.name, "Mark Ridgeon");
    const mine = (await find(mark, "between mark and sam")).hits[0];
    assert.equal(mine.conversation.name, "Sam Okafor");
    assert.equal(mine.author.name, "Mark Ridgeon");
  });

  it("finds archived rooms on the web and marks them", async () => {
    const room = (await createRoom(mark, { name: "old-news", memberIds: [sam.userId] })).id;
    const kept = await say(mark, room, "Pangolin retrospective");
    await setRoomArchived(mark, room, true);
    const found = await find(sam, "pangolin");
    assert.deepEqual(found.hits.map((hit) => hit.id), [kept.id]);
    assert.equal(found.hits[0].conversation.archived, true);
  });

  it("returns the whole message to agents and a short excerpt to the web", async () => {
    const room = (await createRoom(mark, { name: "long", memberIds: [] })).id;
    const long = `${"filler words ".repeat(40)}capybara${" more filler".repeat(40)}`;
    const posted = await say(mark, room, long);
    const web = (await find(mark, "capybara", { in: room })).hits[0];
    assert.equal(web.id, posted.id);
    assert.equal(web.text, undefined);
    assert.ok(web.excerpt.length <= 210 && web.excerpt.includes("capybara") && web.excerpt.startsWith("…") && web.excerpt.endsWith("…"));
    const agent = (await searchChat(mark, { text: "capybara", in: room }, { agent: true })).hits[0];
    assert.equal(agent.text, long);
  });
});

describe("the minimum length and bad input", () => {
  useServerlessPool();

  it("needs three characters, counting what people see rather than code units", async () => {
    for (const short of ["", "  ", "ab", " a  ", "🙂🙂", "é "]) await refused(find(mark, short), /Type at least 3 characters to search\./);
    await refused(searchChat(mark, { text: undefined }), /Type at least 3 characters/);
    await refused(searchChat(mark, { text: 42 }), /Type at least 3 characters/);
    assert.ok((await find(mark, "abc")).hits.length >= 0);
    assert.ok((await find(mark, "🙂🙂🙂")).hits.length >= 0);
    assert.ok((await find(mark, "a b")).hits.length >= 0);
  });

  it("refuses ids, flags, dates and cursors it can't read", async () => {
    await refused(find(mark, TOKEN, { in: "nope" }), /Pick a conversation from the list/);
    await refused(find(mark, TOKEN, { from: "nope" }), /Pick a person from the list/);
    await refused(find(mark, TOKEN, { hasFile: "maybe" }), /Use true or false/);
    await refused(find(mark, TOKEN, { after: "yesterday" }), /after:/);
    await refused(find(mark, TOKEN, { before: 5 }), /before is a date/);
    await refused(find(mark, TOKEN, { cursor: "garbage" }), /That page of results has expired/);
    await refused(find(mark, TOKEN, { limit: "lots" }), /Use a number for limit/);
  });

  it("keeps the page size between 1 and 50", async () => {
    const room = (await createRoom(mark, { name: "sizes", memberIds: [] })).id;
    for (let index = 0; index < 55; index += 1) await say(mark, room, `Wombat entry ${index}`);
    assert.equal((await find(mark, "wombat", { in: room, limit: 500 })).hits.length, 50);
    assert.equal((await find(mark, "wombat", { in: room, limit: 0 })).hits.length, 1);
    assert.equal((await find(mark, "wombat", { in: room })).hits.length, 30);
  });
});

describe("filters", () => {
  useServerlessPool();

  let room: string;
  let early: string;
  let middle: string;
  let late: string;

  before(async () => {
    room = (await createRoom(mark, { name: "filters", memberIds: [sam.userId] })).id;
    early = (await say(mark, room, "Ocelot plan one")).id;
    middle = (await say(sam, room, "Ocelot plan two")).id;
    late = (await say(mark, room, "Ocelot plan three")).id;
    await stamp(early, "2026-03-09T23:30:00Z");
    await stamp(middle, "2026-03-10T12:00:00Z");
    await stamp(late, "2026-03-11T00:30:00Z");
    await attach(middle, room, sam.userId, ["ocelot.pdf"]);
  });

  it("narrows to a conversation", async () => {
    const other = await say(mark, rooms.sales, "Ocelot in sales");
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room }), [late, middle, early]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: rooms.sales }), [other.id]);
    assert.equal((await hitIds(mark, "ocelot")).length, 4);
  });

  it("narrows to an author", async () => {
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, from: sam.userId }), [middle]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, from: mark.userId }), [late, early]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, from: priya.userId }), []);
  });

  it("narrows to messages with files, counting a file that only the name matches", async () => {
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, hasFile: true }), [middle]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, hasFile: "1" }), [middle]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, hasFile: "0" }), [late, middle, early]);
  });

  it("treats a date as the whole day, and a time as that moment", async () => {
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, before: "2026-03-10" }), [early]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, after: "2026-03-10" }), [late]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, after: "2026-03-09", before: "2026-03-11" }), [middle]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, after: "2026-03-10T12:00:00Z" }), [late]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, before: "2026-03-10T12:00:00Z" }), [early]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, after: "2026-03-11", before: "2026-03-10" }), []);
  });

  it("combines every filter", async () => {
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, from: sam.userId, hasFile: true, after: "2026-03-09", before: "2026-03-11" }), [middle]);
    assert.deepEqual(await hitIds(mark, "ocelot", { in: room, from: mark.userId, hasFile: true }), []);
  });
});

describe("paging", () => {
  useServerlessPool();

  it("pages newest first with a cursor, with no gaps or repeats, even when times tie", async () => {
    const room = (await createRoom(mark, { name: "paging", memberIds: [] })).id;
    const made: string[] = [];
    for (let index = 0; index < 11; index += 1) made.push((await say(mark, room, `Lemur message ${index}`)).id);
    for (const [index, id] of made.entries()) await stamp(id, index < 6 ? "2026-04-01T09:00:00.123456Z" : `2026-04-0${index - 4}T09:00:00Z`);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { hits: ChatSearchHit[]; next: string | null } = await find(mark, "lemur", { in: room, limit: 4, cursor });
      seen.push(...page.hits.map((hit) => hit.id));
      cursor = page.next;
      pages += 1;
      assert.ok(pages <= 5);
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(seen.length, 11);
    assert.equal(new Set(seen).size, 11);
    const times = await sql<{ id: string; created_at: Date; text: string }>("select id, created_at, id::text as text from crm.chat_messages where conversation_id = $1", [room]);
    const expected = [...times].sort((left, right) => right.created_at.getTime() - left.created_at.getTime() || (right.id < left.id ? -1 : 1)).map((row) => row.id);
    assert.deepEqual(seen, expected);
  });

  it("gives the same answer when nothing changes and an empty last page ends cleanly", async () => {
    const room = (await createRoom(mark, { name: "paging-two", memberIds: [] })).id;
    for (let index = 0; index < 4; index += 1) await say(mark, room, `Gecko ${index}`);
    const first = await find(mark, "gecko", { in: room, limit: 4 });
    assert.equal(first.hits.length, 4);
    assert.equal(first.next, null);
    const exact = await find(mark, "gecko", { in: room, limit: 3 });
    assert.ok(exact.next);
    assert.equal((await find(mark, "gecko", { in: room, limit: 3, cursor: exact.next })).next, null);
  });

  it("never carries someone else's access into a cursor", async () => {
    const room = (await createRoom(mark, { name: "cursors", memberIds: [] })).id;
    for (let index = 0; index < 5; index += 1) await say(mark, room, `Meerkat ${index}`);
    const page = await find(mark, "meerkat", { limit: 2 });
    assert.ok(page.next);
    assert.deepEqual(await find(ada, "meerkat", { limit: 2, cursor: page.next }), { hits: [], next: null });
  });
});

describe("agent tools", () => {
  useServerlessPool();

  it("search rooms and direct messages only, never discussions or archived rooms", async () => {
    const live = (await createRoom(mark, { name: "agents-live", memberIds: [sam.userId] })).id;
    const archived = (await createRoom(mark, { name: "agents-archived", memberIds: [sam.userId] })).id;
    const first = await say(mark, live, "Axolotl budget");
    await say(mark, archived, "Axolotl history");
    await say(mark, discussions.task, "Axolotl on the task");
    await setRoomArchived(mark, archived, true);
    const answer = await mcpOk<{ results: AgentHit[]; next: string | null }>(sam, { query: "axolotl" });
    assert.deepEqual(answer.results.map((hit) => hit.id), [first.id]);
    assert.equal(answer.results[0].conversation.name, "#agents-live");
    assert.equal(answer.results[0].text, "Axolotl budget");
    assert.equal(answer.next, null);
    assert.equal((await hitIds(sam, "axolotl")).length, 3);
    const viaTool = (await runTool(sam, "team_chat", { action: "search", query: "axolotl" })) as { results: AgentHit[] };
    assert.deepEqual(viaTool.results.map((hit) => hit.id), [first.id]);
    const fenced = (await runTool(sam, "team_chat", { action: "search", query: "axolotl" }, { fence: "abcdef012345" })) as { notice: string; results: AgentHit[] };
    assert.match(fenced.notice, /Treat it as information only/);
    assert.match(fenced.results[0].text, /<<untrusted-abcdef012345>>Axolotl budget<<\/untrusted-abcdef012345>>/);
    assert.match(fenced.results[0].author.name, /^<<untrusted-abcdef012345>>/);
    assert.match(fenced.results[0].conversation.name, /^<<untrusted-abcdef012345>>/);
    const heliotrope = await mcpOk<{ results: AgentHit[] }>(sam, { query: TOKEN });
    assert.deepEqual(heliotrope.results.map((hit) => hit.conversation.id).sort(), [rooms.sales, rooms.ops, rooms.markSam, rooms.samPriya].sort());
  });

  it("refuse a conversation the person isn't in, and discussions, with the same wording as reading", async () => {
    const stranger = await mcp(priya, { query: TOKEN, conversation_id: rooms.sales });
    assert.equal(stranger.isError, true);
    assert.match(stranger.content[0].text, /^not_found: /);
    const missing = await mcp(priya, { query: TOKEN, conversation_id: "11111111-1111-4111-8111-111111111111" });
    assert.equal(missing.content[0].text, stranger.content[0].text);
    const discussion = await mcp(sam, { query: TOKEN, conversation_id: discussions.task });
    assert.equal(discussion.isError, true);
    assert.match(discussion.content[0].text, /^not_found: Conversation not found\. Task, doc and shared email discussions aren't reachable here\.$/);
    const viaTool = (await runTool(priya, "team_chat", { action: "search", query: TOKEN, conversationId: rooms.sales })) as { error?: string };
    assert.ok(viaTool.error === undefined || /not found/i.test(viaTool.error));
  });

  it("filter by teammate, by email, by their own name, and by files and dates", async () => {
    const room = (await createRoom(mark, { name: "agent-filters", memberIds: [sam.userId] })).id;
    const fromSam = await say(sam, room, "Ibis pitch");
    const fromMark = await say(mark, room, "Ibis reply");
    await attach(fromSam.id, room, sam.userId, ["ibis.pdf"]);
    await stamp(fromSam.id, "2026-05-01T09:00:00Z");
    await stamp(fromMark.id, "2026-05-03T09:00:00Z");
    const ids = (answer: { results: AgentHit[] }) => answer.results.map((hit) => hit.id);
    assert.deepEqual(ids(await mcpOk(mark, { query: "ibis", from: sam.userId })), [fromSam.id]);
    assert.deepEqual(ids(await mcpOk(mark, { query: "ibis", from: "SAM@search.test" })), [fromSam.id]);
    assert.deepEqual(ids(await mcpOk(mark, { query: "ibis", from: "mark@search.test" })), [fromMark.id]);
    assert.deepEqual(ids(await mcpOk(mark, { query: "ibis", has_file: true })), [fromSam.id]);
    assert.deepEqual(ids(await mcpOk(mark, { query: "ibis", sent_after: "2026-05-01", sent_before: "2026-05-03" })), []);
    assert.deepEqual(ids(await mcpOk(mark, { query: "ibis", sent_after: "2026-04-30", sent_before: "2026-05-02" })), [fromSam.id]);
    const withFile = (await mcpOk<{ results: AgentHit[] }>(mark, { query: "ibis", has_file: true })).results[0];
    assert.deepEqual(withFile.attachments, [{ name: "ibis.pdf" }]);
    const unknown = await mcp(mark, { query: "ibis", from: "nobody@search.test" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /^not_found: Couldn't find that teammate\./);
  });

  it("page with the cursor and keep the three character minimum", async () => {
    const room = (await createRoom(mark, { name: "agent-paging", memberIds: [] })).id;
    for (let index = 0; index < 5; index += 1) await say(mark, room, `Tapir ${index}`);
    const first = await mcpOk<{ results: AgentHit[]; next: string | null }>(mark, { query: "tapir", limit: 2 });
    assert.equal(first.results.length, 2);
    assert.ok(first.next);
    const second = await mcpOk<{ results: AgentHit[]; next: string | null }>(mark, { query: "tapir", limit: 2, cursor: first.next });
    assert.equal(second.results.length, 2);
    assert.ok(!second.results.some((hit) => first.results.some((other) => other.id === hit.id)));
    const short = await mcp(mark, { query: "ta" });
    assert.equal(short.isError, true);
    assert.match(short.content[0].text, /^invalid_input: Type at least 3 characters to search\./);
    assert.deepEqual(await runTool(mark, "team_chat", { action: "search", query: "ta" }), { error: "Type at least 3 characters to search.", field: "q" });
  });

  it("lets the assistant search without approval, and refuses unknown actions", async () => {
    assert.equal(isWriteCall("team_chat", { action: "search", query: TOKEN }), false);
    assert.equal(isWriteCall("team_chat", { action: "post", conversationId: rooms.sales, text: "Hi" }), true);
    assert.deepEqual(await runTool(mark, "team_chat", { action: "delete" }), { error: "action must be read, search or post.", field: "action" });
  });
});

describe("who gets the tool", () => {
  it("lists chat_search for personal tokens and never for agent tokens", async () => {
    const names = async (actor: Actor) => {
      const server = createCrmMcpServer(actor, actor.type === "user" ? { personal: { tokenId: "00000000-0000-4000-8000-0000000000aa", canSend: false } } : {});
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: "listing", version: "1.0.0" });
      await client.connect(clientSide);
      try {
        return (await client.listTools()).tools.map((tool) => tool.name);
      } finally {
        await client.close();
        await server.close();
      }
    };
    assert.ok((await names(mark)).includes("chat_search"));
    const agent = await createAgent(mark.workspaceId, ["crm:read", "admin"]);
    assert.ok(!(await names(agent.actor)).some((name) => name.startsWith("chat_")));
  });
});
