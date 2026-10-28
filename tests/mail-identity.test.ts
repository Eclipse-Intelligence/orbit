import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { composeAccounts, readDraftInput, sendMailDraft } from "@/lib/mail/compose";
import { listIdentities, rewriteMime, saveIdentity, type SentSaver, type SmtpSender } from "@/lib/mail/identities";
import { syncMail } from "@/lib/mail/sync";
import { listThreads } from "@/lib/mail/threads";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

const DRAFT_MIME = [
  "From: Mark Ridgeon <mark@eclipse.test>",
  "Sender: Mark Ridgeon <mark@eclipse.test>",
  "To: Jane Doe <jane@acme.test>",
  "Bcc: secret@acme.test",
  "Subject: RE: Consulting",
  "X-MS-Has-Attach:",
  "X-MS-Exchange-Organization-Thing: abc",
  "  continued",
  "In-Reply-To: <m-1@mail.test>",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Hi Jane</p>",
].join("\r\n");

function outlook() {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET" || url.includes("$value")) calls.push({ method, url: url.replace(GRAPH, "") });
    if (url.endsWith("/createReply")) return Response.json({ id: "draft-1", subject: "RE: Consulting", body: { contentType: "html", content: "<html><body></body></html>" } }, { status: 201 });
    if (url.endsWith("/draft-1/$value")) return new Response(DRAFT_MIME);
    if (url.endsWith("/me/mailFolders/sentitems/messages")) return Response.json({ id: "sent-copy" }, { status: 201 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "PATCH") return Response.json({ id: "draft-1" });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    return Response.json({
      value: url.includes("token=")
        ? []
        : [
            {
              id: "m-1",
              conversationId: "conv-1",
              subject: "Consulting",
              bodyPreview: "Can you help?",
              body: { contentType: "text", content: "Can you help?" },
              from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
              toRecipients: [{ emailAddress: { name: "Mark", address: "mark@ridgeon.test" } }],
              receivedDateTime: "2026-10-01T09:00:00Z",
              isRead: true,
            },
          ],
      "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=1`,
    });
  };
  return { fetchImpl, calls };
}

describe("sending from another address", () => {
  let owner: UserActor;
  let sourceId: string;
  let messageId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("identity@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    const thread = (await listThreads(owner, { view: { role: "inbox" } })).threads[0];
    sourceId = thread.sourceId;
    messageId = thread.latestId;
  });

  after(async () => {
    await getPool().end();
  });

  it("rewrites the sender and leaves Bcc out of the headers", () => {
    const raw = rewriteMime(DRAFT_MIME, { name: "Mark Ridgeon", address: "mark@ridgeon.test" }, new Date("2026-10-20T10:00:00Z"));
    const headers = raw.split("\r\n\r\n")[0];
    assert.match(headers, /^From: "Mark Ridgeon" <mark@ridgeon.test>\r\n/);
    assert.ok(headers.includes("Date: Tue, 20 Oct 2026 10:00:00 +0000"));
    assert.ok(/Message-ID: <[0-9a-f-]+@ridgeon.test>/.test(headers));
    assert.ok(!/^(Sender|Bcc|X-MS)/im.test(headers));
    assert.ok(headers.includes("In-Reply-To: <m-1@mail.test>"));
    assert.ok(raw.endsWith("\r\n\r\n<p>Hi Jane</p>"));
    assert.ok(rewriteMime(DRAFT_MIME, { name: "Zoë", address: "z@x.test" }).startsWith("From: =?UTF-8?B?"));
  });

  it("checks the account before saving it", async () => {
    await assert.rejects(() => saveIdentity(owner, { email: "nope", sourceId, password: "x", provider: "neo" }, { check: async () => undefined }), /Enter the email address/);
    await assert.rejects(
      () => saveIdentity(owner, { email: "mark@ridgeon.test", sourceId, password: "bad", provider: "neo" }, { check: async () => Promise.reject(new Error("535 Authentication failed")) }),
      /didn't accept that address and password/,
    );
    const saved = await saveIdentity(owner, { email: "Mark@Ridgeon.test", sourceId, password: "secret", provider: "neo", displayName: "Mark Ridgeon" }, { check: async () => undefined });
    assert.equal(saved.email, "mark@ridgeon.test");
    assert.equal(saved.smtpHost, "smtp0001.neo.space");
    assert.equal(saved.imapHost, "imap0001.neo.space");
    const stored = await getAdminPool().query<{ password_cipher: string }>("select password_cipher from crm.send_identities");
    assert.ok(!stored.rows[0].password_cipher.includes("secret"));
    assert.deepEqual((await composeAccounts(owner)).map((account) => [account.email, Boolean(account.identityId)]), [
      ["mark@eclipse.test", false],
      ["mark@ridgeon.test", true],
    ]);
  });

  it("sends a reply through the other address and keeps copies", async () => {
    const identity = (await listIdentities(owner))[0];
    const smtpCalls: Parameters<SmtpSender>[1][] = [];
    const saved: string[] = [];
    const smtp: SmtpSender = async (_identity, message) => {
      smtpCalls.push(message);
    };
    const saveSent: SentSaver = async (_identity, raw) => {
      saved.push(raw);
    };
    const { fetchImpl, calls } = outlook();
    await sendMailDraft(
      owner,
      readDraftInput({ mode: "reply", messageId, to: ["jane@acme.test"], bcc: ["secret@acme.test"], body: "Happy to help.", identityId: identity.id }),
      { storedFiles: "replace", origin: "https://orbit.test", fetchImpl, smtp, saveSent },
    );
    assert.equal(smtpCalls.length, 1);
    assert.equal(smtpCalls[0].from, "mark@ridgeon.test");
    assert.deepEqual(smtpCalls[0].to, ["jane@acme.test", "secret@acme.test"]);
    assert.match(smtpCalls[0].raw, /^From: "Mark Ridgeon" <mark@ridgeon.test>/);
    assert.ok(!calls.some((call) => call.url.endsWith("/send")));
    assert.ok(calls.some((call) => call.method === "POST" && call.url === "/me/mailFolders/sentitems/messages"));
    assert.ok(calls.some((call) => call.method === "DELETE" && call.url === "/me/messages/draft-1"));
    assert.equal(saved.length, 1);
    const tracking = await getAdminPool().query<{ sender_email: string; sent_at: Date | null }>("select sender_email, sent_at from crm.mail_tracking");
    assert.equal(tracking.rows[0].sender_email, "mark@ridgeon.test");
    assert.ok(tracking.rows[0].sent_at);
  });

  it("reports a failed send against the address", async () => {
    const identity = (await listIdentities(owner))[0];
    await assert.rejects(
      () =>
        sendMailDraft(owner, readDraftInput({ mode: "reply", messageId, to: ["jane@acme.test"], body: "Again", identityId: identity.id }), { storedFiles: "replace",
          origin: null,
          fetchImpl: outlook().fetchImpl,
          smtp: async () => Promise.reject(new Error("Connection refused")),
          saveSent: async () => undefined,
        }),
      /mark@ridgeon.test couldn't send: Connection refused/,
    );
    assert.equal((await listIdentities(owner))[0].lastError, "Connection refused");
  });
});
