import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { prepareAttachment } from "@/lib/crm/email-attachments";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { encryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { readDraftInput, saveDraftForAgent, saveMailDraft, sendForAgent, sendMailDraft } from "@/lib/mail/compose";
import { saveIdentity } from "@/lib/mail/identities";
import { syncMail } from "@/lib/mail/sync";
import { resetStorageBucketCache } from "@/lib/storage";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SUPABASE = "https://project.supabase.test";
const UPLOAD = "https://upload.outlook.test";
const ORIGIN = "https://orbit.test";

type Attachment = { id: string; name: string; size: number };
type Draft = { attachments: Attachment[]; internetMessageId: string };
type Call = { method: string; url: string };

const INBOX_MESSAGE = {
  id: "m-1",
  internetMessageId: "<m-1@acme.test>",
  conversationId: "conv-1",
  subject: "Pricing",
  bodyPreview: "Hello",
  body: { contentType: "html", content: "<p>Hello</p>" },
  from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
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
  webLink: null,
};

function world(options: { patchedId?: boolean } = {}) {
  const calls: Call[] = [];
  const objects = new Map<string, Uint8Array>();
  const drafts = new Map<string, Draft>();
  const sent: { attachments: Attachment[]; internetMessageId: string }[] = [];
  const state = { failSend: false, locate: true, count: 0, files: 0 };
  const idOf = (url: string) => decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
  const notFound = () => Response.json({ error: { code: "ErrorItemNotFound", message: "Not found." } }, { status: 404 });
  const addFile = (draft: Draft, name: string, size: number) => {
    state.files += 1;
    const file = { id: `file-${state.files}`, name, size };
    draft.attachments.push(file);
    return file;
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith(SUPABASE)) {
      if (url === `${SUPABASE}/storage/v1/bucket`) return Response.json({ name: "email-attachments" });
      const sign = url.match(/\/storage\/v1\/object\/upload\/sign\/email-attachments\/(.+)$/);
      if (sign) return Response.json({ url: `/object/upload/sign/email-attachments/${sign[1]}?token=signed` });
      const read = url.match(/\/storage\/v1\/object\/email-attachments\/(.+)$/);
      if (read && method === "GET") {
        const bytes = objects.get(read[1]);
        return bytes ? new Response(Buffer.from(bytes)) : Response.json({ message: "Object not found" }, { status: 404 });
      }
      return Response.json([]);
    }
    calls.push({ method, url: url.replace(GRAPH, "") });
    if (url.startsWith(UPLOAD)) {
      const [, , draftId, name, size] = new URL(url).pathname.split("/").map(decodeURIComponent);
      const draft = drafts.get(draftId);
      if (!draft) return notFound();
      const range = String(new Headers(init?.headers).get("content-range"));
      const [, end, total] = range.match(/-(\d+)\/(\d+)$/) ?? [];
      if (Number(end) + 1 < Number(total)) return new Response(null, { status: 200 });
      const file = addFile(draft, name, Number(size));
      return new Response(null, { status: 201, headers: state.locate ? { location: `https://outlook.office.com/api/v2.0/Users('u')/Messages('${draftId}')/Attachments('${file.id}')` } : {} });
    }
    const id = idOf(url);
    if (method === "POST" && url === `${GRAPH}/me/messages`) {
      state.count += 1;
      const made = `draft-${state.count}`;
      drafts.set(made, { attachments: [], internetMessageId: `<${made}@outlook.test>` });
      return Response.json({ id: made, conversationId: `conv-${made}`, subject: "" }, { status: 201 });
    }
    if (method === "POST" && /\/(createReply|createReplyAll|createForward)$/.test(url)) {
      state.count += 1;
      const made = `draft-${state.count}`;
      drafts.set(made, { attachments: [], internetMessageId: `<${made}@outlook.test>` });
      return Response.json({ id: made, subject: "RE: Pricing", body: { contentType: "html", content: "<html><body></body></html>" } }, { status: 201 });
    }
    if (method === "POST" && url.endsWith("/attachments/createUploadSession")) {
      const draft = drafts.get(id);
      if (!draft) return notFound();
      const body = JSON.parse(String(init?.body)) as { AttachmentItem: { name: string; size: number } };
      return Response.json({ uploadUrl: `${UPLOAD}/session/${id}/${encodeURIComponent(body.AttachmentItem.name)}/${body.AttachmentItem.size}` });
    }
    if (method === "POST" && url.endsWith("/attachments")) {
      const draft = drafts.get(id);
      if (!draft) return notFound();
      const body = JSON.parse(String(init?.body)) as { name: string; contentBytes: string };
      const file = addFile(draft, body.name, Buffer.from(body.contentBytes, "base64").byteLength);
      return Response.json({ id: file.id }, { status: 201 });
    }
    if (method === "GET" && url.includes("/attachments?")) {
      const draft = drafts.get(id);
      return draft ? Response.json({ value: draft.attachments }) : notFound();
    }
    if (method === "DELETE" && /\/attachments\/[^/]+$/.test(url)) {
      const draft = drafts.get(id);
      const fileId = decodeURIComponent(url.split("/").pop()!);
      if (!draft) return notFound();
      draft.attachments = draft.attachments.filter((file) => file.id !== fileId);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH" && id) {
      const draft = drafts.get(id);
      if (!draft) return notFound();
      return Response.json(options.patchedId === false ? { id } : { id, internetMessageId: draft.internetMessageId });
    }
    if (method === "POST" && url.endsWith("/send")) {
      const draft = drafts.get(id);
      if (!draft) return notFound();
      if (state.failSend) return Response.json({ error: { code: "ErrorInvalidRecipients", message: "Outlook refused the recipients." } }, { status: 400 });
      drafts.delete(id);
      sent.push({ attachments: draft.attachments, internetMessageId: draft.internetMessageId });
      return new Response(null, { status: 202 });
    }
    if (method === "DELETE") {
      drafts.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && id && url.endsWith("/$value")) {
      return drafts.has(id) ? new Response(`Message-ID: <${id}@mime.test>\r\nFrom: Mark <mark@eclipse.test>\r\nTo: sam@acme.test\r\nSubject: Hello\r\n\r\nHi`) : notFound();
    }
    if (method === "GET" && id && url.includes("$select=internetMessageId")) {
      const draft = drafts.get(id);
      return draft ? Response.json({ id, internetMessageId: draft.internetMessageId }) : notFound();
    }
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    return Response.json({
      value: url.includes("/messages/delta") && !url.includes("token=") ? [INBOX_MESSAGE] : [],
      "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=${Math.random()}`,
    });
  };
  const count = (method: string, part: string) => calls.filter((call) => call.method === method && call.url.includes(part)).length;
  return { fetchImpl, calls, objects, drafts, sent, state, count };
}

describe("mail compose and send review fixes", () => {
  let owner: UserActor;
  let sourceId: string;
  let otherSourceId: string;
  let messageId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("compose-review@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: world().fetchImpl });
    const admin = getAdminPool();
    sourceId = (await admin.query<{ id: string }>("select id from crm.mail_sources where user_id = $1 and email = 'mark@eclipse.test'", [owner.userId])).rows[0].id;
    messageId = (await admin.query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'm-1'")).rows[0].id;
    const account = (
      await admin.query<{ id: string }>(
        `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, access_token, access_token_expires_at, can_send)
         values ($1, $2, 'microsoft', 'mark@consulting.test', 'connected', $3, $4, now() + interval '1 hour', true) returning id`,
        [owner.workspaceId, owner.userId, encryptSecret("other-refresh"), encryptSecret("other-access")],
      )
    ).rows[0].id;
    otherSourceId = (
      await admin.query<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, account_id, email) values ($1, $2, $3, 'mark@consulting.test') returning id", [owner.workspaceId, owner.userId, account])
    ).rows[0].id;
  });

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    resetStorageBucketCache();
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  after(async () => {
    await getPool().end();
  });

  async function attach(box: ReturnType<typeof world>, name: string, size: number, contentType = "application/pdf") {
    const prepared = await prepareAttachment(owner, { name, size, contentType }, box.fetchImpl);
    box.objects.set(prepared.id, new Uint8Array(size).fill(7));
    return prepared.id;
  }

  const compose = (subject: string, body = "Files attached.") => readDraftInput({ mode: "new", sourceId, to: ["sam@acme.test"], subject, body });

  async function saved(box: ReturnType<typeof world>, subject: string, attachments: string[] = [], extra: Record<string, unknown> = {}) {
    const input = { ...compose(subject), ...extra };
    const draft = await saveMailDraft(owner, { ...input, attachments }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl });
    return { input: { ...input, id: draft.id }, id: draft.id };
  }

  const send = (box: ReturnType<typeof world>, input: ReturnType<typeof compose>) => sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: box.fetchImpl });

  const row = async (id: string) =>
    (await getAdminPool().query<{ provider_draft_id: string; outlook_files: Record<string, unknown>; sent_internet_id: string | null }>("select provider_draft_id, outlook_files, sent_internet_id from crm.mail_drafts where id = $1", [id])).rows[0];

  const names = (files: Attachment[]) => files.map((file) => file.name).sort();

  describe("files already on the Outlook draft", () => {
    it("uploads each file once however many sends fail before one works", async () => {
      const box = world();
      const first = await attach(box, "Proposal.pdf", 2048);
      const second = await attach(box, "Terms.pdf", 1024);
      const { input, id } = await saved(box, "Two files", [first, second]);
      box.state.failSend = true;
      for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(() => send(box, input), /Outlook refused the recipients/);
      assert.equal(box.count("POST", "/attachments"), 2);
      assert.deepEqual(Object.keys((await row(id)).outlook_files).sort(), [first, second].sort());

      box.state.failSend = false;
      await send(box, input);
      assert.equal(box.count("POST", "/attachments"), 2);
      assert.deepEqual(names(box.sent[0].attachments), ["Proposal.pdf", "Terms.pdf"]);
    });

    it("keeps what was uploaded when a later file fails to upload", async () => {
      const box = world();
      const first = await attach(box, "One.pdf", 100);
      const second = await attach(box, "Two.pdf", 100);
      const { input, id } = await saved(box, "Stops partway", [first, second]);
      const realFetch = box.fetchImpl;
      let uploads = 0;
      const flaky: typeof fetch = async (target, init) => {
        if (String(target).endsWith("/attachments") && init?.method === "POST" && (uploads += 1) === 2) return Response.json({ error: { code: "ErrorQuotaExceeded", message: "Quota." } }, { status: 429 });
        return realFetch(target, init);
      };
      await assert.rejects(() => sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: flaky }));
      assert.equal(Object.keys((await row(id)).outlook_files).length, 1);

      await send(box, input);
      assert.equal(box.count("POST", "/attachments"), 2);
      assert.deepEqual(names(box.sent[0].attachments), ["One.pdf", "Two.pdf"]);
    });

    it("sends without a file the person removed after a failed send, and leaves files Outlook added itself", async () => {
      const box = world();
      const keep = await attach(box, "Keep.pdf", 100);
      const drop = await attach(box, "Drop.pdf", 100);
      const { input, id } = await saved(box, "Remove one", [keep, drop]);
      box.state.failSend = true;
      await assert.rejects(() => send(box, input));
      box.drafts.get((await row(id)).provider_draft_id)!.attachments.push({ id: "from-forward", name: "Original.pdf", size: 900 });

      await saveMailDraft(owner, { ...input, attachments: [keep] }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl });
      box.state.failSend = false;
      await send(box, input);
      assert.deepEqual(names(box.sent[0].attachments), ["Keep.pdf", "Original.pdf"]);
      assert.equal(box.count("POST", "/attachments"), 2);
    });

    it("uploads a file again if it vanished from the Outlook draft", async () => {
      const box = world();
      const only = await attach(box, "Lost.pdf", 100);
      const { input, id } = await saved(box, "Vanished file", [only]);
      box.state.failSend = true;
      await assert.rejects(() => send(box, input));
      box.drafts.get((await row(id)).provider_draft_id)!.attachments = [];

      box.state.failSend = false;
      await send(box, input);
      assert.deepEqual(names(box.sent[0].attachments), ["Lost.pdf"]);
    });

    it("swaps a file that became inline for one with a content id, not a second copy", async () => {
      const box = world();
      const image = await attach(box, "chart.png", 100, "image/png");
      const { input, id } = await saved(box, "Image later", [image]);
      box.state.failSend = true;
      await assert.rejects(() => send(box, input));
      assert.equal((await row(id)).outlook_files[image] !== undefined, true);

      box.state.failSend = false;
      await send(box, { ...input, body: "See below.\n\n[Image: chart.png]" });
      assert.deepEqual(names(box.sent[0].attachments), ["chart.png"]);
      assert.equal(box.count("POST", "/attachments"), 2);
      assert.equal(box.count("DELETE", "/attachments/"), 1);
    });

    it("removes a large file by the id Outlook gave, or by name when it gave none", async () => {
      for (const locate of [true, false]) {
        const box = world();
        box.state.locate = locate;
        const big = await attach(box, "Deck.pdf", 4 * 1024 * 1024);
        const small = await attach(box, "Notes.txt", 10, "text/plain");
        const { input, id } = await saved(box, `Large ${locate}`, [big, small]);
        box.state.failSend = true;
        await assert.rejects(() => send(box, input));
        assert.equal((await row(id)).outlook_files[big] !== undefined, true);

        await saveMailDraft(owner, { ...input, attachments: [small] }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl });
        box.state.failSend = false;
        await send(box, input);
        assert.deepEqual(names(box.sent[0].attachments), ["Notes.txt"]);
        assert.equal(box.count("POST", "/attachments/createUploadSession"), 1);
      }
    });

    it("starts a replacement Outlook draft with no files recorded", async () => {
      const box = world();
      const only = await attach(box, "Again.pdf", 100);
      const { input, id } = await saved(box, "Draft deleted in Outlook", [only]);
      box.state.failSend = true;
      await assert.rejects(() => send(box, input));
      box.drafts.delete((await row(id)).provider_draft_id);

      box.state.failSend = false;
      await send(box, input);
      assert.deepEqual(names(box.sent[0].attachments), ["Again.pdf"]);
      assert.equal(box.count("POST", "/attachments"), 2);
    });
  });

  describe("the internet message id", () => {
    it("takes it from the draft update when the content changed, without asking Outlook again", async () => {
      const box = world();
      const { input, id } = await saved(box, "Changed at send");
      box.state.failSend = true;
      await assert.rejects(() => send(box, { ...input, body: "Edited just before Send." }));
      assert.equal(box.count("GET", "$select=internetMessageId"), 0);
      assert.equal((await row(id)).sent_internet_id, box.drafts.get((await row(id)).provider_draft_id)!.internetMessageId);
    });

    it("still asks Outlook when nothing changed, which also shows a draft deleted there", async () => {
      const box = world();
      const { input } = await saved(box, "Unchanged at send");
      await send(box, input);
      assert.equal(box.count("GET", "$select=internetMessageId"), 1);
      assert.equal(box.sent.length, 1);
    });

    it("falls back to asking Outlook when the update doesn't return it", async () => {
      const box = world({ patchedId: false });
      const { input } = await saved(box, "No id in the answer");
      await send(box, { ...input, body: "Edited just before Send." });
      assert.equal(box.count("GET", "$select=internetMessageId"), 1);
    });
  });

  describe("sending from another address", () => {
    it("sends once and carries on when saving the copy to Sent fails", async () => {
      const box = world();
      const identity = await saveIdentity(owner, { email: "mark@ridgeon.test", sourceId, password: "secret", provider: "neo", displayName: "Mark Ridgeon" }, { check: async () => undefined });
      const input = { ...compose("From the other address"), identityId: identity.id };
      const draft = await saveMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl });
      const smtp: string[] = [];
      const saveSent = async () => {
        smtp.push("saved");
        throw new Error("IMAP is down");
      };
      const result = await sendMailDraft(owner, { ...input, id: draft.id }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: box.fetchImpl, smtp: async () => void smtp.push("sent"), saveSent });
      assert.equal(result.warning, null);
      assert.deepEqual(smtp.sort(), ["saved", "sent"]);
      assert.equal(box.count("POST", "/mailFolders/sentitems/messages"), 1);
      assert.equal(box.count("DELETE", "/me/messages/draft-"), 1);
    });
  });

  describe("replies from the assistant", () => {
    it("refuses a From in another mailbox than the conversation, when saving and when sending", async () => {
      const box = world();
      const reply = { replyTo: messageId, to: [] as string[], from: "mark@consulting.test", body: "Hi Jane" };
      const writes = () => box.calls.filter((call) => call.method !== "GET").length;
      await assert.rejects(() => saveDraftForAgent(owner, reply, { origin: null, fetchImpl: box.fetchImpl }), /Replies and forwards go out from the mailbox the conversation is in, mark@eclipse\.test\./);
      await assert.rejects(() => sendForAgent(owner, reply, { origin: null, fetchImpl: box.fetchImpl, saveSent: async () => undefined }), /Replies and forwards go out from the mailbox the conversation is in, mark@eclipse\.test\./);
      assert.equal(writes(), 0);

      const own = await saveDraftForAgent(owner, { ...reply, from: "mark@eclipse.test" }, { origin: null, fetchImpl: box.fetchImpl });
      assert.equal(own.draft.sourceId, sourceId);
      const sent = await sendForAgent(owner, { ...reply, from: "mark@eclipse.test" }, { origin: null, fetchImpl: box.fetchImpl, saveSent: async () => undefined });
      assert.equal(sent.scheduled, false);
      assert.equal(box.sent.length, 1);
    });
  });

  describe("changing From on a draft that already tried to send", () => {
    it("keeps the send key on the new draft so Send and autosave still work", async () => {
      const box = world();
      const key = randomUUID();
      const { input, id } = await saved(box, "Switch mailbox", [], { sendKey: key });
      box.state.failSend = true;
      await assert.rejects(() => send(box, input));
      const before = await row(id);

      const moved = await saveMailDraft(owner, { ...input, sourceId: otherSourceId }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl });
      assert.notEqual(moved.id, id);
      assert.equal(moved.sourceId, otherSourceId);
      const keys = await getAdminPool().query<{ draft_id: string }>("select draft_id from crm.mail_send_keys where key = $1", [key]);
      assert.deepEqual(keys.rows, [{ draft_id: moved.id }]);
      assert.equal(box.drafts.has(before.provider_draft_id), false);
      assert.equal((await getAdminPool().query("select 1 from crm.mail_drafts where id = $1", [id])).rowCount, 0);

      const autosaved = await saveMailDraft(owner, { ...input, sourceId: otherSourceId, body: "Typed after switching." }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl });
      assert.equal(autosaved.id, moved.id);

      box.state.failSend = false;
      await send(box, { ...input, sourceId: otherSourceId, body: "Typed after switching." });
      assert.equal(box.sent.length, 1);
      const sentKey = await getAdminPool().query<{ sent_at: Date | null }>("select sent_at from crm.mail_send_keys where key = $1", [key]);
      assert.ok(sentKey.rows[0].sent_at);
    });
  });
});
