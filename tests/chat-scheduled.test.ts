import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { daysToMonday, scheduledHere, scheduledPlace, scheduledWhen, sendLaterChoices } from "@/lib/chat/scheduled";
import type { ChatScheduledItem } from "@/lib/chat/types";
import { chatLocationHref, chatSegments, parseChatLocation } from "@/lib/chat/routes";
import { chatWorkSettled, createRoom, deleteMessage, listConversations, listMessages, openDiscussion, openDm, postMessage, removeRoomMember, setRoomArchived } from "@/lib/crm/chat";
import { chatFileLink, drainStorageTombstones, prepareChatUpload, sweepChatAttachments } from "@/lib/crm/chat-attachments";
import { cancelScheduled, deliverScheduled, listScheduled, processDueScheduled, scheduleMessage, sendScheduledNow, sweepScheduled, updateScheduled } from "@/lib/crm/chat-scheduled";
import { createCompany } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { getAdminPool, getPool, query } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { resetStorageBucketCache } from "@/lib/storage";
import { createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const SUPABASE = "https://project.supabase.test";
const BUCKET = "email-attachments";
const MIGRATION = "supabase/migrations/20270228110000_chat_scheduled.sql";
const SECRET = "Quarterly numbers 41.2m";
const HOUR = 3_600_000;

type Stored = { bytes: number | null; type: string };

function storage() {
  const objects = new Map<string, Stored>();
  const removed: string[] = [];
  let failChecks = false;
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
      if (failChecks) throw new TypeError("fetch failed");
      const stored = objects.get(object[1]);
      if (!stored) return new Response(null, { status: 400 });
      return new Response(null, { status: 200, headers: { "content-type": stored.type, ...(stored.bytes === null ? {} : { "content-length": String(stored.bytes) }) } });
    }
    if (url === `${SUPABASE}/storage/v1/object/${BUCKET}` && method === "DELETE") {
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
    failChecks(value: boolean) {
      failChecks = value;
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

function key(conversationId: string, id: string) {
  return `team-chat/${conversationId}/${id}`;
}

async function join(user: UserActor, workspaceId: string, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [workspaceId, user.userId, role]);
  return { ...user, workspaceId, role, scopes: scopesForRole(role) };
}

async function upload(actor: UserActor, conversationId: string, names: string[]) {
  const prepared = await prepareChatUpload(
    actor,
    conversationId,
    names.map((name) => ({ name, size: 2048, contentType: "application/pdf" })),
    env.fetchImpl,
  );
  for (const file of prepared) env.objects.set(key(conversationId, file.id), { bytes: file.size, type: file.contentType });
  return prepared.map((file) => file.id);
}

async function schedule(actor: UserActor, conversationId: string, body: string, options: { parentId?: string | null; files?: string[]; id?: string; at?: number } = {}) {
  const result = await scheduleMessage(
    actor,
    {
      id: options.id ?? randomUUID(),
      conversationId,
      parentId: options.parentId ?? null,
      body,
      format: "markdown",
      attachmentIds: options.files,
      sendAt: new Date(options.at ?? Date.now() + HOUR).toISOString(),
    },
    { fetchImpl: env.fetchImpl },
  );
  return result.item;
}

async function makeDue(id: string, secondsAgo = 1) {
  await sql("update crm.chat_scheduled set send_at = now() - make_interval(secs => $2) where id = $1", [id, secondsAgo]);
}

async function makeStale(id: string) {
  await sql("update crm.chat_scheduled set claimed_at = clock_timestamp() - interval '10 minutes' where id = $1", [id]);
}

async function row(id: string) {
  return (await sql<{ status: string; attempts: number; failure: string | null; body: string; send_at: Date; attachment_ids: string[] }>("select status, attempts, failure, body, send_at, attachment_ids from crm.chat_scheduled where id = $1", [id]))[0] ?? null;
}

async function messagesWithKey(id: string) {
  return sql<{ id: string; body: string; conversation_id: string; parent_id: string | null; attachment_count: number }>(
    "select id, body, conversation_id, parent_id, attachment_count from crm.chat_messages where client_key = $1",
    [id],
  );
}

async function claimDue(skip: string[] = []) {
  return (await query<{ id: string; user_id: string; conversation_id: string; parent_id: string | null; body: string; format: string; attachment_ids: string[]; attempts: number; claim_token: string }>("select * from private.chat_schedule_claim_due($1::uuid[])", [skip])).rows[0];
}

async function noticesFor(user: UserActor) {
  return sql<{ title: string; body: string | null; href: string | null; source: string }>("select title, body, href, source from crm.notifications where user_id = $1 order by created_at", [user.userId]);
}

describe("send later times", () => {
  const zone = "Europe/London";

  it("offers in an hour, tomorrow at nine and Monday at nine in London time across the clock changes", () => {
    const labels = (now: string) => sendLaterChoices(Date.parse(now), zone).map((choice) => [choice.label, choice.detail, choice.at]);
    assert.deepEqual(labels("2026-03-27T10:00:00Z"), [
      ["In 1 hour", "11:00", "2026-03-27T11:00:00.000Z"],
      ["Tomorrow at 09:00", "Sat 28 Mar", "2026-03-28T09:00:00.000Z"],
      ["Monday at 09:00", "Mon 30 Mar", "2026-03-30T08:00:00.000Z"],
    ]);
    assert.deepEqual(labels("2026-03-28T20:00:00Z"), [
      ["In 1 hour", "21:00", "2026-03-28T21:00:00.000Z"],
      ["Tomorrow at 09:00", "Sun 29 Mar", "2026-03-29T08:00:00.000Z"],
      ["Monday at 09:00", "Mon 30 Mar", "2026-03-30T08:00:00.000Z"],
    ]);
    assert.deepEqual(labels("2026-10-24T20:00:00Z"), [
      ["In 1 hour", "22:00", "2026-10-24T21:00:00.000Z"],
      ["Tomorrow at 09:00", "Sun 25 Oct", "2026-10-25T09:00:00.000Z"],
      ["Monday at 09:00", "Mon 26 Oct", "2026-10-26T09:00:00.000Z"],
    ]);
  });

  it("decides what tomorrow is by the person's own clock", () => {
    const now = Date.parse("2026-06-12T23:30:00Z");
    assert.equal(sendLaterChoices(now, "Europe/London").find((choice) => choice.id === "tomorrow")?.at, "2026-06-14T08:00:00.000Z");
    assert.equal(sendLaterChoices(now, "America/New_York").find((choice) => choice.id === "tomorrow")?.at, "2026-06-13T13:00:00.000Z");
    assert.equal(sendLaterChoices(now, "Asia/Tokyo").find((choice) => choice.id === "tomorrow")?.at, "2026-06-14T00:00:00.000Z");
  });

  it("drops Monday when tomorrow is Monday and counts a Monday morning as next week", () => {
    assert.deepEqual(
      sendLaterChoices(Date.parse("2026-03-29T10:00:00Z"), zone).map((choice) => choice.id),
      ["hour", "tomorrow"],
    );
    assert.equal(daysToMonday(Date.parse("2026-03-30T07:00:00Z"), zone), 7);
    assert.equal(daysToMonday(Date.parse("2026-03-28T07:00:00Z"), zone), 2);
  });

  it("words a time relative to today in the person's day", () => {
    const now = Date.parse("2026-03-27T10:00:00Z");
    assert.equal(scheduledWhen("2026-03-27T17:00:00Z", now, zone), "Today at 17:00");
    assert.equal(scheduledWhen("2026-03-28T09:00:00Z", now, zone), "Tomorrow at 09:00");
    assert.equal(scheduledWhen("2026-03-30T08:00:00Z", now, zone), "Monday at 09:00");
    assert.equal(scheduledWhen("2026-04-14T08:00:00Z", now, zone), "Tue 14 Apr at 09:00");
    assert.equal(scheduledWhen("2027-01-04T09:00:00Z", now, zone), "Mon 4 Jan 2027 at 09:00");
    assert.equal(scheduledWhen("2026-12-30T09:00:00Z", Date.parse("2026-12-28T10:00:00Z"), zone), "Wednesday at 09:00");
    assert.equal(scheduledWhen("2027-01-02T09:00:00Z", Date.parse("2026-12-29T10:00:00Z"), zone), "Saturday at 09:00");
    assert.equal(scheduledWhen("2027-01-20T09:00:00Z", Date.parse("2026-12-29T10:00:00Z"), zone), "Wed 20 Jan 2027 at 09:00");
    assert.equal(scheduledWhen("2026-03-27T17:00:00Z", now, zone, { sentence: true }), "today at 17:00");
    assert.equal(scheduledWhen("2026-03-28T09:00:00Z", now, zone, { sentence: true }), "tomorrow at 09:00");
    assert.equal(scheduledWhen("2026-03-27T23:30:00Z", Date.parse("2026-03-27T22:30:00Z"), zone), "Today at 23:30");
  });

  it("opens the Scheduled view at /chat/scheduled and filters rows to one conversation or thread", () => {
    assert.deepEqual(chatSegments(["scheduled"]), { kind: "scheduled" });
    assert.equal(chatLocationHref({ view: { kind: "scheduled" }, thread: "ignored" }), "/chat/scheduled");
    assert.deepEqual(parseChatLocation("/chat/scheduled", "thread=3f0e0a0e-0000-4000-8000-000000000000"), { view: { kind: "scheduled" }, thread: null, message: null });
    const item = (id: string, conversation: string, parentId: string | null): ChatScheduledItem => ({
      id,
      conversation: { id: conversation, kind: "room", name: "x" },
      parentId,
      body: "",
      format: "markdown",
      attachments: [],
      sendAt: "",
      status: "pending",
      failure: null,
      createdAt: "",
    });
    const items = [item("1", "a", null), item("2", "a", "root"), item("3", "b", null)];
    assert.deepEqual(scheduledHere(items, "a", null).map((entry) => entry.id), ["1"]);
    assert.deepEqual(scheduledHere(items, "a", "root").map((entry) => entry.id), ["2"]);
    assert.equal(scheduledPlace({ conversation: { id: "a", kind: "room", name: "sales" }, parentId: null }), "#sales");
    assert.equal(scheduledPlace({ conversation: { id: "a", kind: "dm", name: "Sam Okafor" }, parentId: "root" }), "Reply in Sam Okafor");
    assert.equal(scheduledPlace({ conversation: { id: "a", kind: "room", name: null }, parentId: null }), "A conversation you've left");
  });
});

describe("scheduled chat messages", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let ada: UserActor;
  let olly: UserActor;
  let companyId: string;
  let room: string;

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@later.test", "Mark Ridgeon");
    sam = await join(await createUser("sam@later.test", "Sam Okafor"), mark.workspaceId, "member");
    priya = await join(await createUser("priya@later.test", "Priya Nair"), mark.workspaceId, "member");
    ada = await join(await createUser("ada@later.test", "Ada Admin"), mark.workspaceId, "admin");
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
    await sql("truncate crm.push_log, crm.notifications, private.storage_tombstones");
    await sql("truncate crm.chat_scheduled cascade");
    room = (await createRoom(mark, { name: `later-${randomUUID().slice(0, 8)}`, memberIds: [sam.userId] })).id;
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
    const definition = await sql<{ def: string }>("select pg_get_functiondef('private.chat_message_claim()'::regprocedure) as def");
    assert.match(definition[0].def, /chat_scheduled/);
  });

  it("keeps a schedule private to its owner, whoever else is in the room or the workspace", async () => {
    const files = await upload(sam, room, ["plan.pdf"]);
    const item = await schedule(sam, room, SECRET, { files });
    assert.equal(item.status, "pending");
    assert.equal(item.attachments[0].name, "plan.pdf");
    assert.deepEqual((await listScheduled(sam)).items.map((entry) => entry.id), [item.id]);
    for (const other of [mark, ada, priya, olly]) {
      assert.deepEqual((await listScheduled(other)).items, []);
      assert.deepEqual(await queryAsUser(other.userId, "select id from crm.chat_scheduled"), []);
      assert.deepEqual(await queryAsUser(other.userId, "select id from crm.chat_attachments where id = $1", [files[0]]), []);
      await refused(updateScheduled(other, item.id, { body: "Changed" }), /no longer scheduled/);
      assert.deepEqual(await cancelScheduled(other, item.id), { cancelled: false });
      await refused(sendScheduledNow(other, item.id, { fetchImpl: env.fetchImpl }), /no longer scheduled/);
      await refused(chatFileLink(other, files[0], {}, env.fetchImpl), /File not found\./);
    }
    assert.equal((await row(item.id))?.body, SECRET);
    assert.equal((await sql("select 1 from crm.chat_attachments where scheduled_id = $1 and message_id is null", [item.id])).length, 1);
    assert.equal((await queryAsUser(sam.userId, "select id from crm.chat_scheduled")).length, 1);
    await assert.rejects(queryAsUser(sam.userId, "update crm.chat_scheduled set send_at = now() where id = $1", [item.id]), /permission denied/);
    await assert.rejects(queryAsUser(sam.userId, "delete from crm.chat_scheduled where id = $1", [item.id]), /permission denied/);
    await assert.rejects(queryAsUser(sam.userId, "insert into crm.chat_scheduled (user_id, conversation_id, body, send_at) values ($1, $2, 'x', now() + interval '1 day')", [sam.userId, room]), /permission denied/);
    const privileges = await sql<{ anon: boolean; agent: boolean }>("select has_table_privilege('anon', 'crm.chat_scheduled', 'select') as anon, has_table_privilege('crm_agent', 'crm.chat_scheduled', 'select') as agent");
    assert.deepEqual(privileges[0], { anon: false, agent: false });
    await assert.rejects(queryAsUser(sam.userId, "select private.chat_schedule_cancel($1, $2)", [sam.userId, item.id]), /permission denied/);
  });

  it("counts a person's scheduled messages in their sidebar", async () => {
    assert.equal((await listConversations(sam)).scheduled, 0);
    await schedule(sam, room, "One");
    await schedule(sam, room, "Two");
    assert.equal((await listConversations(sam)).scheduled, 2);
    assert.equal((await listConversations(mark)).scheduled, 0);
  });

  it("refuses a time that isn't in the next year, an empty message, a stranger's room and a discussion", async () => {
    await refused(schedule(sam, room, "Late", { at: Date.now() - 1000 }), /Pick a time in the future\./);
    await refused(schedule(sam, room, "Far", { at: Date.now() + 366 * 24 * HOUR }), /within the next year/);
    await refused(schedule(sam, room, "   "), /Write a message first\./);
    await refused(schedule(priya, room, "Hello"), /Conversation not found\./);
    await refused(schedule(olly, room, "Hello"), /Conversation not found\./);
    await refused(scheduleMessage(sam, { id: randomUUID(), conversationId: room, body: "Hello" }), /Pick a time in the future\./);
    await refused(scheduleMessage(sam, { id: randomUUID(), conversationId: room, body: "Hello", sendAt: "not a date" }), /Pick a time in the future\./);
    await refused(schedule(sam, room, "Reply", { parentId: randomUUID() }), /The thread was deleted\./);
    const task = (await createTask(mark, { title: "Chase Halden", companyId, ownerId: sam.userId })).body.task;
    const { conversationId } = await openDiscussion(sam, { kind: "task", id: task.id });
    await refused(schedule(sam, conversationId, "Later"), /Only rooms and direct messages can send later\./);
    assert.deepEqual((await sql("select 1 from crm.chat_scheduled where conversation_id = $1", [conversationId])), []);
    await setRoomArchived(mark, room, true);
    await refused(schedule(sam, room, "Archived"), /This room is archived\./);
  });

  it("refuses @room in a thread or a direct message when scheduling, as it would when sending", async () => {
    const root = (await postMessage(mark, { conversationId: room, body: "Root", format: "markdown", clientKey: randomUUID() })).message;
    const roomMention = "@room";
    await refused(schedule(sam, room, `${roomMention} standup`, { parentId: root.id }), /@room only works in the main room\./);
    const dm = await openDm(sam, mark.userId);
    await refused(schedule(sam, dm.id, `${roomMention} standup`), /@room only works in rooms\./);
    assert.equal((await schedule(sam, room, `${roomMention} standup`)).body, "@room standup");
  });

  it("holds at most 100 scheduled messages a person, and a repeated key schedules once", async () => {
    const id = randomUUID();
    const first = await scheduleMessage(sam, { id, conversationId: room, body: "Once", sendAt: new Date(Date.now() + HOUR).toISOString() });
    const again = await scheduleMessage(sam, { id, conversationId: room, body: "Once", sendAt: new Date(Date.now() + 2 * HOUR).toISOString() });
    assert.deepEqual([first.duplicate, again.duplicate, again.item.sendAt === first.item.sendAt], [false, true, true]);
    assert.equal((await sql("select 1 from crm.chat_scheduled where id = $1", [id])).length, 1);
    await refused(scheduleMessage(mark, { id, conversationId: room, body: "Mine now", sendAt: new Date(Date.now() + HOUR).toISOString() }), /already used/);
    await sql(
      "insert into crm.chat_scheduled (user_id, conversation_id, body, send_at) select $1, $2, 'filler ' || n, now() + interval '1 day' from generate_series(1, 99) n",
      [sam.userId, room],
    );
    assert.equal((await sql("select 1 from crm.chat_scheduled where user_id = $1", [sam.userId])).length, 100);
    await refused(schedule(sam, room, "One too many"), /Send or delete some first\./);
    assert.equal((await listConversations(sam)).scheduled, 100);
  });

  it("posts a due message once through the normal path, keyed by its id, and leaves later ones alone", async () => {
    const dueItem = await schedule(sam, room, "Pricing goes live today");
    const later = await schedule(sam, room, "Not yet");
    await makeDue(dueItem.id);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 1, failed: 0, retried: 0 });
    const sent = await messagesWithKey(dueItem.id);
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].body, sent[0].conversation_id, sent[0].parent_id], ["Pricing goes live today", room, null]);
    assert.equal(await row(dueItem.id), null);
    assert.ok(await row(later.id));
    assert.deepEqual((await listMessages(mark, room)).messages.map((message) => message.body), ["Pricing goes live today"]);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 0, failed: 0, retried: 0 });
    await chatWorkSettled();
    assert.ok(broadcasts.some((event) => event.topic === personTopic(mark.userId) && JSON.stringify(event.payload).includes("Pricing goes live today")));
    assert.equal((await noticesFor(sam)).length, 0);
  });

  it("posts a scheduled reply into its thread", async () => {
    const root = (await postMessage(mark, { conversationId: room, body: "Root", format: "markdown", clientKey: randomUUID() })).message;
    const item = await schedule(sam, room, "Replying later", { parentId: root.id });
    assert.equal(item.parentId, root.id);
    await makeDue(item.id);
    await processDueScheduled({ fetchImpl: env.fetchImpl });
    const reply = (await messagesWithKey(item.id))[0];
    assert.equal(reply.parent_id, root.id);
    assert.equal((await sql<{ reply_count: number }>("select reply_count from crm.chat_messages where id = $1", [root.id]))[0].reply_count, 1);
  });

  it("posts each message once when several cron runs overlap", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const item = await schedule(index % 2 ? sam : mark, room, `Message ${index}`);
      await makeDue(item.id, 60 - index);
      ids.push(item.id);
    }
    const runs = await Promise.all([processDueScheduled({ fetchImpl: env.fetchImpl }), processDueScheduled({ fetchImpl: env.fetchImpl }), processDueScheduled({ fetchImpl: env.fetchImpl })]);
    assert.equal(runs.reduce((total, run) => total + run.sent, 0), 8);
    assert.equal(runs.reduce((total, run) => total + run.failed + run.retried, 0), 0);
    for (const id of ids) assert.equal((await messagesWithKey(id)).length, 1);
    assert.equal((await sql("select 1 from crm.chat_scheduled")).length, 0);
    assert.equal((await sql("select 1 from crm.chat_messages where conversation_id = $1", [room])).length, 8);
  });

  it("does not let a second run take a message another run is sending", async () => {
    const item = await schedule(sam, room, "Mine");
    await makeDue(item.id);
    const claimed = await claimDue();
    assert.equal(claimed.id, item.id);
    assert.equal(await claimDue(), undefined);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 0, failed: 0, retried: 0 });
    assert.equal((await messagesWithKey(item.id)).length, 0);
    await makeStale(item.id);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 1, failed: 0, retried: 0 });
    assert.equal((await messagesWithKey(item.id)).length, 1);
    assert.equal(await claimDue(), undefined);
  });

  it("posts nothing twice when a run died after posting but before it recorded the send", async () => {
    const item = await schedule(sam, room, "Posted by a run that died");
    await makeDue(item.id);
    const claimed = await claimDue();
    await postMessage(sam, { conversationId: room, body: item.body, format: "markdown", clientKey: item.id });
    assert.ok(claimed);
    await makeStale(item.id);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 1, failed: 0, retried: 0 });
    assert.equal((await messagesWithKey(item.id)).length, 1);
    assert.equal(await row(item.id), null);
    assert.equal((await noticesFor(sam)).length, 0);
  });

  it("does not report a failure when the sender left after the send but before it was recorded", async () => {
    const item = await schedule(sam, room, "Sent, then left");
    await makeDue(item.id);
    await claimDue();
    await postMessage(sam, { conversationId: room, body: item.body, format: "markdown", clientKey: item.id });
    await removeRoomMember(mark, room, sam.userId);
    await makeStale(item.id);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 1, failed: 0, retried: 0 });
    assert.equal((await messagesWithKey(item.id)).length, 1);
    assert.equal(await row(item.id), null);
    assert.equal((await noticesFor(sam)).length, 0);
  });

  it("sends a message again from the start when a run died before posting", async () => {
    const item = await schedule(sam, room, "Never posted");
    await makeDue(item.id);
    await claimDue();
    await makeStale(item.id);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 1, failed: 0, retried: 0 });
    assert.equal((await messagesWithKey(item.id)).length, 1);
  });

  it("claims a schedule's files exactly once, even when the run is retried after posting", async () => {
    const files = await upload(sam, room, ["a.pdf", "b.pdf"]);
    const item = await schedule(sam, room, "With files", { files });
    await makeDue(item.id);
    const claimed = await claimDue();
    await postMessage(sam, { conversationId: room, body: item.body, format: "markdown", clientKey: item.id, attachmentIds: files }, { fetchImpl: env.fetchImpl });
    assert.ok(claimed);
    await makeStale(item.id);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 1, failed: 0, retried: 0 });
    const message = (await messagesWithKey(item.id))[0];
    assert.equal(message.attachment_count, 2);
    const stored = await sql<{ id: string; message_id: string }>("select id, message_id from crm.chat_attachments where scheduled_id = $1 order by id", [item.id]);
    assert.deepEqual(stored.map((file) => file.message_id), [message.id, message.id]);
    assert.deepEqual(await sql("select path from private.storage_tombstones"), []);
    assert.match(await chatFileLink(mark, files[0], {}, env.fetchImpl), /object\/sign/);
  });

  it("accepts a schedule's files only while that schedule is being sent", async () => {
    const files = await upload(sam, room, ["held.pdf"]);
    const item = await schedule(sam, room, "Held", { files });
    await refused(postMessage(sam, { conversationId: room, body: "Sneaky", clientKey: randomUUID(), attachmentIds: files }, { fetchImpl: env.fetchImpl }), /file has expired/);
    await refused(postMessage(sam, { conversationId: room, body: "Sneakier", clientKey: item.id, attachmentIds: files }, { fetchImpl: env.fetchImpl }), /file has expired/);
    assert.equal((await messagesWithKey(item.id)).length, 0);
    await makeDue(item.id);
    await claimDue();
    await refused(postMessage(sam, { conversationId: room, body: "Wrong key", clientKey: randomUUID(), attachmentIds: files }, { fetchImpl: env.fetchImpl }), /file has expired/);
    await refused(postMessage(mark, { conversationId: room, body: "Someone else", clientKey: item.id, attachmentIds: files }, { fetchImpl: env.fetchImpl }), /A file has expired|not found/);
    assert.equal((await postMessage(sam, { conversationId: room, body: "Held", clientKey: item.id, attachmentIds: files }, { fetchImpl: env.fetchImpl })).message.attachments.length, 1);
  });

  it("keeps a schedule's files out of the daily sweep and out of reach until they are sent", async () => {
    const files = await upload(sam, room, ["later.pdf"]);
    const item = await schedule(sam, room, "", { files });
    await sql("update crm.chat_attachments set created_at = now() - interval '3 days' where id = any($1::uuid[])", [files]);
    assert.deepEqual(await sweepChatAttachments(env.fetchImpl), { stale: 0, removed: 0 });
    assert.equal((await sql("select 1 from crm.chat_attachments where id = $1", [files[0]])).length, 1);
    await refused(chatFileLink(mark, files[0], {}, env.fetchImpl), /File not found\./);
    assert.match(await chatFileLink(sam, files[0], {}, env.fetchImpl), /object\/sign/);
    await makeDue(item.id);
    await processDueScheduled({ fetchImpl: env.fetchImpl });
    assert.match(await chatFileLink(mark, files[0], {}, env.fetchImpl), /object\/sign/);
    const message = (await messagesWithKey(item.id))[0];
    assert.equal(message.body, "");
    assert.equal(message.attachment_count, 1);
  });

  async function failsWith(setup: (item: { id: string }) => Promise<void>, reason: RegExp, options: { parent?: boolean } = {}) {
    const root = options.parent ? (await postMessage(mark, { conversationId: room, body: "Root", format: "markdown", clientKey: randomUUID() })).message : null;
    const item = await schedule(sam, room, SECRET, { parentId: root?.id ?? null });
    await makeDue(item.id);
    await setup({ id: item.id });
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 0, failed: 1, retried: 0 });
    const failed = await row(item.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.failure ?? "", reason);
    assert.equal((await messagesWithKey(item.id)).length, 0);
    const notices = await noticesFor(sam);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, "A scheduled message wasn't sent");
    assert.equal(notices[0].href, "/chat/scheduled");
    assert.equal(notices[0].source, "chat");
    assert.match(notices[0].body ?? "", reason);
    assert.ok(!JSON.stringify(notices).includes("Quarterly"));
    assert.ok(!JSON.stringify(await sql("select * from crm.push_log")).includes("Quarterly"));
    assert.deepEqual(await noticesFor(mark), []);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 0, failed: 0, retried: 0 });
    assert.equal((await noticesFor(sam)).length, 1);
    return { item, root };
  }

  it("fails a message, and tells its sender without its text, when the room was archived", async () => {
    await failsWith(async () => void (await setRoomArchived(mark, room, true)), /This room is archived\./);
  });

  it("fails a message when the sender left the room before it was due", async () => {
    await failsWith(async () => void (await removeRoomMember(mark, room, sam.userId)), /You're no longer in that conversation\./);
  });

  it("fails a reply when its thread was deleted before it was due", async () => {
    let rootId = "";
    const { root } = await failsWith(
      async () => {
        const found = await sql<{ id: string }>("select id from crm.chat_messages where conversation_id = $1 and parent_id is null and deleted_at is null", [room]);
        rootId = found[0].id;
        await deleteMessage(mark, rootId);
      },
      /The thread was deleted\./,
      { parent: true },
    );
    assert.equal(root?.id, rootId);
  });

  it("fails a message to a person who no longer shares a workspace", async () => {
    const dm = await openDm(sam, priya.userId);
    const item = await schedule(sam, dm.id, SECRET);
    await makeDue(item.id);
    await sql("delete from crm.profiles where id = $1", [priya.userId]);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 0, failed: 1, retried: 0 });
    assert.match((await row(item.id))?.failure ?? "", /no longer share a workspace/);
    assert.equal((await noticesFor(sam)).length, 1);
  });

  it("fails a message whose file went missing, and lets its sender remove the file and send the text", async () => {
    const files = await upload(sam, room, ["gone.pdf"]);
    const item = await schedule(sam, room, "Text and a file", { files });
    env.objects.delete(key(room, files[0]));
    await makeDue(item.id);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 0, failed: 1, retried: 0 });
    assert.match((await row(item.id))?.failure ?? "", /A file is missing/);
    const edited = await updateScheduled(sam, item.id, { removeAttachmentIds: files, sendAt: new Date(Date.now() + HOUR).toISOString() });
    assert.equal(edited.item.status, "pending");
    assert.deepEqual([edited.item.attachments.length, edited.item.failure], [0, null]);
    await makeDue(item.id);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 1, failed: 0, retried: 0 });
    assert.equal((await messagesWithKey(item.id))[0].body, "Text and a file");
  });

  it("lets a failed message be sent again once the room is back", async () => {
    const { item } = await failsWith(async () => void (await setRoomArchived(mark, room, true)), /archived/);
    await refused(updateScheduled(sam, item.id, { sendAt: new Date(Date.now() + HOUR).toISOString() }), /This room is archived\./);
    await setRoomArchived(mark, room, false);
    const edited = await updateScheduled(sam, item.id, { sendAt: new Date(Date.now() + HOUR).toISOString() });
    assert.deepEqual([edited.item.status, edited.item.failure], ["pending", null]);
    await makeDue(item.id);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 1, failed: 0, retried: 0 });
    assert.equal((await messagesWithKey(item.id)).length, 1);
  });

  it("retries a failure that isn't the sender's fault once a minute, and gives up with one notice after five", async () => {
    const files = await upload(sam, room, ["flaky.pdf"]);
    const item = await schedule(sam, room, "Flaky storage", { files });
    await makeDue(item.id);
    env.failChecks(true);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 0, failed: 0, retried: 1 });
      const waiting = await row(item.id);
      assert.deepEqual([waiting?.status, waiting?.attempts, waiting?.failure], ["pending", attempt, null]);
      assert.deepEqual(await noticesFor(sam), []);
    }
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 0, failed: 1, retried: 0 });
    const failed = await row(item.id);
    assert.deepEqual([failed?.status, failed?.failure], ["failed", "Couldn't send. Try again."]);
    assert.equal((await noticesFor(sam)).length, 1);
    env.failChecks(false);
    await updateScheduled(sam, item.id, { sendAt: new Date(Date.now() + HOUR).toISOString() });
    await makeDue(item.id);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 1, failed: 0, retried: 0 });
    assert.equal((await messagesWithKey(item.id)).length, 1);
  });

  it("tries a retrying message once per run, so one bad message can't use up its attempts in a minute", async () => {
    const files = await upload(sam, room, ["flaky.pdf"]);
    const item = await schedule(sam, room, "Once a run", { files });
    await makeDue(item.id);
    env.failChecks(true);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 0, failed: 0, retried: 1 });
    assert.equal((await row(item.id))?.attempts, 1);
  });

  it("sends a scheduled message now, once, and keeps its time out of the way", async () => {
    const files = await upload(sam, room, ["now.pdf"]);
    const item = await schedule(sam, room, "Send me now", { files });
    const result = await sendScheduledNow(sam, item.id, { fetchImpl: env.fetchImpl });
    assert.equal(result.post?.message.body, "Send me now");
    assert.equal(result.post?.message.attachments.length, 1);
    assert.equal(await row(item.id), null);
    assert.equal((await messagesWithKey(item.id)).length, 1);
    await refused(sendScheduledNow(sam, item.id, { fetchImpl: env.fetchImpl }), /no longer scheduled/);
    assert.equal((await messagesWithKey(item.id)).length, 1);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 0, failed: 0, retried: 0 });
  });

  it("sends again from Scheduled when a message failed, and reports a failure to the person who asked", async () => {
    const item = await schedule(sam, room, "Not going anywhere");
    await setRoomArchived(mark, room, true);
    await refused(sendScheduledNow(sam, item.id, { fetchImpl: env.fetchImpl }), /This room is archived\./);
    const failed = await row(item.id);
    assert.deepEqual([failed?.status, failed?.failure], ["failed", "This room is archived."]);
    assert.deepEqual(await noticesFor(sam), []);
    await setRoomArchived(mark, room, false);
    await sendScheduledNow(sam, item.id, { fetchImpl: env.fetchImpl });
    assert.equal((await messagesWithKey(item.id)).length, 1);
  });

  it("leaves a message scheduled when sending it now hits a temporary fault", async () => {
    const files = await upload(sam, room, ["flaky.pdf"]);
    const item = await schedule(sam, room, "Flaky now", { files });
    env.failChecks(true);
    await assert.rejects(sendScheduledNow(sam, item.id, { fetchImpl: env.fetchImpl }), (error: unknown) => error instanceof CrmError && error.status === 502);
    const waiting = await row(item.id);
    assert.deepEqual([waiting?.status, waiting?.attempts], ["pending", 1]);
    env.failChecks(false);
    await sendScheduledNow(sam, item.id, { fetchImpl: env.fetchImpl });
    assert.equal((await messagesWithKey(item.id)).length, 1);
  });

  it("refuses to edit, cancel or send a message while a run is sending it, and the original is what posts", async () => {
    const item = await schedule(sam, room, "As scheduled");
    await makeDue(item.id);
    const claimed = await claimDue();
    await refused(updateScheduled(sam, item.id, { body: "Changed my mind" }), /being sent now/);
    await refused(cancelScheduled(sam, item.id), /being sent now/);
    await refused(sendScheduledNow(sam, item.id, { fetchImpl: env.fetchImpl }), /being sent now/);
    assert.ok(claimed);
    const result = await deliverScheduled(claimed, {});
    assert.equal(result.outcome, "sent");
    assert.equal((await messagesWithKey(item.id))[0].body, "As scheduled");
    assert.equal(await row(item.id), null);
  });

  it("lets a stale claim be edited or cancelled, and ignores the dead run's late result", async () => {
    const item = await schedule(sam, room, "First draft");
    await makeDue(item.id);
    const dead = await claimDue();
    await makeStale(item.id);
    await updateScheduled(sam, item.id, { body: "Second draft", sendAt: new Date(Date.now() + HOUR).toISOString() });
    const edited = await row(item.id);
    assert.deepEqual([edited?.status, edited?.attempts, edited?.body], ["pending", 0, "Second draft"]);
    const late = await query<{ posted: boolean }>("select private.chat_schedule_posted($1, $2) as posted", [item.id, dead.claim_token]);
    assert.equal(late.rows[0].posted, false);
    assert.equal((await query<{ done: boolean }>("select private.chat_schedule_done($1, $2) as done", [item.id, dead.claim_token])).rows[0].done, false);
    assert.equal((await query("select * from private.chat_schedule_release($1, $2, 'No')", [item.id, dead.claim_token])).rowCount, 0);
    assert.ok(await row(item.id));
    await makeDue(item.id);
    await processDueScheduled({ fetchImpl: env.fetchImpl });
    assert.equal((await messagesWithKey(item.id))[0].body, "Second draft");
  });

  it("edits the text, the time and the files of a message that hasn't been claimed", async () => {
    const files = await upload(sam, room, ["keep.pdf", "drop.pdf"]);
    const item = await schedule(sam, room, "Original", { files });
    const at = new Date(Date.now() + 5 * HOUR).toISOString();
    const { item: edited } = await updateScheduled(sam, item.id, { body: "Edited", sendAt: at, removeAttachmentIds: [files[1]] });
    assert.deepEqual([edited.body, edited.sendAt, edited.attachments.map((file) => file.name)], ["Edited", at, ["keep.pdf"]]);
    assert.deepEqual((await sql<{ path: string }>("select path from private.storage_tombstones")).map((entry) => entry.path), [key(room, files[1])]);
    await refused(updateScheduled(sam, item.id, { body: "  ", removeAttachmentIds: [files[0]] }), /Write a message first\./);
    const onlyFile = await schedule(sam, room, "", { files: await upload(sam, room, ["alone.pdf"]) });
    await refused(updateScheduled(sam, onlyFile.id, { removeAttachmentIds: [onlyFile.attachments[0].id] }), /Delete the scheduled message instead\./);
    assert.equal((await row(onlyFile.id))?.attachment_ids.length, 1);
    await refused(updateScheduled(sam, item.id, { sendAt: new Date(Date.now() - 1000).toISOString() }), /Pick a time in the future\./);
    await refused(updateScheduled(sam, "nope", { body: "x" }), /not found/i);
    assert.equal((await row(item.id))?.body, "Edited");
    await makeDue(item.id);
    await processDueScheduled({ fetchImpl: env.fetchImpl });
    const posted = (await messagesWithKey(item.id))[0];
    assert.deepEqual([posted.body, posted.attachment_count], ["Edited", 1]);
  });

  it("cancels a message and deletes its files, tombstoned for removal from storage", async () => {
    const files = await upload(sam, room, ["a.pdf", "b.pdf"]);
    const item = await schedule(sam, room, "Never mind", { files });
    assert.deepEqual(await cancelScheduled(sam, item.id), { cancelled: true });
    assert.equal(await row(item.id), null);
    assert.deepEqual(await sql("select id from crm.chat_attachments where id = any($1::uuid[])", [files]), []);
    assert.deepEqual((await sql<{ path: string }>("select path from private.storage_tombstones order by path")).map((entry) => entry.path).sort(), files.map((id) => key(room, id)).sort());
    assert.equal(await drainStorageTombstones(env.fetchImpl), 2);
    assert.deepEqual(env.removed.sort(), files.map((id) => key(room, id)).sort());
    assert.deepEqual(await cancelScheduled(sam, item.id), { cancelled: false });
  });

  it("deletes a schedule's files with their room, and sweeps failed schedules after thirty days", async () => {
    const files = await upload(sam, room, ["room.pdf"]);
    await schedule(sam, room, "With the room", { files });
    await sql("delete from crm.chat_conversations where id = $1", [room]);
    assert.equal((await sql("select 1 from crm.chat_scheduled")).length, 0);
    assert.deepEqual((await sql<{ path: string }>("select path from private.storage_tombstones")).map((entry) => entry.path), [key(room, files[0])]);
    await sql("truncate private.storage_tombstones");
    const other = (await createRoom(mark, { name: `sweep-${randomUUID().slice(0, 8)}`, memberIds: [sam.userId] })).id;
    const kept = await upload(sam, other, ["old.pdf"]);
    const old = await schedule(sam, other, "Old failure", { files: kept });
    const recent = await schedule(sam, other, "Recent failure");
    const waiting = await schedule(sam, other, "Still waiting");
    await sql("update crm.chat_scheduled set status = 'failed', failure = 'This room is archived.', updated_at = now() - interval '31 days' where id = $1", [old.id]);
    await sql("update crm.chat_scheduled set status = 'failed', failure = 'This room is archived.', updated_at = now() - interval '2 days' where id = $1", [recent.id]);
    await sql("update crm.chat_scheduled set updated_at = now() - interval '90 days' where id = $1", [waiting.id]);
    assert.equal(await sweepScheduled(), 1);
    assert.equal(await row(old.id), null);
    assert.ok(await row(recent.id));
    assert.ok(await row(waiting.id));
    assert.deepEqual((await sql<{ path: string }>("select path from private.storage_tombstones")).map((entry) => entry.path), [key(other, kept[0])]);
  });

  it("leaves the sender's unread state alone when a scheduled message is posted, top level and in a thread", async () => {
    const root = (await postMessage(sam, { conversationId: room, body: "Root by Sam", format: "markdown", clientKey: randomUUID() })).message;
    const top = await schedule(sam, room, "Scheduled top level");
    const reply = await schedule(sam, room, "Scheduled reply", { parentId: root.id });
    await postMessage(mark, { conversationId: room, body: "Overnight message", format: "markdown", clientKey: randomUUID() });
    await postMessage(mark, { conversationId: room, parentId: root.id, body: "Overnight reply", format: "markdown", clientKey: randomUUID() });
    const before = await listConversations(sam);
    const readBefore = (await sql<{ last_read_at: Date }>("select last_read_at from crm.chat_members where conversation_id = $1 and user_id = $2", [room, sam.userId]))[0].last_read_at;
    const threadBefore = (await sql<{ last_read_at: Date }>("select last_read_at from crm.chat_thread_reads where message_id = $1 and user_id = $2", [root.id, sam.userId]))[0].last_read_at;
    assert.deepEqual([before.conversations.find((entry) => entry.id === room)?.unread, before.threads.unread], [1, 1]);
    await makeDue(top.id, 20);
    await makeDue(reply.id, 10);
    assert.deepEqual(await processDueScheduled({ fetchImpl: env.fetchImpl }), { sent: 2, failed: 0, retried: 0 });
    const after = await listConversations(sam);
    assert.deepEqual([after.conversations.find((entry) => entry.id === room)?.unread, after.threads.unread], [1, 1]);
    assert.deepEqual(
      (await sql<{ last_read_at: Date }>("select last_read_at from crm.chat_members where conversation_id = $1 and user_id = $2", [room, sam.userId]))[0].last_read_at,
      readBefore,
    );
    assert.deepEqual(
      (await sql<{ last_read_at: Date }>("select last_read_at from crm.chat_thread_reads where message_id = $1 and user_id = $2", [root.id, sam.userId]))[0].last_read_at,
      threadBefore,
    );
    await postMessage(sam, { conversationId: room, parentId: root.id, body: "Sent by hand", format: "markdown", clientKey: randomUUID() });
    assert.equal((await listConversations(sam)).threads.unread, 0);
  });

  it("tells the owner live, without content, when a run marks a message failed", async () => {
    const item = await schedule(sam, room, SECRET);
    await makeDue(item.id);
    await setRoomArchived(mark, room, true);
    await processDueScheduled({ fetchImpl: env.fetchImpl });
    await chatWorkSettled();
    const events = broadcasts.filter((event) => event.topic === personTopic(sam.userId) && (event.payload as { type?: string }).type === "scheduled");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload, { type: "scheduled", conversationId: room });
    assert.ok(!JSON.stringify(broadcasts).includes("Quarterly"));
  });

  it("runs from the every-minute cron", async () => {
    const item = await schedule(sam, room, "From the cron");
    await makeDue(item.id);
    const { GET } = await import("@/app/api/cron/mail-due/route");
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-secret-value";
    try {
      const response = await GET(new Request("https://orbit.example.com/api/cron/mail-due", { headers: { authorization: "Bearer cron-secret-value" } }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as { scheduled: { sent: number } };
      assert.equal(body.scheduled.sent, 1);
      assert.equal((await messagesWithKey(item.id)).length, 1);
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });
});
