import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { createPersonalToken } from "@/lib/auth/personal";
import { listActivities } from "@/lib/crm/activities";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { claimDueDrafts, dueDraftInput, readDraftInput, saveMailDraft, sendMailDraft } from "@/lib/mail/compose";
import { syncMail } from "@/lib/mail/sync";
import { listThreads } from "@/lib/mail/threads";
import { registerMailTools } from "@/server/mcp/mail";
import { createAgent, createUser, resetDatabase } from "./helpers";

process.env.SITE_URL = "https://orbit.test";

const GRAPH = "https://graph.microsoft.com/v1.0";

let made = 0;

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function inboxMessage() {
  return {
    id: "m-1",
    internetMessageId: "<m-1@acme.test>",
    conversationId: "conv-renewal",
    subject: "Renewal pricing",
    bodyPreview: "Can we talk about the renewal price?",
    body: { contentType: "html", content: "<p>Can we talk about the renewal price?</p>" },
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
}

function outlook(inbox: unknown[] = []) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      calls.push({ method, url: url.replace(GRAPH, ""), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "POST" && url === `${GRAPH}/me/messages`) {
        made += 1;
        return Response.json({ id: `draft-${made}`, conversationId: `conv-new-${made}`, subject: "" }, { status: 201 });
      }
      if (/\/(createReply|createReplyAll|createForward)$/.test(url)) {
        made += 1;
        return Response.json(
          { id: `draft-${made}`, conversationId: "conv-renewal", subject: "RE: Renewal pricing", body: { contentType: "html", content: "<html><body><div>Jane wrote</div></body></html>" } },
          { status: 201 },
        );
      }
      if (url.endsWith("/send")) return new Response(null, { status: 202 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id: "patched" });
    }
    const asked = url.match(/\/me\/messages\/([^/?]+)\?\$select=internetMessageId$/)?.[1];
    if (asked) return Response.json({ internetMessageId: `<${decodeURIComponent(asked)}@eclipse.test>` });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    return Response.json({ value: url.includes("/messages/delta") ? inbox : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=${Math.random()}` });
  };
  const sends = () => calls.filter((call) => call.method === "POST" && call.url.endsWith("/send"));
  return { fetchImpl, calls, sends };
}

type ToolAnswer = { content: { text: string }[]; isError?: boolean };

type Sent = {
  sent: boolean;
  scheduled: boolean;
  alreadySent: boolean;
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

async function connect(actor: UserActor, fetchImpl: typeof fetch) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerMailTools(server, actor, { fetchImpl });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolAnswer,
    close: () => client.close(),
  };
}

async function send(actor: UserActor, fetchImpl: typeof fetch, args: Record<string, unknown>) {
  const mcp = await connect(actor, fetchImpl);
  try {
    const answer = await mcp.call("mail_send", args);
    assert.ok(!answer.isError, answer.content[0].text);
    return JSON.parse(answer.content[0].text) as Sent;
  } finally {
    await mcp.close();
  }
}

async function refused(actor: UserActor, fetchImpl: typeof fetch, args: Record<string, unknown>) {
  const mcp = await connect(actor, fetchImpl);
  try {
    const answer = await mcp.call("mail_send", args);
    assert.equal(answer.isError, true, answer.content[0].text);
    return answer.content[0].text;
  } finally {
    await mcp.close();
  }
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

describe("sending email over MCP", () => {
  let owner: UserActor;
  let other: UserActor;
  let jane: string;
  let messageId: string;
  let thread: string;

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
    other = await createUser("someone-else@orbit.test", "Sam Other");
    await saveMailbox(other, { email: "sam@other.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(other, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
  });

  after(async () => {
    await getPool().end();
  });

  it("gives mail_send to a personal token and never to a workspace agent token", async () => {
    const personal = await listTools((await createPersonalToken(owner, "Claude")).token);
    const tool = personal.find((item) => item.name === "mail_send");
    assert.ok(tool);
    assert.equal(tool.annotations?.destructiveHint, true);
    const agent = await createAgent(owner.workspaceId, ["crm:read", "admin"]);
    const names = (await listTools(agent.token)).map((item) => item.name);
    assert.ok(names.includes("search_companies"));
    assert.ok(!names.includes("mail_send"));
    assert.ok(!names.some((name) => name.startsWith("mail_")));
  });

  it("composes and sends a new email with the signature and read tracking, and files it on the contact", async () => {
    const box = outlook();
    const result = await send(owner, box.fetchImpl, { mode: "new", to: ["jane@acme.test"], subject: "Proposal", body: "Hi Jane,\n\nThe proposal is attached.\n\nMark" });
    assert.equal(result.sent, true);
    assert.equal(result.scheduled, false);
    assert.equal(result.alreadySent, false);
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
    const html = (box.calls[1].body as { body: { content: string } }).body.content;
    assert.match(html, /Mark Ridgeon, Eclipse/);
    const pixel = html.match(/https:\/\/orbit\.test\/api\/mail\/open\/([0-9a-f-]{36})/)?.[1];
    assert.ok(pixel, "read tracking pixel");
    const admin = getAdminPool();
    const tracking = await admin.query<{ sent: boolean; subject: string }>("select sent_at is not null as sent, subject from crm.mail_tracking where id = $1", [pixel]);
    assert.deepEqual(tracking.rows[0], { sent: true, subject: "Proposal" });
    assert.equal((await admin.query("select 1 from crm.mail_drafts where id = $1", [result.draftId])).rowCount, 0);
    const filed = (await listActivities(owner, { limit: 20 })).data.find((item) => item.title === "Proposal");
    assert.equal(filed?.contactId, jane);
    assert.equal(filed?.metadata.direction, "outbound");
    assert.equal(filed?.metadata.from, "mark@eclipse.test");
  });

  it("sends the same call once when it is repeated", async () => {
    const box = outlook();
    const args = { mode: "new", to: ["jane@acme.test"], subject: "Checking in", body: "Hi Jane, any news?" };
    const first = await send(owner, box.fetchImpl, args);
    const second = await send(owner, box.fetchImpl, args);
    assert.equal(first.sent, true);
    assert.equal(first.alreadySent, false);
    assert.equal(second.alreadySent, true);
    assert.equal(second.idempotencyKey, first.idempotencyKey);
    assert.match(second.warning ?? "", /didn't send it again/);
    assert.equal(box.sends().length, 1);

    const key = randomUUID();
    await send(owner, box.fetchImpl, { ...args, idempotency_key: key });
    const retried = await send(owner, box.fetchImpl, { ...args, body: "Hi Jane, any news? (retry)", idempotency_key: key });
    assert.equal(retried.alreadySent, true);
    assert.equal(box.sends().length, 2);

    const together = { ...args, subject: "Both at once" };
    const mcp = await connect(owner, box.fetchImpl);
    const answers = await Promise.all([mcp.call("mail_send", together), mcp.call("mail_send", together)]);
    await mcp.close();
    assert.equal(box.sends().length, 3);
    const texts = answers.map((answer) => answer.content[0].text);
    assert.ok(texts.some((text) => !text.startsWith("conflict") && JSON.parse(text).alreadySent === false), texts.join("\n"));
  });

  it("replies in the conversation from the address the email came to", async () => {
    const box = outlook();
    const result = await send(owner, box.fetchImpl, { mode: "reply", message_id: messageId, to: ["jane@acme.test"], body: "Hi Jane,\n\nHappy to talk.\n\nMark" });
    assert.equal(result.sent, true);
    assert.equal(result.mode, "reply");
    assert.equal(result.messageId, messageId);
    assert.equal(result.from, "mark@eclipse.test");
    assert.equal(result.subject, "RE: Renewal pricing");
    assert.equal(result.thread, thread);
    assert.ok(box.calls[0].url.endsWith("/createReply"));
    assert.equal(box.sends().length, 1);
    const filed = (await listActivities(owner, { limit: 20 })).data.find((item) => item.title === "RE: Renewal pricing");
    assert.equal(filed?.contactId, jane);
  });

  it("sends a draft saved earlier exactly once, and refuses changes alongside draft_id", async () => {
    const box = outlook();
    const mcp = await connect(owner, box.fetchImpl);
    const saved = await mcp.call("mail_save_draft", { mode: "new", to: ["jane@acme.test"], subject: "Terms", body: "Hi Jane,\n\nTerms below.\n\nMark" });
    await mcp.close();
    const draftId = (JSON.parse(saved.content[0].text) as { draft: { id: string } }).draft.id;
    assert.equal(box.sends().length, 0);

    assert.match(await refused(owner, box.fetchImpl, { draft_id: draftId, body: "Something else" }), /draft_id on its own/);

    const result = await send(owner, box.fetchImpl, { draft_id: draftId });
    assert.equal(result.sent, true);
    assert.equal(result.draftId, draftId);
    assert.equal(result.subject, "Terms");
    assert.deepEqual(result.to, ["jane@acme.test"]);
    assert.equal(box.sends().length, 1);
    assert.equal((await getAdminPool().query("select 1 from crm.mail_drafts where id = $1", [draftId])).rowCount, 0);

    const again = await send(owner, box.fetchImpl, { draft_id: draftId });
    assert.equal(again.alreadySent, true);
    assert.equal(box.sends().length, 1);
  });

  it("schedules with send_at instead of sending, once, and knows when the scheduled email has gone", async () => {
    const box = outlook();
    const sendAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const args = { mode: "new", to: ["jane@acme.test"], subject: "Tomorrow", body: "Hi Jane, see you tomorrow.", send_at: sendAt };
    const result = await send(owner, box.fetchImpl, args);
    assert.equal(result.sent, false);
    assert.equal(result.scheduled, true);
    assert.equal(result.sendAt, sendAt);
    assert.equal(result.from, "mark@eclipse.test");
    assert.equal(box.sends().length, 0);
    const again = await send(owner, box.fetchImpl, args);
    assert.equal(again.scheduled, true);
    assert.equal(again.draftId, result.draftId);
    const admin = getAdminPool();
    const scheduled = await admin.query<{ id: string }>("select id from crm.mail_drafts where user_id = $1 and send_at is not null", [owner.userId]);
    assert.deepEqual(scheduled.rows.map((row) => row.id), [result.draftId]);

    await admin.query("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [result.draftId]);
    const [due] = await claimDueDrafts(owner);
    await sendMailDraft(owner, dueDraftInput(due), { origin: "https://orbit.test", fetchImpl: box.fetchImpl, storedFiles: "keep", claimed: true });
    assert.equal(box.sends().length, 1);
    const late = await send(owner, box.fetchImpl, args);
    assert.equal(late.alreadySent, true);
    assert.equal(box.sends().length, 1);
  });

  it("refuses someone else's draft", async () => {
    const theirs = outlook();
    const draft = await saveMailDraft(
      other,
      readDraftInput({ mode: "new", sourceId: (await getAdminPool().query<{ id: string }>("select id from crm.mail_sources where user_id = $1", [other.userId])).rows[0].id, to: ["jane@acme.test"], subject: "Private", body: "Not Mark's to send." }),
      { origin: null, fetchImpl: theirs.fetchImpl, storedFiles: "keep" },
    );
    const box = outlook();
    assert.match(await refused(owner, box.fetchImpl, { draft_id: draft.id }), /^not_found: That draft isn't in Mail any more/);
    assert.equal(box.calls.length, 0);
    assert.equal((await getAdminPool().query("select 1 from crm.mail_drafts where id = $1", [draft.id])).rowCount, 1);
  });

  it("refuses an unknown From address, a missing recipient and a reply without its email", async () => {
    const box = outlook();
    assert.match(
      await refused(owner, box.fetchImpl, { mode: "new", from: "ceo@elsewhere.test", to: ["jane@acme.test"], subject: "Hello", body: "Hi" }),
      /^invalid_input: You can't send from ceo@elsewhere\.test\. You can send from: mark@eclipse\.test\.$/,
    );
    assert.match(await refused(owner, box.fetchImpl, { mode: "new", subject: "Hello", body: "Hi" }), /^invalid_input: Add a recipient\.$/);
    assert.match(await refused(owner, box.fetchImpl, { mode: "reply", to: ["jane@acme.test"], body: "Hi" }), /need message_id/);
    assert.equal(box.calls.length, 0);
  });
});
