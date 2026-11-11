import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { createPersonalToken, listPersonalTokens, setPersonalTokenSending } from "@/lib/auth/personal";
import { listActivities } from "@/lib/crm/activities";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { encryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { claimDueDrafts, discardMailDraft, dueDraftInput, MAIL_SEND_KEY_REUSED, MAIL_SEND_MAYBE_SENT, readDraftInput, saveMailDraft, sendMailDraft } from "@/lib/mail/compose";
import { listIdentities, saveIdentity, type SentSaver, type SmtpSender } from "@/lib/mail/identities";
import { syncMail } from "@/lib/mail/sync";
import { listThreads } from "@/lib/mail/threads";
import { registerMailTools } from "@/server/mcp/mail";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase } from "./helpers";

process.env.SITE_URL = "https://orbit.test";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SUPABASE = "https://supabase.test";

let made = 0;

type Call = { method: string; url: string; body: Record<string, unknown> | null };

const NEW_MIME = ["From: Mark Ridgeon <mark@eclipse.test>", "To: Jane Doe <jane@acme.test>", "Subject: From Ridgeon", "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "", "<p>Hi Jane</p>"].join(
  "\r\n",
);

function inboxMessage(id = "m-1", to = "mark@eclipse.test") {
  return {
    id,
    internetMessageId: `<${id}@acme.test>`,
    conversationId: `conv-${id}`,
    subject: "Renewal pricing",
    bodyPreview: "Can we talk about the renewal price?",
    body: { contentType: "html", content: "<p>Can we talk about the renewal price?</p>" },
    from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
    toRecipients: [{ emailAddress: { name: "Mark", address: to } }],
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
}

function readJson(body: unknown) {
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function outlook(inbox: unknown[] = []) {
  const calls: Call[] = [];
  const state = { sendStatus: 202, files: new Map<string, ArrayBuffer>() };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith(SUPABASE)) {
      calls.push({ method, url: url.replace(SUPABASE, ""), body: null });
      const file = state.files.get(url.split("/").pop() ?? "");
      if (method === "GET" && file) return new Response(file);
      return Response.json([]);
    }
    if (method !== "GET") {
      calls.push({ method, url: url.replace(GRAPH, ""), body: readJson(init?.body) });
      if (method === "POST" && url === `${GRAPH}/me/messages`) {
        made += 1;
        return Response.json({ id: `draft-${made}`, conversationId: `conv-new-${made}`, subject: "" }, { status: 201 });
      }
      if (/\/(createReply|createReplyAll|createForward)$/.test(url)) {
        made += 1;
        return Response.json(
          { id: `draft-${made}`, conversationId: "conv-m-1", subject: "RE: Renewal pricing", body: { contentType: "html", content: "<html><body><div>Jane wrote</div></body></html>" } },
          { status: 201 },
        );
      }
      if (url.endsWith("/send")) {
        if (state.sendStatus === 202) return new Response(null, { status: 202 });
        return Response.json({ error: { code: "ErrorInvalidRecipients", message: "Outlook refused the recipients." } }, { status: state.sendStatus });
      }
      if (url.endsWith("/me/mailFolders/sentitems/messages")) return Response.json({ id: "sent-copy" }, { status: 201 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id: "patched" }, { status: url.endsWith("/attachments") ? 201 : 200 });
    }
    if (url.endsWith("/$value")) return new Response(NEW_MIME);
    const asked = url.match(/\/me\/messages\/([^/?]+)\?\$select=internetMessageId$/)?.[1];
    if (asked) return Response.json({ internetMessageId: `<${decodeURIComponent(asked)}@eclipse.test>` });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    return Response.json({ value: url.includes("/messages/delta") ? inbox : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=${Math.random()}` });
  };
  const sends = () => calls.filter((call) => call.method === "POST" && call.url.endsWith("/send"));
  const created = () => calls.filter((call) => call.method === "POST" && (call.url === "/me/messages" || /\/createReply(All)?$|\/createForward$/.test(call.url)));
  return { fetchImpl, calls, sends, created, state };
}

type ToolAnswer = { content: { text: string }[]; isError?: boolean };

type Sent = {
  status: "sent" | "scheduled" | "already_sent";
  sent: boolean;
  scheduled: boolean;
  alreadySent: boolean;
  sentAt: string | null;
  sendAt: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  mode: string | null;
  messageId: string | null;
  draftId: string | null;
  thread: string | null;
  internetMessageId: string | null;
  idempotencyKey: string;
  warning: string | null;
};

type Extra = { smtp?: SmtpSender; saveSent?: SentSaver; tokenId?: string };

async function connect(actor: UserActor, fetchImpl: typeof fetch, extra: Extra = {}) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerMailTools(server, actor, { fetchImpl, canSend: true, ...extra });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolAnswer,
    close: () => client.close(),
  };
}

async function answer(actor: UserActor, fetchImpl: typeof fetch, args: Record<string, unknown>, extra: Extra = {}) {
  const mcp = await connect(actor, fetchImpl, extra);
  try {
    return await mcp.call("mail_send", args);
  } finally {
    await mcp.close();
  }
}

async function send(actor: UserActor, fetchImpl: typeof fetch, args: Record<string, unknown>, extra: Extra = {}) {
  const result = await answer(actor, fetchImpl, args, extra);
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text) as Sent;
}

async function refused(actor: UserActor, fetchImpl: typeof fetch, args: Record<string, unknown>, extra: Extra = {}) {
  const result = await answer(actor, fetchImpl, args, extra);
  assert.equal(result.isError, true, result.content[0].text);
  return result.content[0].text;
}

async function listTools(token: string) {
  const response = await mcpRoute(
    new Request("http://crm.test/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  const body = (await response.json()) as { result: { tools: { name: string; annotations?: { destructiveHint?: boolean } }[] } };
  return body.result.tools;
}

async function instructionsFor(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  const instructions = client.getInstructions() ?? "";
  await client.close();
  return { tools, instructions };
}

async function draftCount(actor: UserActor) {
  return (await getAdminPool().query("select 1 from crm.mail_drafts where user_id = $1", [actor.userId])).rowCount;
}

describe("sending email over MCP", () => {
  let owner: UserActor;
  let other: UserActor;
  let jane: string;
  let messageId: string;
  let thread: string;
  let tokenId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mcp-send@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook([inboxMessage()]).fetchImpl });
    jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" })).body.contact.id;
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    thread = inbox.threads[0].key;
    messageId = inbox.threads[0].latestId;
    await getAdminPool().query("insert into crm.email_signatures (workspace_id, user_id, sender_email, body) values ($1, $2, $3, $4)", [
      owner.workspaceId,
      owner.userId,
      "mark@eclipse.test",
      "Mark Ridgeon, Eclipse",
    ]);
    tokenId = (await createPersonalToken(owner, "Sending", { canSend: true })).details.id;
    other = await createUser("someone-else@orbit.test", "Sam Other");
    await saveMailbox(other, { email: "sam@other.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(other, { budgetMs: 30_000, fetchImpl: outlook([inboxMessage("m-sam", "sam@other.test")]).fetchImpl });
  });

  after(async () => {
    await getPool().end();
  });

  describe("who gets mail_send", () => {
    it("lists it only for a personal token with Can send email on, never for agents or stdio", async () => {
      const plain = await createPersonalToken(owner, "Reading only");
      assert.equal(plain.details.canSend, false);
      assert.ok(!(await listTools(plain.token)).some((tool) => tool.name === "mail_send"));
      assert.ok((await listTools(plain.token)).some((tool) => tool.name === "mail_save_draft"));

      const allowed = await setPersonalTokenSending(owner, plain.details.id, true);
      assert.equal(allowed.canSend, true);
      const tool = (await listTools(plain.token)).find((item) => item.name === "mail_send");
      assert.equal(tool?.annotations?.destructiveHint, true);
      assert.equal((await listPersonalTokens(owner)).find((item) => item.id === plain.details.id)?.canSend, true);
      await setPersonalTokenSending(owner, plain.details.id, false);
      assert.ok(!(await listTools(plain.token)).some((item) => item.name === "mail_send"));

      const born = await createPersonalToken(owner, "Born sending", { canSend: true });
      assert.ok((await listTools(born.token)).some((item) => item.name === "mail_send"));

      await assert.rejects(() => setPersonalTokenSending(other, plain.details.id, true), { code: "not_found" });

      const agent = await createAgent(owner.workspaceId, ["crm:read", "admin"]);
      const agentTools = (await listTools(agent.token)).map((item) => item.name);
      assert.ok(agentTools.includes("search_companies"));
      assert.ok(!agentTools.some((name) => name.startsWith("mail_")));
      const market = await createAgent(owner.workspaceId, ["market:write"]);
      const marketTools = (await listTools(market.token)).map((item) => item.name);
      assert.ok(marketTools.includes("add_market_notes"));
      assert.ok(!marketTools.includes("mail_send"));

      const stdio = await instructionsFor(createCrmMcpServer(owner));
      assert.ok(stdio.tools.includes("mail_save_draft"));
      assert.ok(!stdio.tools.includes("mail_send"));
      assert.match(stdio.instructions, /This token can't send email/);
      const sending = await instructionsFor(createCrmMcpServer(owner, { personal: { tokenId, canSend: true } }));
      assert.ok(sending.tools.includes("mail_send"));
      assert.match(sending.instructions, /mail_send really sends/);
    });
  });

  describe("sending", () => {
    it("composes and sends a new email with the signature and read tracking, files it on the contact and records the token", async () => {
      const box = outlook();
      const result = await send(
        owner,
        box.fetchImpl,
        { mode: "new", to: [{ address: "jane@acme.test", name: "Jane\r\nBcc: x@evil.test" }], subject: "Proposal", body: "Hi Jane,\n\nThe proposal is attached.\n\nMark" },
        { tokenId },
      );
      assert.equal(result.status, "sent");
      assert.equal(result.sent, true);
      assert.equal(result.alreadySent, false);
      assert.ok(result.sentAt);
      assert.equal(result.from, "mark@eclipse.test");
      assert.deepEqual(result.to, ["jane@acme.test"]);
      assert.equal(result.subject, "Proposal");
      assert.ok(result.draftId);
      assert.match(result.internetMessageId ?? "", /@eclipse\.test>$/);
      assert.match(result.thread ?? "", /\|conv-new-\d+$/);
      assert.equal(result.warning, null);
      assert.deepEqual(box.calls.map((call) => `${call.method} ${call.url.split("?")[0].replace(/draft-\d+/, "draft")}`), [
        "POST /me/messages",
        "PATCH /me/messages/draft",
        "POST /me/messages/draft/send",
      ]);
      const patch = box.calls[1].body as { body: { content: string }; toRecipients: { emailAddress: { name: string } }[] };
      assert.equal(patch.toRecipients[0].emailAddress.name, "Jane Bcc: x@evil.test");
      const html = patch.body.content;
      assert.match(html, /Mark Ridgeon, Eclipse/);
      const pixel = html.match(/https:\/\/orbit\.test\/api\/mail\/open\/([0-9a-f-]{36})/)?.[1];
      assert.ok(pixel, "read tracking pixel");
      const admin = getAdminPool();
      const tracking = await admin.query<{ sent: boolean; subject: string }>("select sent_at is not null as sent, subject from crm.mail_tracking where id = $1", [pixel]);
      assert.deepEqual(tracking.rows[0], { sent: true, subject: "Proposal" });
      assert.equal((await admin.query("select 1 from crm.mail_drafts where id = $1", [result.draftId])).rowCount, 0);
      const key = await admin.query<{ token_id: string; sent: boolean }>("select token_id, sent_at is not null as sent from crm.mail_send_keys where key = $1", [result.idempotencyKey]);
      assert.deepEqual(key.rows[0], { token_id: tokenId, sent: true });
      const filed = (await listActivities(owner, { limit: 20 })).data.find((item) => item.title === "Proposal");
      assert.equal(filed?.contactId, jane);
      assert.equal(filed?.metadata.direction, "outbound");
      assert.equal(filed?.metadata.from, "mark@eclipse.test");
    });

    it("answers a repeat within 10 minutes as already sent, with when it went, and sends the same email again after that", async () => {
      const box = outlook();
      const args = { mode: "new", to: ["jane@acme.test"], subject: "Timesheets", body: "Timesheets are due today." };
      const first = await send(owner, box.fetchImpl, args);
      const second = await send(owner, box.fetchImpl, args);
      assert.equal(first.status, "sent");
      assert.equal(second.status, "already_sent");
      assert.equal(second.sent, false);
      assert.equal(second.alreadySent, true);
      assert.equal(second.idempotencyKey, first.idempotencyKey);
      assert.ok(second.sentAt && Math.abs(Date.parse(second.sentAt) - Date.parse(first.sentAt!)) < 5_000);
      assert.match(second.warning ?? "", /didn't send it again/);
      assert.equal(box.sends().length, 1);

      const admin = getAdminPool();
      await admin.query("update crm.mail_send_keys set sent_at = now() - interval '11 minutes' where key = $1", [first.idempotencyKey]);
      const later = await send(owner, box.fetchImpl, args);
      assert.equal(later.status, "sent");
      assert.equal(box.sends().length, 2);

      const key = randomUUID();
      await send(owner, box.fetchImpl, { ...args, subject: "Keyed", idempotency_key: key });
      await admin.query("update crm.mail_send_keys set sent_at = now() - interval '2 days' where key = $1", [key]);
      const keyed = await send(owner, box.fetchImpl, { ...args, subject: "Keyed", idempotency_key: key });
      assert.equal(keyed.status, "already_sent");
      assert.equal(box.sends().length, 3);
    });

    it("refuses an idempotency_key reused for a different email, and sends a concurrent pair once", async () => {
      const box = outlook();
      const key = randomUUID();
      await send(owner, box.fetchImpl, { mode: "new", to: ["jane@acme.test"], subject: "P4 a", body: "First.", idempotency_key: key });
      const reused = await refused(owner, box.fetchImpl, { mode: "new", to: ["bob@other.test"], subject: "P4 b", body: "Second.", idempotency_key: key });
      assert.equal(reused, `conflict: ${MAIL_SEND_KEY_REUSED}`);
      assert.equal(box.sends().length, 1);

      const together = { mode: "new", to: ["jane@acme.test"], subject: "Both at once", body: "Hi Jane." };
      const mcp = await connect(owner, box.fetchImpl);
      const answers = await Promise.all([mcp.call("mail_send", together), mcp.call("mail_send", together)]);
      await mcp.close();
      assert.equal(box.sends().length, 2);
      const texts = answers.map((item) => item.content[0].text);
      assert.ok(texts.some((text) => !text.startsWith("conflict") && JSON.parse(text).status === "sent"), texts.join("\n"));
    });

    it("replies in the conversation, and refuses someone else's email or another of the person's mailboxes", async () => {
      const box = outlook();
      const result = await send(owner, box.fetchImpl, { mode: "reply", message_id: messageId, to: ["jane@acme.test"], body: "Hi Jane,\n\nHappy to talk.\n\nMark" });
      assert.equal(result.status, "sent");
      assert.equal(result.mode, "reply");
      assert.equal(result.messageId, messageId);
      assert.equal(result.from, "mark@eclipse.test");
      assert.equal(result.subject, "RE: Renewal pricing");
      assert.equal(result.thread, thread);
      assert.ok(box.calls[0].url.endsWith("/createReply"));
      assert.equal(box.sends().length, 1);
      assert.equal((await listActivities(owner, { limit: 30 })).data.find((item) => item.title === "RE: Renewal pricing")?.contactId, jane);

      const admin = getAdminPool();
      const theirs = (await admin.query<{ id: string }>("select id from crm.mail_messages where user_id = $1", [other.userId])).rows[0].id;
      const blocked = outlook();
      for (const mode of ["reply", "forward"]) {
        assert.match(await refused(owner, blocked.fetchImpl, { mode, message_id: theirs, to: ["jane@acme.test"], body: "Hi" }), /^not_found: That email isn't in Mail/);
      }
      const account = (
        await admin.query<{ id: string }>(
          `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, access_token, access_token_expires_at, can_send)
           values ($1, $2, 'microsoft', 'mark@consulting.test', 'connected', $3, $4, now() + interval '1 hour', true) returning id`,
          [owner.workspaceId, owner.userId, encryptSecret("acct-refresh"), encryptSecret("acct-access")],
        )
      ).rows[0].id;
      await admin.query("insert into crm.mail_sources (workspace_id, user_id, account_id, email) values ($1, $2, $3, 'mark@consulting.test')", [owner.workspaceId, owner.userId, account]);
      assert.match(
        await refused(owner, blocked.fetchImpl, { mode: "reply", message_id: messageId, from: "mark@consulting.test", to: ["jane@acme.test"], body: "Hi" }),
        /^invalid_input: Replies and forwards go out from the mailbox the conversation is in, mark@eclipse\.test\./,
      );
      assert.equal(blocked.calls.length, 0);
      await admin.query("delete from crm.mail_sources where email = 'mark@consulting.test'");
    });

    it("sends a saved draft once, with its attachment and follow-up, and refuses changes alongside draft_id", async () => {
      const box = outlook();
      const admin = getAdminPool();
      process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
      process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
      try {
        const file = (
          await admin.query<{ id: string }>(
            "insert into crm.email_attachments (workspace_id, user_id, name, content_type, size) values ($1, $2, 'terms.pdf', 'application/pdf', 4) returning id",
            [owner.workspaceId, owner.userId],
          )
        ).rows[0].id;
        box.state.files.set(file, new Uint8Array([1, 2, 3, 4]).buffer);
        const sourceId = (await admin.query<{ id: string }>("select id from crm.mail_sources where user_id = $1 and email = 'mark@eclipse.test'", [owner.userId])).rows[0].id;
        const draft = await saveMailDraft(
          owner,
          {
            ...readDraftInput({ mode: "new", sourceId, to: ["jane@acme.test"], subject: "Terms", body: "Hi Jane,\n\nTerms attached.\n\nMark", followUpDays: 3, followUpBody: "Any thoughts on the terms?" }),
            attachments: [file],
          },
          { origin: "https://orbit.test", fetchImpl: box.fetchImpl, storedFiles: "keep" },
        );
        assert.equal(box.sends().length, 0);

        assert.match(await refused(owner, box.fetchImpl, { draft_id: draft.id, body: "Something else" }), /draft_id on its own/);

        const result = await send(owner, box.fetchImpl, { draft_id: draft.id });
        assert.equal(result.status, "sent");
        assert.equal(result.draftId, draft.id);
        assert.equal(result.subject, "Terms");
        assert.deepEqual(result.to, ["jane@acme.test"]);
        assert.equal(box.sends().length, 1);
        assert.ok(box.calls.some((call) => call.method === "POST" && call.url.endsWith("/attachments") && (call.body as { name: string }).name === "terms.pdf"));
        const reminder = await admin.query<{ action: string; follow_up_body: string }>(
          "select action, follow_up_body from crm.mail_reminders where user_id = $1 and kind = 'follow_up' and state = 'waiting'",
          [owner.userId],
        );
        assert.deepEqual(reminder.rows, [{ action: "send", follow_up_body: "Any thoughts on the terms?" }]);
        assert.equal((await admin.query("select 1 from crm.mail_drafts where id = $1", [draft.id])).rowCount, 0);

        const again = await send(owner, box.fetchImpl, { draft_id: draft.id });
        assert.equal(again.status, "already_sent");
        assert.equal(again.sent, false);
        assert.ok(again.sentAt);
        assert.equal(box.sends().length, 1);
      } finally {
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      }
    });

    it("sends from another sending address over SMTP", async () => {
      const box = outlook();
      const sourceId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_sources where user_id = $1", [owner.userId])).rows[0].id;
      await saveIdentity(owner, { email: "mark@ridgeon.test", sourceId, password: "secret", provider: "neo", displayName: "Mark Ridgeon" }, { check: async () => undefined });
      const smtpCalls: Parameters<SmtpSender>[1][] = [];
      const result = await send(
        owner,
        box.fetchImpl,
        { mode: "new", from: "mark@ridgeon.test", to: ["jane@acme.test"], subject: "From Ridgeon", body: "Hi Jane." },
        { smtp: async (_identity, message) => void smtpCalls.push(message), saveSent: async () => undefined },
      );
      assert.equal(result.status, "sent");
      assert.equal(result.from, "mark@ridgeon.test");
      assert.equal(smtpCalls.length, 1);
      assert.equal(smtpCalls[0].from, "mark@ridgeon.test");
      assert.match(smtpCalls[0].raw, /^From: "Mark Ridgeon" <mark@ridgeon.test>/);
      assert.equal(box.sends().length, 0);
      await getAdminPool().query("delete from crm.send_identities where id = $1", [(await listIdentities(owner))[0].id]);
    });

    it("retries a refused send with the same draft, and frees the email once that draft is deleted", async () => {
      const box = outlook();
      const args = { mode: "new", to: ["jane@acme.test"], subject: "Retry me", body: "Hi Jane, retry." };
      box.state.sendStatus = 400;
      assert.match(await refused(owner, box.fetchImpl, args), /^upstream_error: Outlook refused the recipients\./);
      box.state.sendStatus = 202;
      const retried = await send(owner, box.fetchImpl, args);
      assert.equal(retried.status, "sent");
      assert.equal(box.created().length, 1);
      assert.equal(box.sends().length, 2);

      const fresh = { ...args, subject: "Deleted after failing" };
      box.state.sendStatus = 400;
      await refused(owner, box.fetchImpl, fresh);
      const left = await getAdminPool().query<{ id: string }>("select id from crm.mail_drafts where user_id = $1 and subject = 'Deleted after failing'", [owner.userId]);
      const mcp = await connect(owner, box.fetchImpl);
      assert.ok(!(await mcp.call("mail_discard_draft", { draft_id: left.rows[0].id })).isError);
      await mcp.close();
      box.state.sendStatus = 202;
      const after = await send(owner, box.fetchImpl, fresh);
      assert.equal(after.status, "sent");
      assert.notEqual(after.draftId, left.rows[0].id);
    });

    it("says to check Sent with mail_search when Outlook's answer is lost, and never sends again on a repeat", async () => {
      const box = outlook();
      const args = { mode: "new", to: ["jane@acme.test"], subject: "Lost answer", body: "Hi Jane." };
      box.state.sendStatus = 504;
      assert.equal(await refused(owner, box.fetchImpl, args), `upstream_error: ${MAIL_SEND_MAYBE_SENT}`);
      box.state.sendStatus = 202;
      const repeat = await refused(owner, box.fetchImpl, args);
      assert.equal(repeat, `conflict: ${MAIL_SEND_MAYBE_SENT}`);
      assert.ok(!repeat.includes("Send anyway"));
      assert.equal(box.sends().length, 1);
    });
  });

  describe("scheduling", () => {
    it("schedules once, keeps the person's edits on a repeat, and answers already sent after it goes", async () => {
      const box = outlook();
      const sendAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
      const key = randomUUID();
      const args = { mode: "new", to: ["jane@acme.test"], subject: "Tomorrow", body: "Hi Jane, see you tomorrow.", send_at: sendAt, idempotency_key: key };
      const result = await send(owner, box.fetchImpl, args);
      assert.equal(result.status, "scheduled");
      assert.equal(result.sent, false);
      assert.equal(result.sendAt, sendAt);
      assert.equal(result.from, "mark@eclipse.test");
      assert.equal(box.sends().length, 0);
      const admin = getAdminPool();
      const linked = await admin.query<{ draft_id: string }>("select draft_id from crm.mail_send_keys where key = $1", [key]);
      assert.equal(linked.rows[0].draft_id, result.draftId);

      await admin.query("update crm.mail_drafts set body = 'Edited by Mark.', remind_hours = 48 where id = $1", [result.draftId]);
      const patches = box.calls.filter((call) => call.method === "PATCH").length;
      const again = await send(owner, box.fetchImpl, { ...args, send_at: new Date(Date.now() + 5 * 3_600_000).toISOString() });
      assert.equal(again.status, "scheduled");
      assert.equal(again.draftId, result.draftId);
      assert.equal(again.sendAt, sendAt);
      assert.equal(box.calls.filter((call) => call.method === "PATCH").length, patches);
      const kept = await admin.query<{ body: string; remind_hours: number }>("select body, remind_hours from crm.mail_drafts where id = $1", [result.draftId]);
      assert.deepEqual(kept.rows[0], { body: "Edited by Mark.", remind_hours: 48 });
      assert.equal(await refused(owner, box.fetchImpl, { ...args, body: "Something different." }), `conflict: ${MAIL_SEND_KEY_REUSED}`);

      await admin.query("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [result.draftId]);
      const [due] = await claimDueDrafts(owner);
      await sendMailDraft(owner, dueDraftInput(due), { origin: "https://orbit.test", fetchImpl: box.fetchImpl, storedFiles: "keep", claimed: true });
      assert.equal(box.sends().length, 1);
      const late = await send(owner, box.fetchImpl, args);
      assert.equal(late.status, "already_sent");
      assert.equal(box.sends().length, 1);
    });

    it("schedules a saved draft by id and knows when it has gone", async () => {
      const box = outlook();
      const mcp = await connect(owner, box.fetchImpl);
      const saved = await mcp.call("mail_save_draft", { mode: "new", to: ["jane@acme.test"], subject: "Later draft", body: "Hi Jane, later." });
      await mcp.close();
      const draftId = (JSON.parse(saved.content[0].text) as { draft: { id: string } }).draft.id;
      const scheduled = await send(owner, box.fetchImpl, { draft_id: draftId, send_at: new Date(Date.now() + 3_600_000).toISOString() });
      assert.equal(scheduled.status, "scheduled");
      assert.equal(scheduled.draftId, draftId);
      await getAdminPool().query("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [draftId]);
      const [due] = await claimDueDrafts(owner);
      await sendMailDraft(owner, dueDraftInput(due), { origin: "https://orbit.test", fetchImpl: box.fetchImpl, storedFiles: "keep", claimed: true });
      const repeat = await send(owner, box.fetchImpl, { draft_id: draftId, send_at: new Date(Date.now() + 3_600_000).toISOString() });
      assert.equal(repeat.status, "already_sent");
      assert.equal(box.sends().length, 1);
    });

    it("schedules the same email again once the person deleted the scheduled one", async () => {
      const box = outlook();
      const args = { mode: "new", to: ["jane@acme.test"], subject: "Deleted from Scheduled", body: "Hi Jane.", send_at: new Date(Date.now() + 3_600_000).toISOString() };
      const first = await send(owner, box.fetchImpl, args);
      await discardMailDraft(owner, first.draftId!, box.fetchImpl);
      const second = await send(owner, box.fetchImpl, args);
      assert.equal(second.status, "scheduled");
      assert.notEqual(second.draftId, first.draftId);
      const now = await send(owner, box.fetchImpl, { ...args, send_at: undefined });
      assert.equal(now.status, "sent");
      assert.equal(now.draftId, second.draftId);
      assert.equal(box.sends().length, 1);
    });
  });

  describe("limits and refusals", () => {
    it("allows 60 sends an hour across a person's tokens, and still answers repeats over the limit", async () => {
      const box = outlook();
      const args = { mode: "new", to: ["jane@acme.test"], subject: "Before the limit", body: "Hi Jane." };
      await send(owner, box.fetchImpl, args);
      const admin = getAdminPool();
      await admin.query(
        `insert into private.rate_limit_buckets (bucket_key, window_start, request_count)
         values ($1, to_timestamp(floor(extract(epoch from clock_timestamp()) / 3600) * 3600), 60)
         on conflict (bucket_key) do update set window_start = excluded.window_start, request_count = 60`,
        [`mail-send:${owner.userId}`],
      );
      try {
        const limited = await refused(owner, box.fetchImpl, { ...args, subject: "Over the limit" });
        assert.match(limited, /^rate_limited: 60 emails have been sent or scheduled through MCP this hour, the most Orbit allows\. Try again after \d\d:00 London time\.$/);
        assert.equal((await send(owner, box.fetchImpl, args)).status, "already_sent");
        assert.equal(box.sends().length, 1);
      } finally {
        await admin.query("delete from private.rate_limit_buckets where bucket_key = $1", [`mail-send:${owner.userId}`]);
      }
    });

    it("refuses someone else's draft", async () => {
      const theirs = outlook();
      const sourceId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_sources where user_id = $1", [other.userId])).rows[0].id;
      const draft = await saveMailDraft(other, readDraftInput({ mode: "new", sourceId, to: ["jane@acme.test"], subject: "Private", body: "Not Mark's to send." }), {
        origin: null,
        fetchImpl: theirs.fetchImpl,
        storedFiles: "keep",
      });
      const box = outlook();
      assert.match(await refused(owner, box.fetchImpl, { draft_id: draft.id }), /^not_found: That draft isn't in Mail any more/);
      assert.equal(box.calls.length, 0);
      assert.equal((await getAdminPool().query("select 1 from crm.mail_drafts where id = $1", [draft.id])).rowCount, 1);
    });

    it("refuses an unknown From address, a missing recipient and a reply without its email", async () => {
      const box = outlook();
      const before = await draftCount(owner);
      assert.match(
        await refused(owner, box.fetchImpl, { mode: "new", from: "ceo@elsewhere.test", to: ["jane@acme.test"], subject: "Hello", body: "Hi" }),
        /^invalid_input: You can't send from ceo@elsewhere\.test\. You can send from: mark@eclipse\.test\.$/,
      );
      assert.match(await refused(owner, box.fetchImpl, { mode: "new", subject: "Hello", body: "Hi" }), /^invalid_input: Add a recipient\.$/);
      assert.match(await refused(owner, box.fetchImpl, { mode: "reply", to: ["jane@acme.test"], body: "Hi" }), /need message_id/);
      assert.equal(box.calls.length, 0);
      assert.equal(await draftCount(owner), before);
    });
  });
});
