import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { POST as hookRoute } from "@/app/api/chat/hooks/[id]/route";
import type { ChatLiveEvent } from "@/lib/chat/types";
import { chatWorkSettled, createRoom, deleteMessage, editMessage, listConversations, listMessages, openDm, postMessage } from "@/lib/crm/chat";
import { createHook, deleteHook, listHooks, parseHookBody, postViaHook, rotateHookSecret, setHookPaused } from "@/lib/crm/chat-hooks";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

after(async () => {
  await getPool().end();
});

async function sql(text: string, values: unknown[] = []) {
  return getAdminPool().query(text, values);
}

function send(hookId: string, body: string, headers: Record<string, string> = {}, search = "") {
  const request = new Request(`http://localhost/api/chat/hooks/${hookId}${search}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return hookRoute(request, { params: Promise.resolve({ id: hookId }) });
}

function bearer(secret: string) {
  return { authorization: `Bearer ${secret}` };
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function deleteHookMessageAsMember(actor: UserActor, messageId: string) {
  return getPool().query("select private.chat_delete_hook_message($1, $2)", [actor.userId, messageId]).catch((error: Error) => {
    throw new CrmError("not_found", error.message, 404);
  });
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

describe("chat hooks", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let roomId: string;
  let broadcasts: LiveMessage[];

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@eclipse.test", "Mark Ridgeon");
    const samUser = await createUser("sam@eclipse.test", "Sam Okafor");
    const priyaUser = await createUser("priya@eclipse.test", "Priya Nair");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')", [mark.workspaceId, samUser.userId, priyaUser.userId]);
    sam = { ...samUser, workspaceId: mark.workspaceId, role: "member" };
    priya = { ...priyaUser, workspaceId: mark.workspaceId, role: "member" };
    roomId = (await createRoom(mark, { name: "alerts", memberIds: [sam.userId] })).id;
  });

  beforeEach(async () => {
    broadcasts = [];
    setLiveTesting({ batch: async (messages) => void broadcasts.push(...messages) });
    await sql("delete from crm.chat_messages");
    await sql("delete from crm.chat_hooks");
    await sql("truncate crm.push_log, crm.notifications");
    await sql("delete from private.rate_limit_buckets where bucket_key like 'chat-hook:%'");
  });

  afterEach(async () => {
    await chatWorkSettled();
    setLiveTesting(null);
  });

  describe("managing", () => {
    it("lets any room member add, list, pause, resume, rotate and delete hooks", async () => {
      const created = await createHook(sam, roomId, "  Google Analytics ");
      assert.equal(created.hook.name, "Google Analytics");
      assert.match(created.secret, /^ohk_[A-Za-z0-9_-]{32}$/);
      assert.equal(created.hook.pausedAt, null);
      const listed = await listHooks(mark, roomId);
      assert.deepEqual(
        listed.map((hook) => hook.id),
        [created.hook.id],
      );
      assert.equal(Object.keys(listed[0]).includes("secretHash"), false);
      const paused = await setHookPaused(mark, created.hook.id, true);
      assert.ok(paused.pausedAt);
      const resumed = await setHookPaused(sam, created.hook.id, false);
      assert.equal(resumed.pausedAt, null);
      const rotated = await rotateHookSecret(mark, created.hook.id);
      assert.notEqual(rotated.secret, created.secret);
      await deleteHook(mark, created.hook.id);
      assert.deepEqual(await listHooks(sam, roomId), []);
      await refused(createHook(mark, roomId, "  "), /Give the webhook a name\./);
    });

    it("refuses people outside the room", async () => {
      const { hook } = await createHook(mark, roomId, "Stripe");
      await refused(listHooks(priya, roomId), /Room not found\./);
      await refused(createHook(priya, roomId, "Sneaky"), /Room not found\./);
      await refused(setHookPaused(priya, hook.id, true), /Webhook not found\./);
      await refused(rotateHookSecret(priya, hook.id), /Webhook not found\./);
      await refused(deleteHook(priya, hook.id), /Webhook not found\./);
      const rows = await queryAsUser<{ id: string }>(priya.userId, "select id from crm.chat_hooks");
      assert.deepEqual(rows, []);
      await assert.rejects(
        queryAsUser(priya.userId, "insert into crm.chat_hooks (conversation_id, name, secret_hash, created_by) values ($1, 'x', repeat('a', 64), $2)", [roomId, priya.userId]),
        /row-level security/,
      );
      assert.equal((await listHooks(mark, roomId))[0].pausedAt, null);
    });

    it("never lets anyone read the secret hash", async () => {
      await createHook(mark, roomId, "Make");
      await assert.rejects(queryAsUser(mark.userId, "select secret_hash from crm.chat_hooks"), /permission denied/);
      await assert.rejects(queryAsUser(mark.userId, "select * from crm.chat_hooks"), /permission denied/);
      await assert.rejects(queryAsUser(mark.userId, "select id from crm.chat_hooks where secret_hash like 'a%'"), /permission denied/);
      await assert.rejects(queryAsUser(mark.userId, "update crm.chat_hooks set name = name returning secret_hash"), /permission denied/);
      await assert.rejects(queryAsUser(mark.userId, "select private.chat_hook_post(gen_random_uuid(), '', null, 'x', null, false, null, 30, 60)"), /permission denied/);
    });

    it("stops members forging hook messages", async () => {
      const { hook } = await createHook(mark, roomId, "Forged");
      await assert.rejects(
        queryAsUser(mark.userId, "insert into crm.chat_messages (conversation_id, author_user_id, body, via_hook_id) values ($1, $2, 'x', $3)", [roomId, mark.userId, hook.id]),
        /permission denied/,
      );
    });
  });

  describe("posting", () => {
    it("posts a card as the hook, with no mentions and no alerts", async () => {
      const { hook, secret } = await createHook(mark, roomId, "Google Analytics");
      const response = await send(
        hook.id,
        JSON.stringify({ title: "Weekly traffic", text: `Sessions up 12%. @[Sam Okafor](member:${sam.userId}) <b>bold</b>`, url: "https://analytics.example/report" }),
        bearer(secret),
      );
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await json(response);
      assert.equal(body.conversationId, roomId);
      assert.equal(body.duplicate, false);
      const row = (await sql("select author_user_id, author_name, via_hook_id, mentions::text[] as mentions, body, hook from crm.chat_messages where id = $1", [body.id])).rows[0];
      assert.equal(row.author_user_id, null);
      assert.equal(row.author_name, "Google Analytics");
      assert.equal(row.via_hook_id, hook.id);
      assert.deepEqual(row.mentions, []);
      assert.match(row.body, /<b>bold<\/b>/);
      assert.deepEqual(row.hook, { title: "Weekly traffic", url: "https://analytics.example/report" });
      const page = await listMessages(sam, roomId);
      assert.deepEqual(page.messages[0].hook, { title: "Weekly traffic", url: "https://analytics.example/report", block: false });
      assert.equal(page.messages[0].author.id, null);
      assert.equal(page.messages[0].author.name, "Google Analytics");
      await chatWorkSettled();
      for (const person of [mark, sam]) {
        const events = broadcasts.filter((message) => message.topic === personTopic(person.userId)).map((message) => message.payload as ChatLiveEvent);
        assert.ok(events.some((event) => event.type === "message" && event.message.id === body.id && event.message.hook?.title === "Weekly traffic"));
      }
      assert.equal(broadcasts.some((message) => message.topic === personTopic(priya.userId)), false);
      const sidebar = await listConversations(sam);
      const room = sidebar.conversations.find((conversation) => conversation.id === roomId)!;
      assert.equal(room.unread, 1);
      assert.equal(room.mentions, 0);
      assert.equal(sidebar.mentioned, false);
      assert.equal((await sql("select count(*)::int as n from crm.notifications")).rows[0].n, 0);
      assert.equal((await sql("select count(*)::int as n from crm.chat_thread_reads")).rows[0].n, 0);
      const used = await listHooks(mark, roomId);
      assert.ok(used[0].lastUsedAt);
    });

    it("lets members reply in a thread on a hook message", async () => {
      const { hook, secret } = await createHook(mark, roomId, "Uptime");
      const posted = await json(await send(hook.id, JSON.stringify({ text: "Site down" }), bearer(secret)));
      const reply = await postMessage(sam, { conversationId: roomId, parentId: posted.id, body: "Looking" });
      assert.equal(reply.root?.replyCount, 1);
    });

    it("refuses bad secrets, paused, deleted and rotated hooks", async () => {
      const { hook, secret } = await createHook(mark, roomId, "Zapier");
      const text = JSON.stringify({ text: "Hello" });
      assert.equal((await send(hook.id, text)).status, 401);
      assert.equal((await send(hook.id, text, { authorization: secret })).status, 401);
      assert.equal((await send(hook.id, text, bearer(`${secret}x`))).status, 401);
      const wrong = await send(hook.id, text, bearer("ohk_wrong"));
      assert.match(String((await json(wrong)).error), /Authorization: Bearer/);
      assert.equal((await send("not-a-uuid", text, bearer(secret))).status, 404);
      assert.equal((await send("8f1c3a1e-0000-4000-8000-000000000000", text, bearer(secret))).status, 404);
      assert.equal((await send(hook.id, text, {}, `?key=${secret}`)).status, 400);
      assert.equal((await send(hook.id, text, bearer(secret), `?secret=${secret}`)).status, 400);
      assert.equal((await send(hook.id, text, bearer(secret), `?token=${secret}`)).status, 400);
      await setHookPaused(mark, hook.id, true);
      const paused = await send(hook.id, text, bearer(secret));
      assert.equal(paused.status, 409);
      assert.match(String((await json(paused)).error), /paused/);
      assert.equal((await send(hook.id, text, bearer("ohk_wrong"))).status, 401);
      await setHookPaused(mark, hook.id, false);
      const rotated = await rotateHookSecret(sam, hook.id);
      assert.equal((await send(hook.id, text, bearer(secret))).status, 401);
      assert.equal((await send(hook.id, text, bearer(rotated.secret))).status, 201);
      await deleteHook(mark, hook.id);
      assert.equal((await send(hook.id, text, bearer(rotated.secret))).status, 404);
      const kept = (await sql("select via_hook_id, hook, author_name from crm.chat_messages")).rows;
      assert.equal(kept.length, 1);
      assert.equal(kept[0].via_hook_id, null);
      assert.equal(kept[0].author_name, "Zapier");
      assert.deepEqual(kept[0].hook, {});
      assert.ok((await listMessages(mark, roomId)).messages[0].hook);
    });

    it("caps the body and checks its fields", async () => {
      const { hook, secret } = await createHook(mark, roomId, "Limits");
      const huge = JSON.stringify({ text: "x".repeat(33 * 1024) });
      const declared = await send(hook.id, huge, bearer(secret));
      assert.equal(declared.status, 413);
      assert.match(String((await json(declared)).error), /32 KB/);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(huge));
          controller.close();
        },
      });
      const streamed = await hookRoute(new Request(`http://localhost/api/chat/hooks/${hook.id}`, { method: "POST", headers: bearer(secret), body: stream, duplex: "half" } as RequestInit), {
        params: Promise.resolve({ id: hook.id }),
      });
      assert.equal(streamed.status, 413);
      assert.equal((await send(hook.id, "not json", bearer(secret))).status, 400);
      assert.equal((await send(hook.id, "", bearer(secret))).status, 400);
      assert.equal((await send(hook.id, JSON.stringify({ text: "   " }), bearer(secret))).status, 400);
      assert.equal((await send(hook.id, JSON.stringify({ text: "x".repeat(10_001) }), bearer(secret))).status, 400);
      assert.equal((await send(hook.id, JSON.stringify({ text: "x", url: "javascript:alert(1)" }), bearer(secret))).status, 400);
      assert.equal((await send(hook.id, JSON.stringify({ text: "x", url: "https://user:pass@example.com/" }), bearer(secret))).status, 400);
      assert.equal((await send(hook.id, JSON.stringify({ text: "x", url: "https://user@example.com/" }), bearer(secret))).status, 400);
      assert.equal((await send(hook.id, JSON.stringify({ text: "x", url: `https://example.com/${"é".repeat(400)}` }), bearer(secret))).status, 400);
      assert.equal((await send(hook.id, JSON.stringify({ text: "x", title: 5 }), bearer(secret))).status, 400);
      assert.equal((await send(hook.id, JSON.stringify({ text: "x", title: "t".repeat(201) }), bearer(secret))).status, 400);
      assert.equal((await sql("select count(*)::int as n from crm.chat_messages")).rows[0].n, 0);
    });

    it("posts other JSON as a formatted block", async () => {
      const { hook, secret } = await createHook(mark, roomId, "Make");
      const response = await send(hook.id, JSON.stringify({ event: "goal", sessions: 4812, text: 3 }), bearer(secret));
      assert.equal(response.status, 201);
      const id = (await json(response)).id;
      const row = (await sql("select body, hook from crm.chat_messages where id = $1", [id])).rows[0];
      assert.equal(row.body, JSON.stringify({ event: "goal", sessions: 4812, text: 3 }, null, 2));
      assert.deepEqual(row.hook, { block: true });
      assert.equal((await send(hook.id, JSON.stringify([1, 2]), bearer(secret))).status, 201);
      const long = parseHookBody(JSON.stringify({ rows: Array.from({ length: 2000 }, (_, index) => index) }));
      assert.equal(long.block, true);
      assert.ok(long.text.length <= 8002);
      assert.ok(long.text.endsWith("\n…"));
      const emoji = parseHookBody(JSON.stringify({ note: "\u{1F600}".repeat(9000) }));
      assert.equal(Array.from(emoji.text).length, 8002);
      assert.doesNotMatch(emoji.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });

    it("checks the secret before parsing, and refuses deep JSON", async () => {
      const { hook, secret } = await createHook(mark, roomId, "Deep");
      const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;
      assert.equal((await send(hook.id, deep, bearer("ohk_wrong"))).status, 401);
      assert.equal((await send(hook.id, "not json", bearer("ohk_wrong"))).status, 401);
      const refusedDeep = await send(hook.id, deep, bearer(secret));
      assert.equal(refusedDeep.status, 400);
      assert.match(String((await json(refusedDeep)).error), /20 levels/);
      const nested = JSON.stringify({ a: { b: { c: [1, [2, [3]]] } } });
      assert.equal((await send(hook.id, nested, bearer(secret))).status, 201);
      let twentyOne: unknown = 1;
      for (let level = 0; level < 21; level += 1) twentyOne = [twentyOne];
      assert.equal((await send(hook.id, JSON.stringify(twentyOne), bearer(secret))).status, 400);
    });

    it("refuses hooks in archived rooms and DMs", async () => {
      const archived = (await createRoom(mark, { name: "old", memberIds: [sam.userId] })).id;
      const { hook, secret } = await createHook(mark, archived, "Old");
      await sql("update crm.chat_conversations set archived_at = now() where id = $1", [archived]);
      assert.equal((await send(hook.id, JSON.stringify({ text: "x" }), bearer(secret))).status, 404);
      await refused(listHooks(mark, archived), /Room not found\./);
      await refused(createHook(mark, archived, "New"), /Room not found\./);
      const dm = await openDm(mark, sam.userId);
      await refused(createHook(mark, dm.id, "DM hook"), /Room not found\./);
      await assert.rejects(
        queryAsUser(mark.userId, "insert into crm.chat_hooks (conversation_id, name, secret_hash, created_by) values ($1, 'x', repeat('a', 64), $2)", [dm.id, mark.userId]),
        /row-level security/,
      );
    });

    it("lets any member delete a hook message, but not edit it", async () => {
      const { hook, secret } = await createHook(mark, roomId, "Spam");
      const posted = await json(await send(hook.id, JSON.stringify({ text: "Buy now" }), bearer(secret)));
      const id = String(posted.id);
      await refused(editMessage(sam, id, "Edited"), /You can only change your own messages\./);
      const edited = await queryAsUser(sam.userId, "update crm.chat_messages set body = 'x' where id = $1 returning id", [id]);
      assert.deepEqual(edited, []);
      await refused(deleteMessage(priya, id), /not found/i);
      await assert.rejects(queryAsUser(sam.userId, "select private.chat_delete_hook_message($1, $2)", [sam.userId, id]), /permission denied/);
      broadcasts = [];
      assert.deepEqual(await deleteMessage(sam, id), { deleted: true });
      const row = (await sql("select body, deleted_at, hook from crm.chat_messages where id = $1", [id])).rows[0];
      assert.equal(row.body, "");
      assert.ok(row.deleted_at);
      await refused(deleteMessage(mark, id), /not found|deleted/i);
      await chatWorkSettled();
      const events = broadcasts.filter((message) => message.topic === personTopic(mark.userId)).map((message) => message.payload as ChatLiveEvent);
      assert.ok(events.some((event) => event.type === "delete" && event.messageId === id));
      const own = await postMessage(sam, { conversationId: roomId, body: "Mine" });
      await refused(deleteHookMessageAsMember(mark, own.message.id), /not found/i);
    });

    it("dedupes on the Idempotency-Key header", async () => {
      const { hook, secret } = await createHook(mark, roomId, "Retry");
      const other = await createHook(mark, roomId, "Other");
      const headers = { ...bearer(secret), "idempotency-key": "event-42" };
      const first = await send(hook.id, JSON.stringify({ text: "Once" }), headers);
      assert.equal(first.status, 201);
      const again = await send(hook.id, JSON.stringify({ text: "Once" }), headers);
      assert.equal(again.status, 200);
      const firstBody = await json(first);
      const againBody = await json(again);
      assert.equal(againBody.id, firstBody.id);
      assert.equal(againBody.duplicate, true);
      assert.equal((await send(other.hook.id, JSON.stringify({ text: "Once" }), { ...bearer(other.secret), "idempotency-key": "event-42" })).status, 201);
      const longKey = { ...bearer(secret), "idempotency-key": "k".repeat(300) };
      assert.equal((await send(hook.id, JSON.stringify({ text: "Long" }), longKey)).status, 201);
      assert.equal((await send(hook.id, JSON.stringify({ text: "Long" }), longKey)).status, 200);
      assert.equal((await sql("select count(*)::int as n from crm.chat_messages")).rows[0].n, 3);
      await chatWorkSettled();
      const events = broadcasts.filter((message) => message.topic === personTopic(sam.userId));
      assert.equal(events.length, 3);
    });

    it("rate limits each hook, after the dedupe check", async () => {
      const { hook, secret } = await createHook(mark, roomId, "Burst");
      const other = await createHook(mark, roomId, "Calm");
      const payload = (text: string) => JSON.stringify({ text });
      const options = { perMinute: 2, windowSeconds: 3600 };
      const authorization = `Bearer ${secret}`;
      await postViaHook({ hookId: hook.id, authorization, idempotencyKey: "a", body: payload("1") }, options);
      await postViaHook({ hookId: hook.id, authorization, body: payload("2") }, options);
      await refused(postViaHook({ hookId: hook.id, authorization, body: payload("3") }, options), /30 messages a minute/);
      const repeat = await postViaHook({ hookId: hook.id, authorization, idempotencyKey: "a", body: payload("1") }, options);
      assert.equal(repeat.duplicate, true);
      await postViaHook({ hookId: other.hook.id, authorization: `Bearer ${other.secret}`, body: payload("calm") }, options);
      await sql("update private.rate_limit_buckets set request_count = 1000, window_start = to_timestamp(floor(extract(epoch from clock_timestamp()) / 60) * 60) where bucket_key = $1", [
        `chat-hook:${hook.id}`,
      ]);
      const limited = await send(hook.id, JSON.stringify({ text: "x" }), bearer(secret));
      assert.equal(limited.status, 429);
    });
  });
});
