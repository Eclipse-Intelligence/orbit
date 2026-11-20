import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { chatWorkSettled, createRoom, editMessage, listConversations, postFromWeb, postMessage, searchMessages, setConversationNotify, updateRoom } from "@/lib/crm/chat";
import { prepareChatUpload } from "@/lib/crm/chat-attachments";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { resetStorageBucketCache } from "@/lib/storage";
import { createWorkflow } from "@/lib/workflows/store";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const MIGRATION = "supabase/migrations/20270302100000_chat_area_fixes.sql";
const SUPABASE = "https://project.supabase.test";
const BUCKET = "email-attachments";

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

async function titles(userId: string) {
  await chatWorkSettled();
  return (await sql<{ title: string }>("select title from crm.notifications where user_id = $1 order by created_at, id", [userId])).map((row) => row.title);
}

async function sidebarEntry(person: UserActor, conversationId: string) {
  const entry = (await listConversations(person)).conversations.find((conversation) => conversation.id === conversationId);
  assert.ok(entry);
  return entry;
}

function storage() {
  const objects = new Map<string, { bytes: number; type: string }>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === `${SUPABASE}/storage/v1/bucket`) return Response.json({ name: BUCKET });
    const uploadSign = url.match(/\/storage\/v1\/object\/upload\/sign\/email-attachments\/(.+)$/);
    if (uploadSign) return Response.json({ url: `/object/upload/sign/${BUCKET}/${uploadSign[1]}?token=up` });
    const object = url.match(/\/storage\/v1\/object\/email-attachments\/(.+)$/);
    if (object && method === "HEAD") {
      const stored = objects.get(object[1]);
      if (!stored) return new Response(null, { status: 400 });
      return new Response(null, { status: 200, headers: { "content-type": stored.type, "content-length": String(stored.bytes) } });
    }
    if (url === `${SUPABASE}/storage/v1/object/${BUCKET}` && method === "DELETE") return Response.json([]);
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { fetchImpl, objects };
}

async function uploadFiles(env: ReturnType<typeof storage>, actor: UserActor, conversationId: string, names: string[]) {
  const prepared = await prepareChatUpload(
    actor,
    conversationId,
    names.map((name) => ({ name, size: 2048, contentType: "application/pdf" })),
    env.fetchImpl,
  );
  for (const file of prepared) env.objects.set(`team-chat/${conversationId}/${file.id}`, { bytes: file.size, type: file.contentType });
  return prepared.map((file) => file.id);
}

let keys = 0;
function key() {
  keys += 1;
  return `area-${keys}`;
}

describe("chat area review fixes", () => {
  let mark: UserActor;
  let sam: UserActor;

  async function room(name: string) {
    return (await createRoom(mark, { name, memberIds: [sam.userId] })).id;
  }

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@area.test", "Mark Ridgeon");
    const samUser = await createUser("sam@area.test", "Sam Okafor");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, samUser.userId]);
    sam = { ...samUser, workspaceId: mark.workspaceId, role: "member" };
  });

  beforeEach(async () => {
    setLiveTesting({ batch: async () => undefined });
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

  describe("on the serverless pool", () => {
    const pool = useServerlessPool();

    it("runs its migration twice", async () => {
      pool.allowNestedConnections();
      await applyMigrationSql(getAdminPool(), readFileSync(MIGRATION, "utf8"));
      await applyMigrationSql(getAdminPool(), readFileSync(MIGRATION, "utf8"));
      const search = await sql<{ def: string }>("select pg_get_functiondef('private.chat_search(uuid, uuid, text, integer)'::regprocedure) as def");
      assert.match(search[0].def, /kind = 'message'/);
    });

    it("leaves the target's unread messages unread when a message is shared, and a plain post still reads it", async () => {
      const origin = await room("share-origin");
      const target = await room("share-target");
      const original = (await postMessage(mark, { conversationId: origin, body: "Worth a look", clientKey: key() })).message;
      await postMessage(mark, { conversationId: target, body: "First", clientKey: key() });
      await postMessage(mark, { conversationId: target, body: "Second", clientKey: key() });
      assert.equal((await sidebarEntry(sam, target)).unread, 2);
      const marker = async () => (await sql<{ at: string }>("select last_read_at::text as at from crm.chat_members where conversation_id = $1 and user_id = $2", [target, sam.userId]))[0].at;
      const start = await marker();
      const shared = await postFromWeb(sam, { conversationId: target, body: "Look", format: "plain", clientKey: key(), quotedMessageId: original.id }, { markRead: false });
      assert.equal(shared.message.quotedId, original.id);
      assert.equal(await marker(), start);
      assert.equal((await sidebarEntry(sam, target)).unread, 2);
      await postFromWeb(sam, { conversationId: target, body: "Replying", format: "plain", clientKey: key() });
      assert.notEqual(await marker(), start);
      assert.equal((await sidebarEntry(sam, target)).unread, 0);
    });

    it("sends the share action through postFromWeb without reading the target", () => {
      const source = readFileSync("app/(crm)/chat/actions.ts", "utf8");
      const action = source.slice(source.indexOf("export async function shareMessageAction"), source.indexOf("export async function editMessageAction"));
      assert.match(action, /postFromWeb\(actor, \{ \.\.\.\(input \?\? \{\}\), format: "plain" \}, \{ markRead: false \}\)/);
    });

    it("searches inside a room without matching system lines", async () => {
      const lookup = await room("area-find");
      await postMessage(mark, { conversationId: lookup, body: "Pricing note", clientKey: key() });
      await updateRoom(mark, lookup, { topic: "pricing review" });
      const events = await sql<{ body: string }>("select body from crm.chat_messages where conversation_id = $1 and kind = 'event'", [lookup]);
      assert.deepEqual(
        events.map((row) => row.body),
        ["set the topic: pricing review"],
      );
      const found = await searchMessages(mark, lookup, "pricing");
      assert.deepEqual(
        found.messages.map((message) => message.body),
        ["Pricing note"],
      );
    });

    it("keeps a share when every file and all its text are removed, and still refuses an empty plain message", async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
      process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
      resetStorageBucketCache();
      try {
        const env = storage();
        const origin = await room("quote-origin");
        const target = await room("quote-target");
        const original = (await postMessage(mark, { conversationId: origin, body: "Original", clientKey: key() })).message;
        const ids = await uploadFiles(env, mark, target, ["one.pdf", "two.pdf"]);
        const shared = (await postMessage(mark, { conversationId: target, body: "", clientKey: key(), attachmentIds: ids, quotedMessageId: original.id }, { fetchImpl: env.fetchImpl })).message;
        assert.equal(shared.attachments.length, 2);
        const trimmed = await editMessage(mark, shared.id, "", { removeAttachmentIds: ids });
        assert.deepEqual(trimmed.attachments, []);
        assert.equal(trimmed.quotedId, original.id);
        assert.equal(trimmed.body, "");
        const soloIds = await uploadFiles(env, mark, target, ["solo.pdf"]);
        const plain = (await postMessage(mark, { conversationId: target, body: "", clientKey: key(), attachmentIds: soloIds }, { fetchImpl: env.fetchImpl })).message;
        await refused(editMessage(mark, plain.id, "", { removeAttachmentIds: soloIds }), /Delete the message instead\./);
      } finally {
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        resetStorageBucketCache();
      }
    });

    it("alerts a workflow's owner on a room set to All, since the post already counts as unread for them", async () => {
      const flows = await room("area-flows");
      await setConversationNotify(mark, flows, { notify: "all" });
      const workflow = await createWorkflow(mark, { name: "Weekly digest" });
      await postMessage(mark, { conversationId: flows, body: "Own post", clientKey: key() });
      assert.deepEqual(await titles(mark.userId), []);
      assert.equal((await sidebarEntry(mark, flows)).unread, 0);
      await postMessage(mark, { conversationId: flows, body: "Digest", clientKey: key() }, { viaWorkflowId: workflow.id });
      assert.equal((await sidebarEntry(mark, flows)).unread, 1);
      assert.deepEqual(await titles(mark.userId), ["Mark via Weekly digest posted in #area-flows"]);
    });
  });

  describe("conversation locks", () => {
    let conversationId: string;
    let rootId: string;

    async function connect(url: string) {
      const connection = new Client({ connectionString: url });
      await connection.connect();
      return connection;
    }

    async function waiting(pid: number) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await sql("select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [pid])).length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail("The change never waited for the conversation lock.");
    }

    async function collide(change: { text: string; values: unknown[] }, post: { text: string; values: unknown[] }) {
      const poster = await connect(process.env.DATABASE_ADMIN_URL!);
      const changer = await connect(process.env.DATABASE_URL!);
      const errors: unknown[] = [];
      try {
        const pid = (await changer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
        await poster.query("begin");
        await poster.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`chat:${conversationId}`]);
        const changing = changer.query(change.text, change.values).then(
          () => undefined,
          (error: unknown) => void errors.push(error),
        );
        await waiting(pid);
        await poster.query(post.text, post.values).catch((error: unknown) => void errors.push(error));
        await poster.query("commit").catch(() => poster.query("rollback"));
        await changing;
      } finally {
        await poster.query("rollback").catch(() => undefined);
        await poster.end();
        await changer.end();
      }
      assert.deepEqual(
        errors.map((error) => (error as { message?: string }).message),
        [],
      );
    }

    before(async () => {
      conversationId = (await createRoom(mark, { name: "area-locks", memberIds: [sam.userId] })).id;
      rootId = (await postMessage(mark, { conversationId, body: "Root", clientKey: key() })).message.id;
    });

    it("lets a reply and a pin on one conversation both finish", async () => {
      await collide(
        { text: "select * from private.chat_set_pin($1, $2, true)", values: [mark.userId, rootId] },
        { text: "insert into crm.chat_messages (conversation_id, parent_id, author_user_id, client_key, body) values ($1, $2, $3, $4, 'Reply')", values: [conversationId, rootId, sam.userId, key()] },
      );
      assert.equal((await sql<{ n: number }>("select count(*)::int as n from crm.chat_pins where message_id = $1", [rootId]))[0].n, 1);
    });

    it("lets a post and a room edit on one conversation both finish", async () => {
      await collide(
        { text: "select private.chat_update_room($1, $2, null, false, null, true, 'Quarter plan')", values: [mark.userId, conversationId] },
        { text: "insert into crm.chat_messages (conversation_id, author_user_id, client_key, body) values ($1, $2, $3, 'Post')", values: [conversationId, sam.userId, key()] },
      );
      assert.equal((await sql<{ topic: string }>("select topic from crm.chat_conversations where id = $1", [conversationId]))[0].topic, "Quarter plan");
    });

    it("lets a post and an archive on one conversation both finish", async () => {
      await collide(
        { text: "select private.chat_set_archived($1, $2, true)", values: [mark.userId, conversationId] },
        { text: "insert into crm.chat_messages (conversation_id, author_user_id, client_key, body) values ($1, $2, $3, 'Post')", values: [conversationId, sam.userId, key()] },
      );
      assert.notEqual((await sql<{ archived_at: string | null }>("select archived_at from crm.chat_conversations where id = $1", [conversationId]))[0].archived_at, null);
      await sql("select private.chat_set_archived($1, $2, false)", [mark.userId, conversationId]);
    });
  });
});
