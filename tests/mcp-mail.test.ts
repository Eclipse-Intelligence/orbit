import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { createPersonalToken, listPersonalTokens, revokePersonalToken } from "@/lib/auth/personal";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { syncMail } from "@/lib/mail/sync";
import { registerMailTools } from "@/server/mcp/mail";
import { createAgent, createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

function outlook() {
  const calls: { method: string; url: string; body: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ method, url: url.replace(GRAPH, ""), body: typeof init?.body === "string" ? init.body : null });
    if (url.endsWith("/createReply")) return Response.json({ id: "draft-1", subject: "RE: Pricing", body: { contentType: "html", content: "<html><body></body></html>" } }, { status: 201 });
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
              subject: "Pricing",
              bodyPreview: "What would 20 seats cost?",
              body: { contentType: "text", content: "What would 20 seats cost?\n\nOn Mon, Mark wrote:\n> earlier" },
              from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
              toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
              receivedDateTime: "2026-10-19T09:00:00Z",
              isRead: false,
            },
          ],
      "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=1`,
    });
  };
  return { fetchImpl, calls };
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await mcpRoute(
    new Request("http://crm.test/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return { status: response.status, body: (await response.json()) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } } };
}

describe("mail over MCP with a personal token", () => {
  let owner: UserActor;
  let token: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mcp-mail@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    token = (await createPersonalToken(owner, "Claude")).token;
  });

  after(async () => {
    await getPool().end();
  });

  it("issues a personal token that is stored only as a hash", async () => {
    assert.match(token, /^orbit_[0-9a-f]{8}_/);
    const stored = await getAdminPool().query<{ token_hash: string }>("select token_hash from crm.personal_tokens");
    assert.equal(stored.rows.length, 1);
    assert.ok(!stored.rows[0].token_hash.includes(token.slice(15)));
    const listed = await listPersonalTokens(owner);
    assert.equal(listed[0].name, "Claude");
    assert.equal(listed[0].prefix, token.split("_").slice(0, 2).join("_"));
  });

  it("gives a personal token the mail tools, but never a send tool, and keeps them from workspace agents", async () => {
    const personal = await rpc(token, "tools/list");
    const names = personal.body.result!.tools!.map((tool) => tool.name);
    for (const name of ["mail_accounts", "mail_search", "mail_get_thread", "mail_read_attachments", "mail_ask", "mail_save_draft", "mail_discard_draft", "search_companies"]) {
      assert.ok(names.includes(name), name);
    }
    assert.ok(!names.some((name) => /send/.test(name)));
    const agent = await createAgent(owner.workspaceId, ["crm:read"]);
    const agentTools = (await rpc(agent.token, "tools/list")).body.result!.tools!.map((tool) => tool.name);
    assert.ok(!agentTools.some((name) => name.startsWith("mail_")));
  });

  it("searches and reads the person's mail", async () => {
    const search = await rpc(token, "tools/call", { name: "mail_search", arguments: { view: "inbox" } });
    const threads = JSON.parse(search.body.result!.content![0].text).threads as { key: string; subject: string }[];
    assert.equal(threads[0].subject, "Pricing");
    const thread = await rpc(token, "tools/call", { name: "mail_get_thread", arguments: { key: threads[0].key } });
    const detail = JSON.parse(thread.body.result!.content![0].text) as { messages: { text: string; from: { address: string } }[] };
    assert.equal(detail.messages[0].text, "What would 20 seats cost?");
    assert.equal(detail.messages[0].from.address, "jane@acme.test");
  });

  it("saves a reply as a draft without sending it", async () => {
    const { fetchImpl, calls } = outlook();
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerMailTools(server, owner, { fetchImpl });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    const messageId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'm-1'")).rows[0].id;
    const result = (await client.callTool({ name: "mail_save_draft", arguments: { mode: "reply", message_id: messageId, to: ["jane@acme.test"], body: "Hi Jane,\n\n20 seats is [price].\n\nMark" } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    assert.ok(!result.isError, result.content[0].text);
    const saved = JSON.parse(result.content[0].text) as { sent: boolean; draft: { id: string } };
    assert.equal(saved.sent, false);
    assert.ok(calls.some((call) => call.url.endsWith("/createReply")));
    assert.ok(!calls.some((call) => call.url.endsWith("/send")));
    const drafts = await getAdminPool().query<{ body: string }>("select body from crm.mail_drafts where id = $1", [saved.draft.id]);
    assert.match(drafts.rows[0].body, /20 seats is \[price\]/);
    await client.close();
  });

  it("stops working once revoked", async () => {
    const id = (await listPersonalTokens(owner))[0].id;
    await revokePersonalToken(owner, id);
    const response = await rpc(token, "tools/list");
    assert.equal(response.status, 401);
  });
});
