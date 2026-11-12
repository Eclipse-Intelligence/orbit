import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import * as Y from "yjs";
import { chatWorkSettled } from "@/lib/crm/chat";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox } from "@/lib/crm/inbox";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { draftTopic, parseTopic, canonicalTopic } from "@/lib/docs/live/protocol";
import { bind } from "@/lib/docs/live/binding";
import { relayAllows } from "@/lib/docs/live/relay-access";
import { LiveSession, type LiveServer, type SessionTiming } from "@/lib/docs/live/session";
import { memoryHub } from "@/lib/docs/live/transport";
import { createLiveDoc, liveText } from "@/lib/docs/live/ydoc";
import {
  cancelScheduledDraft,
  claimDueDrafts,
  discardMailDraft,
  dueDraftInput,
  failDueDraft,
  readDraftInput,
  saveMailDraft,
  scheduleMailDraft,
  sendForAgent,
  sendMailDraft,
  sendMailOnce,
} from "@/lib/mail/compose";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { draftPresence, LiveDraft, liveDraftCovered, liveHandBack, settleForSend, type LiveDraftSummary } from "@/lib/mail/live-draft-client";
import { liveDraftResponse } from "@/lib/mail/live-draft-http";
import { SHARED_DRAFT_CHANGED } from "@/lib/mail/share-view";
import { teammateText } from "@/lib/mail/shared-text";
import { openLiveDraft, syncLiveDraft } from "@/lib/mail/live-draft";
import { getSharedDraft, holdSharedDraft, saveSharedDraft, shareDraft } from "@/lib/mail/shared-drafts";
import { removeFromShare, shareThread } from "@/lib/mail/shares";
import { listThreads } from "@/lib/mail/threads";
import { syncMail } from "@/lib/mail/sync";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ORIGIN = "https://orbit.test";

type Call = { method: string; url: string; body: Record<string, unknown> | null };

let draftCount = 0;

function outlook() {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
    if (method !== "GET") {
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "POST" && url === `${GRAPH}/me/messages`) {
        draftCount += 1;
        return Response.json({ id: `live-draft-${draftCount}`, conversationId: `live-conv-${draftCount}`, subject: "" }, { status: 201 });
      }
      if (/\/(createReply|createReplyAll|createForward)$/.test(url)) {
        draftCount += 1;
        return Response.json({ id: `live-draft-${draftCount}`, subject: "RE: Renewal pricing", body: { contentType: "html", content: "<html><body><div>quoted</div></body></html>" } }, { status: 201 });
      }
      if (url.endsWith("/send")) return new Response(null, { status: 202 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id });
    }
    if (id && url.includes("internetMessageId")) return Response.json({ id, internetMessageId: `<${id}@mail.test>` });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    return Response.json({ value: folder === "f-inbox" ? [inboxMessage] : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder ?? "x"}/messages/delta?$deltatoken=${Date.now()}` });
  };
  return { fetchImpl, calls };
}

const inboxMessage = {
  id: "m-live-1",
  internetMessageId: "<m-live-1@mail.test>",
  conversationId: "conv-live",
  subject: "Renewal pricing",
  bodyPreview: "Can we talk about the renewal price?",
  body: { contentType: "html", content: "<p>Can we talk about the renewal price?</p>" },
  from: { emailAddress: { name: "Tom Becker", address: "tom@halden.test" } },
  toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
  ccRecipients: [],
  bccRecipients: [],
  sentDateTime: "2026-10-01T09:00:00Z",
  receivedDateTime: "2026-10-01T09:00:05Z",
  isRead: true,
  isDraft: false,
  flag: { flagStatus: "notFlagged" },
  importance: "normal",
  hasAttachments: false,
  categories: [],
  webLink: "https://outlook.office.com/mail/m-live-1",
};

function lastPatchBefore(calls: Call[], suffix: string) {
  const sendAt = calls.findIndex((call) => call.url.endsWith(suffix));
  const patches = calls.slice(0, sendAt === -1 ? calls.length : sendAt).filter((call) => call.method === "PATCH");
  return patches.at(-1)?.body as { subject: string; body: { content: string } } | undefined;
}

function sent(calls: Call[]) {
  return calls.some((call) => call.url.endsWith("/send"));
}

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let sourceId: string;
let broadcasts: LiveMessage[];

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function refused(work: Promise<unknown>, pattern: RegExp, status?: number) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message) && (status === undefined || error.status === status));
}

function fresh(subject: string, body: string) {
  return readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject, body });
}

async function sharedNew(subject: string, body: string, people: string[] = [sam.userId]) {
  const draft = await saveMailDraft(mark, fresh(subject, body), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
  const shared = await shareDraft(mark, draft.id, people);
  return { draft, shareId: shared.shareId };
}

type Client = { doc: Y.Doc; generation: number; server: Uint8Array };

async function client(actor: UserActor, shareId: string): Promise<Client> {
  const opened = await openLiveDraft(actor, shareId);
  const doc = createLiveDoc(opened.state);
  return { doc, generation: opened.generation, server: Y.encodeStateVector(doc) };
}

async function push(actor: UserActor, shareId: string, from: Client) {
  const reply = await syncLiveDraft(actor, shareId, { update: Y.encodeStateAsUpdate(from.doc, from.server), vector: Y.encodeStateVector(from.doc), generation: from.generation });
  if (!reply.rebuilt) {
    Y.applyUpdate(from.doc, reply.missing);
    from.server = reply.vector;
  }
  return reply;
}

function text(from: Client) {
  return liveText(from.doc).toString();
}

function type(from: Client, at: number | "end", insert: string) {
  const body = liveText(from.doc);
  body.insert(at === "end" ? body.length : at, insert);
}

async function rowBody(shareId: string) {
  return (await sql<{ body: string }>("select d.body from crm.mail_shares s join crm.mail_drafts d on d.id = s.draft_id where s.id = $1", [shareId]))[0]?.body ?? null;
}

async function liveRow(shareId: string) {
  return (await sql<{ ydoc: Buffer | null; generation: number }>("select ydoc, generation from crm.mail_share_live where share_id = $1", [shareId]))[0] ?? null;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@eclipse.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@eclipse.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@eclipse.test", "Priya Nair"), "member");
  await saveMailbox(mark, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  await syncMail(mark, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
  sourceId = (await sql<{ id: string }>("select id from crm.mail_sources where user_id = $1", [mark.userId]))[0].id;
});

beforeEach(async () => {
  await chatWorkSettled();
  broadcasts = [];
  setLiveTesting({ batch: async (messages) => void broadcasts.push(...messages) });
});

after(async () => {
  await chatWorkSettled();
  setLiveTesting(null);
  await getPool().end();
  await getAdminPool().end();
});

describe("live body", () => {
  it("opens with the draft's text and keeps both people's concurrent edits", async () => {
    const { shareId } = await sharedNew("Pricing", "The fee is 500.");
    const owner = await client(mark, shareId);
    const teammate = await client(sam, shareId);
    assert.equal(text(owner), "The fee is 500.");
    assert.equal(owner.generation, 0);
    const before = (await getSharedDraft(sam, shareId)).version;
    type(owner, 0, "Hi Tom. ");
    type(teammate, "end", " Thanks, Sam");
    await push(mark, shareId, owner);
    await push(sam, shareId, teammate);
    await push(mark, shareId, owner);
    assert.equal(text(owner), "Hi Tom. The fee is 500. Thanks, Sam");
    assert.equal(text(teammate), text(owner));
    assert.equal(await rowBody(shareId), "Hi Tom. The fee is 500. Thanks, Sam");
    const seen = await getSharedDraft(sam, shareId);
    assert.equal(seen.body, "Hi Tom. The fee is 500. Thanks, Sam");
    assert.ok(seen.version > before);
    const stored = await liveRow(shareId);
    assert.ok(stored?.ydoc && stored.ydoc.length > 0);
  });

  it("never touches the content hash, and a read only sync doesn't bump the version", async () => {
    const { draft, shareId } = await sharedNew("Hash", "Body");
    const hash = (await sql<{ content_hash: string }>("select content_hash from crm.mail_drafts where id = $1", [draft.id]))[0].content_hash;
    const teammate = await client(sam, shareId);
    type(teammate, "end", " and more");
    await push(sam, shareId, teammate);
    assert.equal((await sql<{ content_hash: string }>("select content_hash from crm.mail_drafts where id = $1", [draft.id]))[0].content_hash, hash);
    const version = (await getSharedDraft(sam, shareId)).version;
    await push(sam, shareId, teammate);
    assert.equal((await getSharedDraft(sam, shareId)).version, version);
  });

  it("refuses a body over 20,000 characters and keeps the stored text", async () => {
    const { shareId } = await sharedNew("Long", "Short");
    const teammate = await client(sam, shareId);
    type(teammate, "end", "x".repeat(20_001));
    await refused(push(sam, shareId, teammate), /under 20,000 characters/, 413);
    assert.equal(await rowBody(shareId), "Short");
  });

  it("refuses an update that isn't plain text", async () => {
    const { shareId } = await sharedNew("Odd", "Plain");
    const teammate = await client(sam, shareId);
    teammate.doc.getMap("other").set("x", 1);
    await refused(push(sam, shareId, teammate), /wasn't saved/, 400);
    assert.equal(await rowBody(shareId), "Plain");
  });
});

describe("locks", () => {
  it("refuses a teammate's edit while held to send, takes the owner's, and reopens on Undo", async () => {
    const { draft, shareId } = await sharedNew("Hold", "Held text");
    const teammate = await client(sam, shareId);
    const owner = await client(mark, shareId);
    await holdSharedDraft(mark, draft.id, true);
    type(teammate, "end", " late");
    await refused(push(sam, shareId, teammate), /^Mark is sending\. Read only\.$/, 409);
    const quiet = await syncLiveDraft(sam, shareId, { update: null, vector: Y.encodeStateVector(teammate.doc), generation: teammate.generation });
    assert.equal(quiet.locked, "Mark is sending. Read only.");
    type(owner, "end", ", signed");
    await push(mark, shareId, owner);
    assert.equal(await rowBody(shareId), "Held text, signed");
    await holdSharedDraft(mark, draft.id, false);
    await push(sam, shareId, teammate);
    assert.ok(["Held text, signed late", "Held text late, signed"].includes((await rowBody(shareId)) ?? ""));
  });

  it("stays read only for teammates while scheduled or failed, but the owner can still edit a scheduled draft", async () => {
    const { draft, shareId } = await sharedNew("Later", "Scheduled text");
    const teammate = await client(sam, shareId);
    const owner = await client(mark, shareId);
    await scheduleMailDraft(mark, { ...fresh("Later", "ignored"), id: draft.id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    type(teammate, 0, "Sam: ");
    await refused(push(sam, shareId, teammate), /^Scheduled\. Read only until Mark unschedules it\.$/, 409);
    type(owner, "end", " by Mark");
    await push(mark, shareId, owner);
    assert.equal(await rowBody(shareId), "Scheduled text by Mark");
    await failDueDraft(mark, draft.id, "Outlook refused.");
    await refused(push(sam, shareId, teammate), /^Couldn't send\. Read only until Mark unschedules it\.$/, 409);
    await cancelScheduledDraft(mark, draft.id);
    await push(sam, shareId, teammate);
    assert.equal(await rowBody(shareId), "Sam: Scheduled text by Mark");
  });

  it("refuses everyone's edits once a send has claimed the draft", async () => {
    const { draft, shareId } = await sharedNew("Claimed", "Claimed text");
    const teammate = await client(sam, shareId);
    const owner = await client(mark, shareId);
    await sql("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [draft.id]);
    const [due] = await claimDueDrafts(mark, 1);
    assert.equal(due.id, draft.id);
    type(owner, "end", " owner");
    type(teammate, "end", " teammate");
    await refused(push(mark, shareId, owner), /Mark is sending/, 409);
    await refused(push(sam, shareId, teammate), /Mark is sending/, 409);
    assert.equal(await rowBody(shareId), "Claimed text");
    await sql("update crm.mail_drafts set sending_at = null where id = $1", [draft.id]);
  });
});

describe("every send path carries the live text", () => {
  it("owner Send sends the live text, not the browser's copy", async () => {
    const { draft, shareId } = await sharedNew("Send", "Draft one");
    const teammate = await client(sam, shareId);
    type(teammate, "end", ", with Sam's line");
    await push(sam, shareId, teammate);
    const { fetchImpl, calls } = outlook();
    await sendMailDraft(mark, { ...fresh("Send", "Stale browser text"), id: draft.id }, { storedFiles: "keep", origin: ORIGIN, fetchImpl });
    assert.ok(sent(calls));
    assert.match(lastPatchBefore(calls, "/send")!.body.content, /Draft one, with Sam(&#39;|')s line/);
    assert.equal((await getSharedDraft(sam, shareId)).state, "sent");
    await refused(push(sam, shareId, teammate), /sent or discarded/, 404);
  });

  it("Undo reopens the draft, and the next Send carries edits made after it", async () => {
    const { draft, shareId } = await sharedNew("Undo", "Before undo");
    await holdSharedDraft(mark, draft.id, true);
    await holdSharedDraft(mark, draft.id, false);
    const teammate = await client(sam, shareId);
    type(teammate, "end", " and after");
    await push(sam, shareId, teammate);
    const { fetchImpl, calls } = outlook();
    await sendMailDraft(mark, { ...fresh("Undo", "Before undo"), id: draft.id }, { storedFiles: "keep", origin: ORIGIN, fetchImpl });
    assert.ok(lastPatchBefore(calls, "/send")!.body.content.includes("Before undo and after"));
  });

  it("a scheduled send carries the owner's live edits made while it waited", async () => {
    const { draft, shareId } = await sharedNew("Scheduled", "Wait for it");
    await scheduleMailDraft(mark, { ...fresh("Scheduled", "ignored"), id: draft.id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    const owner = await client(mark, shareId);
    type(owner, "end", ", now longer");
    await push(mark, shareId, owner);
    await sql("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [draft.id]);
    const [due] = await claimDueDrafts(mark, 1);
    const { fetchImpl, calls } = outlook();
    await sendMailDraft(mark, dueDraftInput(due), { storedFiles: "keep", origin: ORIGIN, fetchImpl, claimed: true });
    assert.ok(sent(calls));
    const patches = calls.filter((call) => call.method === "PATCH");
    assert.ok(patches.length > 0);
    assert.ok(patches.every((call) => JSON.stringify(call.body).includes("Wait for it, now longer")));
  });

  it("the assistant sends the live text and refuses a different body", async () => {
    const { draft, shareId } = await sharedNew("Assistant", "Agent start");
    const teammate = await client(sam, shareId);
    type(teammate, "end", " plus Sam");
    await push(sam, shareId, teammate);
    await refused(sendForAgent(mark, { draftId: draft.id, to: [], body: "Agent start" }, { origin: ORIGIN, fetchImpl: outlook().fetchImpl }), /This draft is shared/);
    const { fetchImpl, calls } = outlook();
    await sendForAgent(mark, { draftId: draft.id, to: [], body: "Agent start plus Sam" }, { origin: ORIGIN, fetchImpl });
    assert.ok(lastPatchBefore(calls, "/send")!.body.content.includes("Agent start plus Sam"));
  });

  it("MCP mail_send with draft_id carries the live text", async () => {
    const { draft, shareId } = await sharedNew("MCP", "MCP start");
    const teammate = await client(sam, shareId);
    type(teammate, "end", ", edited live");
    await push(sam, shareId, teammate);
    const { fetchImpl, calls } = outlook();
    const result = await sendMailOnce(mark, { draftId: draft.id }, { origin: ORIGIN, fetchImpl });
    assert.equal(result.status, "sent");
    assert.ok(lastPatchBefore(calls, "/send")!.body.content.includes("MCP start, edited live"));
  });
});

describe("generations", () => {
  it("resets when the draft is discarded, and refuses to merge a stale client into a new draft", async () => {
    const { draft, shareId } = await sharedNew("Reset", "First draft");
    const teammate = await client(sam, shareId);
    type(teammate, "end", " typed");
    await push(sam, shareId, teammate);
    await discardMailDraft(mark, draft.id, outlook().fetchImpl);
    const reset = await liveRow(shareId);
    assert.equal(reset?.ydoc, null);
    assert.equal(reset?.generation, 1);
    await refused(push(sam, shareId, teammate), /sent or discarded/, 404);
  });

  it("resets when the draft row is deleted underneath the share", async () => {
    const { draft, shareId } = await sharedNew("Deleted", "Row");
    await client(sam, shareId);
    await push(sam, shareId, await client(sam, shareId));
    await sql("delete from crm.mail_drafts where id = $1", [draft.id]);
    assert.equal((await liveRow(shareId))?.generation, 1);
  });

  it("rebuilds an unreadable copy with a new generation and tells clients to pull", async () => {
    const { shareId } = await sharedNew("Broken", "Keep me");
    const teammate = await client(sam, shareId);
    type(teammate, "end", " and me");
    await push(sam, shareId, teammate);
    await sql("update crm.mail_share_live set ydoc = '\\x0102'::bytea where share_id = $1", [shareId]);
    type(teammate, "end", " stale");
    const reply = await push(sam, shareId, teammate);
    assert.equal(reply.rebuilt, true);
    assert.equal(reply.generation, 1);
    assert.equal(await rowBody(shareId), "Keep me and me");
    await chatWorkSettled();
    assert.ok(broadcasts.some((message) => message.topic === draftTopic(shareId) && message.event === "pull"));
    const again = await client(sam, shareId);
    assert.equal(again.generation, 1);
    assert.equal(text(again), "Keep me and me");
  });

  it("follows a text change made outside the live path without a new generation", async () => {
    const { shareId } = await sharedNew("Repair", "Original");
    const teammate = await client(sam, shareId);
    await saveSharedDraft(mark, shareId, { subject: null, body: "Changed elsewhere" });
    const reply = await push(sam, shareId, teammate);
    assert.equal(reply.rebuilt, false);
    assert.equal(text(teammate), "Changed elsewhere");
    assert.equal((await liveRow(shareId))?.generation, 0);
  });
});

describe("access", () => {
  it("refuses people outside the share and a removed member", async () => {
    const { shareId } = await sharedNew("Access", "Private", [sam.userId, priya.userId]);
    await refused(openLiveDraft({ ...priya, userId: "00000000-0000-4000-8000-000000000001" }, shareId), /no longer have access/, 404);
    const teammate = await client(sam, shareId);
    await removeFromShare(mark, shareId, sam.userId);
    type(teammate, "end", " still here?");
    await refused(push(sam, shareId, teammate), /^You no longer have access to this draft\.$/, 404);
    await refused(openLiveDraft(sam, "not-a-share"), /no longer have access/, 404);
    assert.equal(await rowBody(shareId), "Private");
  });

  it("parses the draft topic", () => {
    const id = "6F9619FF-8B86-4011-B42D-00C04FC964FF";
    assert.equal(draftTopic(id), "draft:6f9619ff-8b86-4011-b42d-00c04fc964ff");
    assert.deepEqual(parseTopic(draftTopic(id)), { kind: "draft", id: id.toLowerCase() });
    assert.equal(canonicalTopic(`draft:${id}`), draftTopic(id));
    assert.equal(parseTopic("draft:nope"), null);
  });

  it("lets the dev relay carry the topic only for the owner and members", async () => {
    const { shareId } = await sharedNew("Relay", "Relay text");
    const topic = draftTopic(shareId);
    assert.equal(await relayAllows(mark, topic, true), true);
    assert.equal(await relayAllows(sam, topic, true), true);
    assert.equal(await relayAllows(priya, topic, false), false);
    await removeFromShare(mark, shareId, sam.userId);
    assert.equal(await relayAllows(sam, topic, false), false);
  });

  describe("realtime policies", () => {
    before(async () => {
      const admin = getAdminPool();
      const exists = await admin.query<{ found: boolean }>("select to_regclass('realtime.messages') is not null as found");
      if (!exists.rows[0].found) await admin.query(readFileSync("supabase/bootstrap/local-realtime.sql", "utf8"));
      await admin.query(readFileSync("supabase/migrations/20270119100000_live_drafts.sql", "utf8"));
    });

    async function access(userId: string, topic: string) {
      const db = await getAdminPool().connect();
      try {
        await db.query("begin");
        await db.query("insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true)", [topic]);
        await db.query("select set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)", [
          JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" }),
          topic,
        ]);
        await db.query("set local role authenticated");
        const read = (await db.query("select id from realtime.messages where topic = $1 and extension = 'broadcast'", [topic])).rows.length > 0;
        await db.query("savepoint send");
        let write = true;
        try {
          await db.query("insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true)", [topic]);
        } catch {
          write = false;
          await db.query("rollback to savepoint send");
        }
        return { read, write };
      } finally {
        await db.query("rollback").catch(() => undefined);
        db.release();
      }
    }

    it("lets the owner and members join the draft topic, and refuses others and removed members", async () => {
      const { shareId } = await sharedNew("Topic", "Topic text", [sam.userId]);
      const topic = draftTopic(shareId);
      assert.deepEqual(await access(mark.userId, topic), { read: true, write: true });
      assert.deepEqual(await access(sam.userId, topic), { read: true, write: true });
      assert.deepEqual(await access(priya.userId, topic), { read: false, write: false });
      assert.deepEqual(await access(sam.userId, "draft:not-a-uuid"), { read: false, write: false });
      await removeFromShare(mark, shareId, sam.userId);
      assert.deepEqual(await access(sam.userId, topic), { read: false, write: false });
    });
  });
});

describe("unshared drafts", () => {
  it("keep no live copy and send the browser's text as before", async () => {
    const draft = await saveMailDraft(mark, fresh("Solo", "Solo first"), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    const { fetchImpl, calls } = outlook();
    await sendMailDraft(mark, { ...fresh("Solo", "Solo final"), id: draft.id }, { storedFiles: "keep", origin: ORIGIN, fetchImpl });
    assert.ok(lastPatchBefore(calls, "/send")!.body.content.includes("Solo final"));
    const kept = await sql<{ n: number }>("select count(*)::int as n from crm.mail_share_live l join crm.mail_shares s on s.id = l.share_id where s.draft_id = $1", [draft.id]);
    assert.equal(kept[0].n, 0);
  });
});

const FAST: Partial<SessionTiming> = {
  batchMs: 5,
  awarenessMs: 5,
  saveMs: 30,
  saveMaxMs: 80,
  ownMs: 150,
  titleMs: 20,
  heartbeatMs: 5_000,
  soloHeartbeatMs: 5_000,
  soloMaxMs: 5_000,
  retryMs: 40,
  connectMs: 200,
  hintMs: 5,
  hintGapMs: 20,
};

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 5_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

describe("live sessions on the draft topic", () => {
  const open: LiveSession<LiveDraftSummary>[] = [];

  afterEach(async () => {
    for (const session of open.splice(0)) await session.close({ save: false });
  });

  function server(actor: UserActor, shareId: string): LiveServer<LiveDraftSummary> {
    return {
      async sync(input) {
        const reply = await syncLiveDraft(actor, shareId, { update: input.update, vector: input.vector, generation: input.generation });
        return { vector: reply.vector, missing: reply.missing, revision: reply.version, generation: reply.generation, rebuilt: reply.rebuilt, summary: { version: reply.version, locked: reply.locked } };
      },
    };
  }

  async function session(actor: UserActor, shareId: string, transport: ReturnType<ReturnType<typeof memoryHub>["transport"]>) {
    const opened = await openLiveDraft(actor, shareId);
    const doc = createLiveDoc(opened.state);
    const live = new LiveSession<LiveDraftSummary>({
      pageId: shareId,
      topic: draftTopic(shareId),
      user: { id: actor.userId, name: actor.fullName ?? "Someone", kind: "person" },
      doc,
      serverVector: Y.encodeStateVector(doc),
      revision: opened.version,
      generation: opened.generation,
      title: "",
      transport,
      server: server(actor, shareId),
      timing: FAST,
    });
    live.start();
    open.push(live);
    return live;
  }

  it("merges two people typing at once, shows each other's cursor, and stores the merged body", async () => {
    const { shareId } = await sharedNew("Typing", "Middle");
    const hub = memoryHub();
    const owner = await session(mark, shareId, hub.transport());
    const teammate = await session(sam, shareId, hub.transport());
    await until(() => owner.status === "live" && teammate.status === "live", "both join");
    for (const letter of "Start ") owner.text.insert(owner.text.toString().indexOf("Middle"), letter);
    for (const letter of " end") teammate.text.insert(teammate.text.length, letter);
    owner.setCursor({ anchor: 2, head: 2 });
    await until(() => owner.text.toString() === "Start Middle end" && teammate.text.toString() === "Start Middle end", "texts converge");
    await owner.sync();
    await teammate.sync();
    await owner.sync();
    assert.equal(await rowBody(shareId), "Start Middle end");
    assert.ok(liveDraftCovered(owner) && liveDraftCovered(teammate));
    await until(() => draftPresence(teammate, sam.userId).some((entry) => entry.participant.id === mark.userId && entry.cursor === 2), "owner's cursor reaches the teammate");
    const seen = draftPresence(teammate, sam.userId).find((entry) => entry.participant.id === mark.userId)!;
    assert.equal(seen.participant.kind, "person");
  });

  it("forces remote people to show as people even when they claim to be the assistant", async () => {
    const { shareId } = await sharedNew("Spoof", "Text");
    const hub = memoryHub();
    const owner = await session(mark, shareId, hub.transport());
    const teammate = await session(sam, shareId, hub.transport());
    await until(() => owner.status === "live" && teammate.status === "live", "both join");
    owner.awareness.setLocalStateField("user", { id: "orbit-assistant", name: "Orbit assistant", kind: "assistant" });
    await until(() => draftPresence(teammate, sam.userId).some((entry) => entry.participant.name === "Orbit assistant"), "spoofed state arrives");
    assert.ok(draftPresence(teammate, sam.userId).every((entry) => entry.participant.kind === "person"));
  });
});

describe("review fixes", () => {
  it("keeps both edits when two syncs arrive at once", async () => {
    const { shareId } = await sharedNew("Race", "Middle");
    const owner = await client(mark, shareId);
    const teammate = await client(sam, shareId);
    type(owner, 0, "Start ");
    type(teammate, "end", " end");
    await Promise.all([push(mark, shareId, owner), push(sam, shareId, teammate)]);
    await push(mark, shareId, owner);
    assert.equal(await rowBody(shareId), "Start Middle end");
  });

  it("refuses a deletion while scheduled", async () => {
    const { draft, shareId } = await sharedNew("Delete", "Keep every word");
    const teammate = await client(sam, shareId);
    await scheduleMailDraft(mark, { ...fresh("Delete", "ignored"), id: draft.id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    liveText(teammate.doc).delete(4, 6);
    await refused(push(sam, shareId, teammate), /^Scheduled\. Read only until Mark unschedules it\.$/, 409);
    assert.equal(await rowBody(shareId), "Keep every word");
    await cancelScheduledDraft(mark, draft.id);
  });

  it("rebuilds a stale client when the share gains a new draft, and keeps the new draft's text", async () => {
    const thread = (await listThreads(mark, { view: { role: "inbox" } })).threads[0];
    const share = (await shareThread(mark, thread.key, [sam.userId])).share.shareId!;
    const reply = (body: string) => readDraftInput({ mode: "reply", messageId: thread.latestId, to: ["tom@halden.test"], subject: "RE: Renewal pricing", body });
    const first = await saveMailDraft(mark, reply("First reply"), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    await shareDraft(mark, first.id, []);
    const stale = await client(sam, share);
    await discardMailDraft(mark, first.id, outlook().fetchImpl);
    const second = await saveMailDraft(mark, reply("Second reply"), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    await shareDraft(mark, second.id, []);
    type(stale, "end", " from the old draft");
    const result = await push(sam, share, stale);
    assert.equal(result.rebuilt, true);
    assert.equal(await rowBody(share), "Second reply");
    assert.equal(textOfReply(result.missing), "Second reply");
    await discardMailDraft(mark, second.id, outlook().fetchImpl);
  });

  it("compacts a stored copy over 1MB into a new generation", async () => {
    const { shareId } = await sharedNew("Big", "Small body");
    await client(sam, shareId);
    const heavy = new Y.Doc({ gc: false });
    const body = liveText(heavy);
    body.insert(0, "x".repeat(1_100_000));
    body.delete(0, 1_100_000);
    body.insert(0, "Small body");
    const state = Buffer.from(Y.encodeStateAsUpdate(heavy));
    assert.ok(state.length > 1_000_000);
    await sql("update crm.mail_share_live set ydoc = $2 where share_id = $1", [shareId, state]);
    const opened = await client(sam, shareId);
    assert.equal(opened.generation, 1);
    assert.equal(text(opened), "Small body");
    const stored = await liveRow(shareId);
    assert.ok(stored?.ydoc && stored.ydoc.length < 10_000);
  });

  it("tells a removed member's open channel to leave", async () => {
    const { shareId } = await sharedNew("Kick", "Text", [sam.userId, priya.userId]);
    await removeFromShare(mark, shareId, priya.userId);
    await chatWorkSettled();
    assert.ok(broadcasts.some((message) => message.topic === draftTopic(shareId) && message.event === "kick" && (message.payload as { user: string }).user === priya.userId));
  });

  it("starts a teammate's view from the new draft's text, so an old draft's text can't overwrite it", async () => {
    const sentText = { subject: "RE: Renewal pricing", body: "Old sent text" };
    const newText = { subject: "RE: Renewal pricing", body: "New draft text" };
    assert.deepEqual(teammateText(sentText, sentText, newText, { editing: true, starting: true }), newText);
    assert.deepEqual(teammateText(sentText, { ...sentText, body: "typing" }, newText, { editing: true, starting: false }), { ...newText, body: "typing" });
    const doc = createLiveDoc(Y.encodeStateAsUpdate(createLiveDoc((() => {
      const seed = new Y.Doc();
      liveText(seed).insert(0, newText.body);
      return Y.encodeStateAsUpdate(seed);
    })())));
    const session = new LiveSession({ pageId: "x", user: { id: "u", name: "U", kind: "person" }, doc, serverVector: Y.encodeStateVector(doc), revision: 0, title: "", transport: null, server: { sync: async () => ({ vector: Y.encodeStateVector(doc), missing: new Uint8Array([0, 0]), revision: 0 }) } });
    bind(fakeView(teammateText(sentText, sentText, newText, { editing: true, starting: true }).body), session, newText.body);
    assert.equal(liveText(doc).toString(), "New draft text");
    await session.close({ save: false });
  });
});

function textOfReply(state: Uint8Array) {
  const doc = createLiveDoc(state);
  const out = liveText(doc).toString();
  doc.destroy();
  return out;
}

function fakeView(doc: string) {
  const view = {
    state: EditorState.create({ doc, selection: EditorSelection.single(doc.length) }),
    hasFocus: false,
    dispatch(spec: TransactionSpec) {
      view.state = view.state.update(spec).state;
    },
  };
  return view as unknown as EditorView & { state: EditorState };
}

describe("the browser controller", () => {
  const saved: Record<string, unknown> = {};
  let actorFor: UserActor;
  let openGate: Promise<void> | null = null;
  let openFails = false;

  function typeInto(view: EditorView & { state: EditorState }, text: string) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }

  before(() => {
    for (const key of ["fetch", "document", "window"]) saved[key] = (globalThis as Record<string, unknown>)[key];
    const g = globalThis as Record<string, unknown>;
    g.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    g.window = new EventTarget();
    g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://orbit.test");
      const shareId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const method = init?.method ?? "GET";
      if (method === "GET" && openFails) return Response.json({ error: "Couldn't save the draft. Try again.", code: "busy" }, { status: 503 });
      if (method === "GET" && openGate) await openGate;
      return liveDraftResponse(actorFor, shareId, new Request(url, { method, headers: init?.headers, body: method === "GET" ? undefined : init?.body }));
    };
  });

  after(() => {
    for (const [key, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[key] = value;
  });

  async function opened(live: LiveDraft) {
    await until(() => live.current !== null && live.version !== null, "the live draft opens");
    return live.current!;
  }

  it("keeps the session through the composer unmounting on Send, and sends what was on screen", async () => {
    actorFor = mark;
    const { draft, shareId } = await sharedNew("Unmount", "On the screen");
    const live = new LiveDraft({ shareId, user: { id: mark.userId, name: "Mark", kind: "person" }, base: "On the screen" });
    live.attach(fakeView("On the screen"));
    const session = await opened(live);
    session.text.delete(3, 4);
    await session.sync();
    session.text.insert(session.text.length, ", typed just before Send");
    const release = live.retain();
    const shown = { subject: "Unmount", body: live.text()! };
    live.detach();
    const settled = await settleForSend(live, shown, () => getSharedDraft(mark, shareId), SHARED_DRAFT_CHANGED);
    assert.equal(settled.body, "On screen, typed just before Send");
    await holdSharedDraft(mark, draft.id, true, settled.version);
    release();
    assert.equal(live.current, null);
    assert.equal(await rowBody(shareId), "On screen, typed just before Send");
    await holdSharedDraft(mark, draft.id, false);
  });

  it("settles when Send is pressed before the session has opened", async () => {
    actorFor = mark;
    const { shareId } = await sharedNew("Early", "Early text");
    const live = new LiveDraft({ shareId, user: { id: mark.userId, name: "Mark", kind: "person" }, base: "Early text" });
    live.attach(fakeView("Early text"));
    const release = live.retain();
    const shown = { subject: "Early", body: live.text() ?? "Early text" };
    live.detach();
    const settled = await settleForSend(live, shown, () => getSharedDraft(mark, shareId), SHARED_DRAFT_CHANGED);
    assert.equal(settled.body, "Early text");
    release();
    assert.equal(live.current, null);
  });

  it("refuses to send a subject the owner hasn't seen", async () => {
    actorFor = mark;
    const { shareId } = await sharedNew("Seen subject", "Body");
    const live = new LiveDraft({ shareId, user: { id: mark.userId, name: "Mark", kind: "person" }, base: "Body" });
    live.attach(fakeView("Body"));
    await opened(live);
    await saveSharedDraft(sam, shareId, { subject: "Changed by Sam", body: null });
    await assert.rejects(settleForSend(live, { subject: "Seen subject", body: "Body" }, () => getSharedDraft(mark, shareId), SHARED_DRAFT_CHANGED), new RegExp(SHARED_DRAFT_CHANGED));
    live.close();
  });

  it("keeps a locked teammate's typing unconfirmed and unbroadcast, and saves it once unlocked", async () => {
    actorFor = sam;
    const { draft, shareId } = await sharedNew("Locked", "Locked text");
    const live = new LiveDraft({ shareId, user: { id: sam.userId, name: "Sam", kind: "person" }, base: "Locked text" });
    live.attach(fakeView("Locked text"));
    const session = await opened(live);
    await scheduleMailDraft(mark, { ...fresh("Locked", "ignored"), id: draft.id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    session.text.insert(session.text.length, " typed");
    await session.sync();
    assert.match(live.locked ?? "", /^Scheduled/);
    assert.equal(await rowBody(shareId), "Locked text");
    assert.equal(session.unconfirmed(), true);
    assert.equal(session.serverText, "Locked text");
    await cancelScheduledDraft(mark, draft.id);
    await session.sync();
    await session.sync();
    assert.equal(live.locked, null);
    await until(async () => (await rowBody(shareId)) === "Locked text typed", "the typing saves after unlock");
    live.close();
  });

  it("keeps typing made before the session opens when Send is pressed", async () => {
    actorFor = mark;
    const { shareId } = await sharedNew("Before open", "Stored text");
    let letGo = () => {};
    openGate = new Promise<void>((resolve) => (letGo = resolve));
    const live = new LiveDraft({ shareId, user: { id: mark.userId, name: "Mark", kind: "person" }, base: "Stored text" });
    const view = fakeView("Stored text");
    live.attach(view);
    typeInto(view, "Stored text, typed before it opened");
    const release = live.retain();
    const shown = { subject: "Before open", body: live.text() ?? view.state.doc.toString() };
    assert.equal(shown.body, "Stored text, typed before it opened");
    live.detach();
    openGate = null;
    letGo();
    const settled = await settleForSend(live, shown, () => getSharedDraft(mark, shareId), SHARED_DRAFT_CHANGED);
    assert.equal(settled.body, "Stored text, typed before it opened");
    release();
    assert.equal(await rowBody(shareId), "Stored text, typed before it opened");
  });

  it("hands back the typing and the original base when the session never opened, and the reopened composer keeps it", async () => {
    actorFor = mark;
    const { shareId } = await sharedNew("Never open", "Original");
    openFails = true;
    const live = new LiveDraft({ shareId, user: { id: mark.userId, name: "Mark", kind: "person" }, base: "Original" });
    const view = fakeView("Original");
    live.attach(view);
    typeInto(view, "Original, and my typing");
    const release = live.retain();
    const shownBody = live.text() ?? view.state.doc.toString();
    live.detach();
    await assert.rejects(live.settle(300), /Couldn't send/);
    const back = liveHandBack(live, shownBody);
    assert.deepEqual(back, { body: "Original, and my typing", base: "Original", confirmed: false });
    release();
    openFails = false;
    const reopened = new LiveDraft({ shareId, user: { id: mark.userId, name: "Mark", kind: "person" }, base: back.base });
    const again = fakeView(back.body);
    reopened.attach(again);
    await opened(reopened);
    await reopened.flush();
    assert.equal(await rowBody(shareId), "Original, and my typing");
    assert.equal(again.state.doc.toString(), "Original, and my typing");
    reopened.close();
  });

  it("drops a teammate's unsent keystrokes when the share moves on to a new draft", async () => {
    actorFor = sam;
    const thread = (await listThreads(mark, { view: { role: "inbox" } })).threads[0];
    const share = (await shareThread(mark, thread.key, [sam.userId])).share.shareId!;
    const reply = (body: string) => readDraftInput({ mode: "reply", messageId: thread.latestId, to: ["tom@halden.test"], subject: "RE: Renewal pricing", body });
    const first = await saveMailDraft(mark, reply("Old draft"), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    await shareDraft(mark, first.id, []);
    const view = fakeView("Old draft");
    const live = new LiveDraft({ shareId: share, user: { id: sam.userId, name: "Sam", kind: "person" }, base: "Old draft" });
    live.attach(view);
    const session = await opened(live);
    session.pauseUpdates(true);
    session.text.insert(session.text.length, " unsent");
    typeInto(view, "Old draft unsent");
    await discardMailDraft(mark, first.id, outlook().fetchImpl);
    const second = await saveMailDraft(mark, reply("New draft"), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    await shareDraft(mark, second.id, []);
    session.pauseUpdates(false);
    await session.sync();
    await until(() => live.current !== null && live.current !== session, "the live draft reopens on the new draft");
    await live.current!.sync();
    assert.equal(live.text(), "New draft");
    assert.equal(view.state.doc.toString(), "New draft");
    assert.equal(await rowBody(share), "New draft");
    live.close();
    await discardMailDraft(mark, second.id, outlook().fetchImpl);
  });

  it("refuses to call an unsaved body saved", async () => {
    actorFor = sam;
    const { draft, shareId } = await sharedNew("Unsaved", "Waiting");
    const live = new LiveDraft({ shareId, user: { id: sam.userId, name: "Sam", kind: "person" }, base: "Waiting" });
    live.attach(fakeView("Waiting"));
    const session = await opened(live);
    await scheduleMailDraft(mark, { ...fresh("Unsaved", "ignored"), id: draft.id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    session.text.insert(session.text.length, " typed");
    await assert.rejects(live.flush(), /Couldn't save the draft/);
    live.close();
    await cancelScheduledDraft(mark, draft.id);
  });

  it("shows a failed live save as an error from flush", async () => {
    actorFor = sam;
    const { shareId } = await sharedNew("Fail", "Short");
    const failures: string[] = [];
    const live = new LiveDraft({ shareId, user: { id: sam.userId, name: "Sam", kind: "person" }, base: "Short", onFailure: (message) => failures.push(message) });
    live.attach(fakeView("Short"));
    const session = await opened(live);
    session.text.insert(session.text.length, "x".repeat(20_001));
    await assert.rejects(live.flush(), /under 20,000 characters/);
    assert.ok(failures.some((message) => /20,000/.test(message)));
    live.close();
  });
});

describe("lock waits", () => {
  it("answers a retryable 503 and stores nothing when the share stays locked", async () => {
    const { shareId } = await sharedNew("Busy", "Unchanged");
    const teammate = await client(sam, shareId);
    type(teammate, "end", " blocked");
    const holder = await getAdminPool().connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from crm.mail_shares where id = $1 for update", [shareId]);
      await refused(push(sam, shareId, teammate), /^Couldn't save the draft\. Try again\.$/, 503);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    assert.equal(await rowBody(shareId), "Unchanged");
    await push(sam, shareId, teammate);
    assert.equal(await rowBody(shareId), "Unchanged blocked");
  });
});

describe("paused updates", () => {
  it("doesn't broadcast a paused session's typing to peers", async () => {
    const { shareId } = await sharedNew("Paused", "Base");
    const hub = memoryHub();
    const make = async (actor: UserActor) => {
      const opened = await openLiveDraft(actor, shareId);
      const doc = createLiveDoc(opened.state);
      const live = new LiveSession<LiveDraftSummary>({
        pageId: shareId,
        topic: draftTopic(shareId),
        user: { id: actor.userId, name: actor.fullName ?? "", kind: "person" },
        doc,
        serverVector: Y.encodeStateVector(doc),
        revision: opened.version,
        generation: opened.generation,
        title: "",
        transport: hub.transport(),
        server: { sync: async () => { throw new Error("offline"); } },
        timing: { ...FAST, saveMs: 60_000, saveMaxMs: 60_000, ownMs: 60_000 },
      });
      live.start();
      return live;
    };
    const owner = await make(mark);
    const teammate = await make(sam);
    await until(() => owner.status !== "connecting" && teammate.status !== "connecting", "both join");
    teammate.pauseUpdates(true);
    teammate.text.insert(0, "hidden ");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(owner.text.toString(), "Base");
    await owner.close({ save: false });
    await teammate.close({ save: false });
  });
});
