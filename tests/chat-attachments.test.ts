import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { readChat } from "@/lib/chat/tools";
import type { ChatLiveEvent } from "@/lib/chat/types";
import { chatWorkSettled, createRoom, deleteMessage, editMessage, getDiscussion, leaveRoom, listMessages, openDiscussion, openDm, postMessage } from "@/lib/crm/chat";
import { chatFileLink, discardChatUploads, prepareChatUpload, sweepChatAttachments } from "@/lib/crm/chat-attachments";
import { createCompany } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { resetStorageBucketCache } from "@/lib/storage";
import { createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const SUPABASE = "https://project.supabase.test";
const BUCKET = "email-attachments";
const MIGRATION = "supabase/migrations/20270224100000_chat_attachments.sql";

type Stored = { bytes: number | null; type: string };

function storage() {
  const objects = new Map<string, Stored>();
  const removed: string[] = [];
  const calls: { method: string; url: string }[] = [];
  let failRemovals = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url === `${SUPABASE}/storage/v1/bucket`) return Response.json({ name: BUCKET });
    const uploadSign = url.match(/\/storage\/v1\/object\/upload\/sign\/email-attachments\/(.+)$/);
    if (uploadSign) return Response.json({ url: `/object/upload/sign/${BUCKET}/${uploadSign[1]}?token=up` });
    const sign = url.match(/\/storage\/v1\/object\/sign\/email-attachments\/(.+)$/);
    if (sign && method === "POST") return Response.json({ signedURL: `/object/sign/${BUCKET}/${sign[1]}?token=down` });
    const object = url.match(/\/storage\/v1\/object\/email-attachments\/(.+)$/);
    if (object && method === "HEAD") {
      const stored = objects.get(object[1]);
      if (!stored) return new Response(null, { status: 400 });
      return new Response(null, { status: 200, headers: { "content-type": stored.type, ...(stored.bytes === null ? {} : { "content-length": String(stored.bytes) }) } });
    }
    if (url === `${SUPABASE}/storage/v1/object/${BUCKET}` && method === "DELETE") {
      if (failRemovals) return Response.json({ message: "down" }, { status: 500 });
      for (const path of (JSON.parse(String(init?.body)) as { prefixes: string[] }).prefixes) {
        removed.push(path);
        objects.delete(path);
      }
      return Response.json([]);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return {
    fetchImpl,
    objects,
    removed,
    calls,
    failRemovals(value: boolean) {
      failRemovals = value;
    },
  };
}

let env: ReturnType<typeof storage>;
let broadcasts: LiveMessage[];

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

async function deniedInDb(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof Error && pattern.test(error.message));
}

async function tombstones() {
  return (await sql<{ path: string }>("select path from private.storage_tombstones order by path")).map((row) => row.path);
}

function key(conversationId: string, id: string) {
  return `team-chat/${conversationId}/${id}`;
}

async function upload(actor: UserActor, conversationId: string, files: { name: string; type: string; size?: number }[], options: { store?: boolean } = {}) {
  const prepared = await prepareChatUpload(
    actor,
    conversationId,
    files.map((file) => ({ name: file.name, size: file.size ?? 2048, contentType: file.type, width: file.type.startsWith("image/") ? 1200 : undefined, height: file.type.startsWith("image/") ? 800 : undefined })),
    env.fetchImpl,
  );
  if (options.store !== false) for (const file of prepared) env.objects.set(key(conversationId, file.id), { bytes: file.size, type: file.contentType });
  return prepared.map((file) => file.id);
}

let counter = 0;
function clientKey() {
  counter += 1;
  return `files-${counter}`;
}

async function post(actor: UserActor, conversationId: string, body: string, attachmentIds: string[], parentId: string | null = null) {
  return (await postMessage(actor, { conversationId, parentId, body, format: "markdown", clientKey: clientKey(), attachmentIds }, { fetchImpl: env.fetchImpl })).message;
}

async function join(user: UserActor, workspaceId: string, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [workspaceId, user.userId, role]);
  return { ...user, workspaceId, role, scopes: scopesForRole(role) };
}

describe("chat attachments", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let ada: UserActor;
  let olly: UserActor;
  let companyId: string;

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@files.test", "Mark Ridgeon");
    sam = await join(await createUser("sam@files.test", "Sam Okafor"), mark.workspaceId, "member");
    priya = await join(await createUser("priya@files.test", "Priya Nair"), mark.workspaceId, "member");
    ada = await join(await createUser("ada@files.test", "Ada Admin"), mark.workspaceId, "admin");
    olly = await createUser("olly@elsewhere.test", "Olly Outside");
    companyId = (await createCompany(mark, { name: "Halden Group", domain: "halden.test" })).body.company.id;
  });

  beforeEach(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    resetStorageBucketCache();
    env = storage();
    broadcasts = [];
    setLiveTesting({ batch: async (messages) => void broadcasts.push(...messages) });
    await sql("truncate crm.push_log, crm.notifications");
  });

  afterEach(async () => {
    await chatWorkSettled();
    setLiveTesting(null);
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
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
    const constraint = await sql<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'chat_messages_body_present'");
    assert.match(constraint[0].def, /attachment_count > 0/);
  });

  it("posts files with or without text, in order, and shows them to the room", async () => {
    const room = await createRoom(mark, { name: "files", memberIds: [sam.userId] });
    const ids = await upload(mark, room.id, [
      { name: "Signed order form.pdf", type: "application/pdf" },
      { name: "screen.png", type: "image/png" },
    ]);
    const prepared = await sql<{ path: string }>("select path from private.storage_tombstones");
    assert.deepEqual(prepared, []);
    assert.ok(env.calls.some((call) => call.url.endsWith(`/object/upload/sign/${BUCKET}/${key(room.id, ids[0])}`)));
    const message = await post(mark, room.id, "", ids);
    assert.equal(message.body, "");
    assert.deepEqual(
      message.attachments.map((file) => [file.id, file.name, file.contentType, file.width]),
      [
        [ids[0], "Signed order form.pdf", "application/pdf", null],
        [ids[1], "screen.png", "image/png", 1200],
      ],
    );
    const seen = await listMessages(sam, room.id);
    assert.deepEqual(
      seen.messages.find((item) => item.id === message.id)?.attachments.map((file) => file.id),
      ids,
    );
    const stored = await sql<{ attachment_count: number; message_ids: string[] }>(
      "select m.attachment_count, array(select a.message_id::text from crm.chat_attachments a where a.id = any(m.attachment_ids)) as message_ids from crm.chat_messages m where m.id = $1",
      [message.id],
    );
    assert.deepEqual(stored[0], { attachment_count: 2, message_ids: [message.id, message.id] });
    const withText = await post(mark, room.id, "Here it is", await upload(mark, room.id, [{ name: "notes.txt", type: "text/plain" }]));
    assert.equal(withText.attachments.length, 1);
    await refused(postMessage(mark, { conversationId: room.id, body: "  ", clientKey: clientKey() }), /Write a message first\./);
  });

  it("lists files in MCP and team_chat reads without links", async () => {
    const room = await createRoom(mark, { name: "mcp-files", memberIds: [sam.userId] });
    await post(mark, room.id, "", await upload(mark, room.id, [{ name: "Deck.pdf", type: "application/pdf", size: 4096 }]));
    const read = (await readChat(sam, { conversationId: room.id })) as { messages: { attachments?: unknown }[] };
    assert.deepEqual(read.messages.at(-1)?.attachments, [{ name: "Deck.pdf", type: "application/pdf", size: 4096 }]);
    assert.ok(!JSON.stringify(read).includes("/api/chat/files"));
  });

  it("refuses people outside a room, and people who can't see a task, at every step", async () => {
    const room = await createRoom(mark, { name: "private-files", memberIds: [sam.userId] });
    await refused(prepareChatUpload(priya, room.id, [{ name: "a.pdf", size: 10, contentType: "application/pdf" }], env.fetchImpl), /Conversation not found\./);
    await refused(prepareChatUpload(olly, room.id, [{ name: "a.pdf", size: 10, contentType: "application/pdf" }], env.fetchImpl), /Conversation not found\./);
    const ids = await upload(mark, room.id, [{ name: "plan.pdf", type: "application/pdf" }]);
    await refused(chatFileLink(sam, ids[0], {}, env.fetchImpl), /File not found\./);
    const message = await post(mark, room.id, "Plan", ids);
    assert.match(await chatFileLink(sam, ids[0], {}, env.fetchImpl), /\/object\/sign\/email-attachments\/team-chat\/.+\?token=down$/);
    await refused(chatFileLink(priya, ids[0], {}, env.fetchImpl), /File not found\./);
    await refused(chatFileLink(olly, ids[0], {}, env.fetchImpl), /File not found\./);
    assert.deepEqual(await queryAsUser(priya.userId, "select id from crm.chat_attachments where id = $1", [ids[0]]), []);
    assert.equal((await queryAsUser(sam.userId, "select id from crm.chat_attachments where id = $1", [ids[0]])).length, 1);
    await refused(listMessages(priya, room.id), /not found/);
    await deniedInDb(queryAsUser(mark.userId, "insert into crm.chat_attachments (conversation_id, name, size) values ($1, 'x', 1)", [room.id]), /permission denied/);
    await deniedInDb(queryAsUser(mark.userId, "update crm.chat_messages set attachment_count = 0 where id = $1", [message.id]), /permission denied/);

    const task = (await createTask(mark, { title: "Send Halden the pricing", companyId, ownerId: sam.userId })).body.task;
    const { conversationId } = await openDiscussion(sam, { kind: "task", id: task.id });
    await refused(prepareChatUpload(priya, conversationId, [{ name: "a.pdf", size: 10, contentType: "application/pdf" }], env.fetchImpl), /Conversation not found\./);
    await refused(prepareChatUpload(ada, conversationId, [{ name: "a.pdf", size: 10, contentType: "application/pdf" }], env.fetchImpl), /Conversation not found\./);
    const taskIds = await upload(sam, conversationId, [{ name: "Proposal v2.pdf", type: "application/pdf" }]);
    await post(sam, conversationId, "Draft attached", taskIds);
    const discussion = await getDiscussion(mark, { kind: "task", id: task.id });
    assert.equal(discussion.page?.messages.at(-1)?.attachments[0]?.name, "Proposal v2.pdf");
    await refused(chatFileLink(ada, taskIds[0], {}, env.fetchImpl), /File not found\./);
    await refused(chatFileLink(priya, taskIds[0], {}, env.fetchImpl), /File not found\./);
    assert.match(await chatFileLink(mark, taskIds[0], {}, env.fetchImpl), /token=down$/);
    const stray = await upload(sam, conversationId, [{ name: "later.pdf", type: "application/pdf" }]);
    await refused(post(priya, conversationId, "Mine now", stray), /not found|expired/);
  });

  it("refuses another person's upload, one from another conversation, a scheduled one and one already sent", async () => {
    const room = await createRoom(mark, { name: "claims", memberIds: [sam.userId] });
    const other = await createRoom(mark, { name: "claims-other", memberIds: [sam.userId] });
    const marks = await upload(mark, room.id, [{ name: "mine.pdf", type: "application/pdf" }]);
    await refused(post(sam, room.id, "Taking it", marks), /A file has expired\. Attach it again\./);
    await deniedInDb(
      queryAsUser(sam.userId, "insert into crm.chat_messages (conversation_id, author_user_id, client_key, body, attachment_ids) values ($1, $2, 'direct', '', $3::uuid[])", [room.id, sam.userId, marks]),
      /A file has expired\. Attach it again\./,
    );
    const elsewhere = await upload(mark, other.id, [{ name: "elsewhere.pdf", type: "application/pdf" }]);
    await refused(post(mark, room.id, "Wrong room", elsewhere), /A file has expired\. Attach it again\./);
    await deniedInDb(
      queryAsUser(mark.userId, "insert into crm.chat_messages (conversation_id, author_user_id, client_key, body, attachment_ids) values ($1, $2, 'direct-2', '', $3::uuid[])", [room.id, mark.userId, elsewhere]),
      /A file has expired\. Attach it again\./,
    );
    const scheduled = await upload(mark, room.id, [{ name: "later.pdf", type: "application/pdf" }]);
    await sql("update crm.chat_attachments set scheduled_id = gen_random_uuid() where id = $1", [scheduled[0]]);
    await refused(post(mark, room.id, "Too soon", scheduled), /A file has expired\. Attach it again\./);
    const first = await post(mark, room.id, "Once", marks);
    assert.equal(first.attachments.length, 1);
    await refused(post(mark, room.id, "Twice", marks), /A file has expired\. Attach it again\./);
  });

  it("lets only one of two posts at once claim a file, and a retry with the same key returns the first", async () => {
    const room = await createRoom(mark, { name: "race", memberIds: [sam.userId] });
    const ids = await upload(mark, room.id, [{ name: "race.pdf", type: "application/pdf" }]);
    const results = await Promise.allSettled([post(mark, room.id, "One", ids), post(mark, room.id, "Two", ids)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const again = await upload(mark, room.id, [{ name: "again.pdf", type: "application/pdf" }]);
    const input = { conversationId: room.id, body: "Same", clientKey: "same-key-files", attachmentIds: again };
    const [left, right] = await Promise.all([postMessage(mark, input, { fetchImpl: env.fetchImpl }), postMessage(mark, input, { fetchImpl: env.fetchImpl })]);
    assert.equal(left.message.id, right.message.id);
    assert.equal([left.duplicate, right.duplicate].filter(Boolean).length, 1);
    const retried = await postMessage(mark, input, { fetchImpl: env.fetchImpl });
    assert.equal(retried.duplicate, true);
    assert.equal(retried.message.attachments.length, 1);
  });

  it("refuses a post until each file has finished uploading, judging the type only for files shown inline", async () => {
    const room = await createRoom(mark, { name: "unfinished", memberIds: [sam.userId] });
    const missing = await upload(mark, room.id, [{ name: "missing.pdf", type: "application/pdf" }], { store: false });
    await refused(post(mark, room.id, "", missing), /A file didn't finish uploading\. Try again\./);
    const disguised = await upload(mark, room.id, [{ name: "photo.png", type: "image/png" }], { store: false });
    env.objects.set(key(room.id, disguised[0]), { bytes: 2048, type: "text/html" });
    await refused(post(mark, room.id, "", disguised), /A file didn't finish uploading\. Try again\./);
    const short = await upload(mark, room.id, [{ name: "short.pdf", type: "application/pdf" }], { store: false });
    env.objects.set(key(room.id, short[0]), { bytes: 100, type: "application/pdf" });
    await refused(post(mark, room.id, "", short), /A file didn't finish uploading\. Try again\./);
    env.objects.set(key(room.id, short[0]), { bytes: 2048, type: "application/pdf; charset=binary" });
    assert.equal((await post(mark, room.id, "", short)).attachments.length, 1);
    const unmeasured = await upload(mark, room.id, [{ name: "plain.pdf", type: "application/pdf" }], { store: false });
    env.objects.set(key(room.id, unmeasured[0]), { bytes: null, type: "application/pdf" });
    assert.equal((await post(mark, room.id, "", unmeasured)).attachments.length, 1);
    const page = await upload(mark, room.id, [{ name: "page.html", type: "text/html" }], { store: false });
    env.objects.set(key(room.id, page[0]), { bytes: 2048, type: "text/plain" });
    const sent = await post(mark, room.id, "", page);
    assert.equal(new URL(await chatFileLink(sam, sent.attachments[0].id, {}, env.fetchImpl)).searchParams.get("download"), "page.html");
  });

  it("refuses files from MCP, workflows and too many at once", async () => {
    const room = await createRoom(mark, { name: "writers", memberIds: [sam.userId] });
    const ids = await upload(mark, room.id, [{ name: "a.pdf", type: "application/pdf" }]);
    await refused(postMessage(mark, { conversationId: room.id, body: "x", attachmentIds: ids }, { charge: async () => undefined }), /Only people can attach files\./);
    await refused(postMessage(mark, { conversationId: room.id, body: "x", attachmentIds: ids }, { viaWorkflowId: "00000000-0000-4000-8000-000000000000" }), /Only people can attach files\./);
    const many = Array.from({ length: 11 }, (_, index) => ({ name: `f${index}.pdf`, size: 10, contentType: "application/pdf" }));
    await refused(prepareChatUpload(mark, room.id, many, env.fetchImpl), /Attach up to 10 files to a message\./);
    await refused(prepareChatUpload(mark, room.id, [{ name: "big.zip", size: 26 * 1024 * 1024, contentType: "application/zip" }], env.fetchImpl), /Files can be up to 25 MB each\./);
  });

  it("opens images and PDFs inline and downloads everything else, SVG included", async () => {
    const room = await createRoom(mark, { name: "inline", memberIds: [sam.userId] });
    const ids = await upload(mark, room.id, [
      { name: "shot.png", type: "image/png" },
      { name: "doc.pdf", type: "application/pdf" },
      { name: "logo.svg", type: "image/svg+xml" },
      { name: "page.html", type: "text/html" },
    ]);
    await post(mark, room.id, "", ids);
    const [png, pdf, svg, html] = await Promise.all(ids.map((id) => chatFileLink(sam, id, {}, env.fetchImpl)));
    assert.ok(!new URL(png).searchParams.has("download"));
    assert.ok(!new URL(pdf).searchParams.has("download"));
    assert.equal(new URL(svg).searchParams.get("download"), "logo.svg");
    assert.equal(new URL(html).searchParams.get("download"), "page.html");
    assert.equal(new URL(await chatFileLink(sam, ids[0], { download: true }, env.fetchImpl)).searchParams.get("download"), "shot.png");
    const unsent = await upload(mark, room.id, [{ name: "draft.png", type: "image/png" }]);
    assert.equal(new URL(await chatFileLink(mark, unsent[0], {}, env.fetchImpl)).searchParams.get("download"), "draft.png");
  });

  it("removes files in an edit but never leaves an empty message", async () => {
    const room = await createRoom(mark, { name: "edits", memberIds: [sam.userId] });
    const ids = await upload(mark, room.id, [
      { name: "one.pdf", type: "application/pdf" },
      { name: "two.pdf", type: "application/pdf" },
    ]);
    const message = await post(mark, room.id, "", ids);
    const trimmed = await editMessage(mark, message.id, "", { removeAttachmentIds: [ids[0]] });
    assert.deepEqual(
      trimmed.attachments.map((file) => file.id),
      [ids[1]],
    );
    assert.ok(trimmed.editedAt);
    assert.deepEqual(await tombstones(), [key(room.id, ids[0])].sort());
    await refused(editMessage(mark, message.id, "", { removeAttachmentIds: [ids[1]] }), /Delete the message instead\./);
    await refused(editMessage(sam, message.id, "Mine", { removeAttachmentIds: [ids[1]] }), /You can only change your own messages\./);
    const worded = await editMessage(mark, message.id, "Now with words", { removeAttachmentIds: [ids[1]] });
    assert.equal(worded.body, "Now with words");
    assert.deepEqual(worded.attachments, []);
    await refused(editMessage(mark, message.id, "  "), /Delete the message instead\./);
    const plain = await post(mark, room.id, "Just text", []);
    await refused(editMessage(mark, plain.id, ""), /Delete the message instead\./);
    await sql("truncate private.storage_tombstones");
  });

  it("changes nothing when an edit that removes files is refused", async () => {
    const snapshot = async (id: string) =>
      (
        await sql<{ body: string; edited_at: Date | null; attachment_ids: string[]; files: number }>(
          "select m.body, m.edited_at, m.attachment_ids::text[] as attachment_ids, (select count(*)::int from crm.chat_attachments a where a.message_id = m.id) as files from crm.chat_messages m where m.id = $1",
          [id],
        )
      )[0];
    await sql("truncate private.storage_tombstones");
    const room = await createRoom(mark, { name: "refused-edits", memberIds: [sam.userId] });
    const ids = await upload(mark, room.id, [
      { name: "keep.pdf", type: "application/pdf" },
      { name: "also.pdf", type: "application/pdf" },
    ]);
    const message = await post(mark, room.id, "Original", ids);
    const before = await snapshot(message.id);
    const crowd = Array.from({ length: 51 }, (_, index) => `@[P${index}](member:00000000-0000-4000-8000-${String(index).padStart(12, "0")})`).join(" ");
    await refused(editMessage(mark, message.id, crowd, { removeAttachmentIds: [ids[0]] }), /Tag up to 50 people/);
    assert.deepEqual(await snapshot(message.id), before);

    const account = (await sql<{ id: string }>("insert into crm.calendar_accounts (workspace_id, user_id, email, status) values ($1, $2, 'mark@files.test', 'disconnected') returning id", [mark.workspaceId, mark.userId]))[0].id;
    const source = (await sql<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, account_id, email) values ($1, $2, $3, 'mark@files.test') returning id", [mark.workspaceId, mark.userId, account]))[0].id;
    const share = (await sql<{ id: string }>("insert into crm.mail_shares (owner_user_id, source_id, thread_key) values ($1, $2, 'conv-files') returning id", [mark.userId, source]))[0].id;
    await sql("insert into crm.mail_share_members (share_id, user_id, added_by) values ($1, $2, $3)", [share, sam.userId, mark.userId]);
    const { conversationId } = await openDiscussion(mark, { kind: "mail_thread", id: share });
    const noteFiles = await upload(mark, conversationId, [{ name: "note.pdf", type: "application/pdf" }]);
    const note = await post(mark, conversationId, "", noteFiles);
    const noteBefore = await snapshot(note.id);
    await refused(editMessage(mark, note.id, `@[Priya Nair](member:${priya.userId}) see this`, { removeAttachmentIds: noteFiles }), /in this thread/);
    assert.deepEqual(await snapshot(note.id), noteBefore);
    assert.deepEqual(await tombstones(), []);

    const removed = await editMessage(mark, message.id, "Original", { removeAttachmentIds: [ids[0]] });
    assert.deepEqual(
      removed.attachments.map((file) => file.id),
      [ids[1]],
    );
    await chatWorkSettled();
    const edits = broadcasts
      .filter((item) => item.topic === personTopic(sam.userId))
      .map((item) => item.payload as ChatLiveEvent)
      .flatMap((event) => (event.type === "edit" && event.message.id === message.id ? [event.message] : []));
    assert.deepEqual(
      edits.at(-1)?.attachments.map((file) => file.id),
      [ids[1]],
    );
    await sql("truncate private.storage_tombstones");
  });

  it("never sweeps a file that a post claims while the sweep runs", async () => {
    const room = await createRoom(mark, { name: "sweep-race", memberIds: [sam.userId] });
    const anchor = await post(mark, room.id, "Anchor", []);
    const stale = await upload(mark, room.id, [{ name: "racing.pdf", type: "application/pdf" }]);
    await sql("update crm.chat_attachments set created_at = now() - interval '2 days' where id = $1", [stale[0]]);
    const holder = await getAdminPool().connect();
    try {
      await holder.query("begin");
      await holder.query("update crm.chat_attachments set message_id = $2 where id = $1", [stale[0], anchor.id]);
      const sweeping = sweepChatAttachments(env.fetchImpl);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query("commit");
      await sweeping;
    } finally {
      holder.release();
    }
    const kept = await sql<{ message_id: string | null }>("select message_id from crm.chat_attachments where id = $1", [stale[0]]);
    assert.deepEqual(kept, [{ message_id: anchor.id }]);
    assert.ok(!(await tombstones()).includes(key(room.id, stale[0])));
  });

  it("leaves a tombstone on every delete path and the sweep drains them", async () => {
    await sql("truncate private.storage_tombstones");
    const room = await createRoom(mark, { name: "deletes", memberIds: [sam.userId] });
    const deleted = await upload(mark, room.id, [{ name: "gone.pdf", type: "application/pdf" }]);
    const message = await post(mark, room.id, "Delete me", deleted);
    await deleteMessage(mark, message.id);
    assert.deepEqual((await sql("select attachment_count, attachment_ids from crm.chat_messages where id = $1", [message.id]))[0], { attachment_count: 0, attachment_ids: [] });
    const expected = [key(room.id, deleted[0])];

    const discarded = await upload(mark, room.id, [{ name: "discard.pdf", type: "application/pdf" }]);
    assert.deepEqual(await discardChatUploads(sam, discarded), { discarded: 0 });
    assert.deepEqual(await discardChatUploads(mark, discarded), { discarded: 1 });
    expected.push(key(room.id, discarded[0]));

    const stale = await upload(mark, room.id, [{ name: "stale.pdf", type: "application/pdf" }]);
    const fresh = await upload(mark, room.id, [{ name: "fresh.pdf", type: "application/pdf" }]);
    const scheduled = await upload(mark, room.id, [{ name: "scheduled.pdf", type: "application/pdf" }]);
    await sql("update crm.chat_attachments set created_at = now() - interval '2 days' where id = any($1::uuid[])", [[stale[0], scheduled[0]]]);
    await sql("update crm.chat_attachments set scheduled_id = gen_random_uuid() where id = $1", [scheduled[0]]);
    expected.push(key(room.id, stale[0]));

    const task = (await createTask(mark, { title: "Cascade", companyId, ownerId: mark.userId })).body.task;
    const { conversationId: taskChat } = await openDiscussion(mark, { kind: "task", id: task.id });
    const taskFile = await upload(mark, taskChat, [{ name: "task.pdf", type: "application/pdf" }]);
    await post(mark, taskChat, "On the task", taskFile);
    await sql("delete from crm.tasks where id = $1", [task.id]);
    expected.push(key(taskChat, taskFile[0]));

    const solo = await createRoom(mark, { name: "solo" });
    const soloFile = await upload(mark, solo.id, [{ name: "solo.pdf", type: "application/pdf" }]);
    await post(mark, solo.id, "Alone", soloFile);
    assert.equal((await leaveRoom(mark, solo.id)).deleted, true);
    expected.push(key(solo.id, soloFile[0]));

    const linked = await createRoom(priya, { name: "linked", workspaceId: mark.workspaceId });
    const linkedFile = await upload(priya, linked.id, [{ name: "linked.pdf", type: "application/pdf" }]);
    await post(priya, linked.id, "Linked", linkedFile);
    await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, priya.userId]);
    assert.equal((await sql("select count(*)::int as n from crm.chat_conversations where id = $1", [linked.id]))[0].n, 0);
    expected.push(key(linked.id, linkedFile[0]));

    const before = await tombstones();
    assert.deepEqual(before.filter((path) => path !== key(room.id, stale[0])).sort(), expected.filter((path) => path !== key(room.id, stale[0])).sort());

    env.failRemovals(true);
    const failedRun = await sweepChatAttachments(env.fetchImpl);
    assert.deepEqual(failedRun, { stale: 1, removed: 0 });
    assert.deepEqual(await tombstones(), [...expected].sort());

    env.failRemovals(false);
    const run = await sweepChatAttachments(env.fetchImpl);
    assert.equal(run.removed, expected.length);
    assert.deepEqual(await tombstones(), []);
    assert.deepEqual([...env.removed].sort(), [...expected].sort());
    assert.deepEqual((await sql("select id from crm.chat_attachments where id = any($1::uuid[]) order by id", [[fresh[0], scheduled[0]]])).map((row) => row.id).sort(), [fresh[0], scheduled[0]].sort());
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, priya.userId]);
  });

  it("says sent a file in a DM alert when there is no text", async () => {
    const dm = await openDm(mark, sam.userId);
    await post(mark, dm.id, "", await upload(mark, dm.id, [{ name: "a.png", type: "image/png" }]));
    await chatWorkSettled();
    const one = await sql<{ title: string; body: string | null }>("select title, body from crm.notifications where user_id = $1", [sam.userId]);
    assert.deepEqual(one, [{ title: "Mark sent you a file", body: null }]);
    await sql("update crm.chat_members set last_read_at = now() where user_id = $1", [sam.userId]);
    await post(mark, dm.id, "", await upload(mark, dm.id, [{ name: "b.png", type: "image/png" }, { name: "c.pdf", type: "application/pdf" }]));
    await chatWorkSettled();
    const titles = (await sql<{ title: string }>("select title from crm.notifications where user_id = $1 order by created_at", [sam.userId])).map((row) => row.title);
    assert.ok(titles.includes("Mark sent you 2 files"), titles.join(", "));
    const events = broadcasts.filter((item) => item.topic === personTopic(sam.userId)).map((item) => item.payload as ChatLiveEvent);
    assert.ok(events.some((event) => event.type === "message" && event.message.attachments.length === 2));
  });
});
