import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import type { Actor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase } from "./helpers";

type Answer = { content: { type: string; text: string }[]; isError?: boolean };

type Page = { id: string; transcript: string; totalLength: number; offset: number; nextOffset: number | null };

async function connect(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "transcript-test", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function call(actor: Actor, name: string, args: Record<string, unknown>) {
  const mcp = await connect(actor);
  try {
    return (await mcp.client.callTool({ name, arguments: args })) as Answer;
  } finally {
    await mcp.close();
  }
}

const TRANSCRIPT = Array.from(
  { length: 3000 },
  (_, index) => `${index % 2 ? "Jane Doe" : "Mark Ridgeon"}: marker-${index}-end ${"word ".repeat(30).trim()}`,
).join("\n");

describe("MCP call transcripts", () => {
  let owner: UserActor;
  let companyId: string;
  let insightId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mcp-transcript@example.com", "Mark Ridgeon");
    const company = await createCompany(owner, { name: "Acme", domain: "acme.test" });
    companyId = company.body.company.id;
    const contact = await createContact(owner, { companyId, firstName: "Jane", lastName: "Doe" });
    const logged = await createActivity(owner, {
      type: "call",
      title: "Call with Jane Doe",
      body: "Outgoing call",
      contactId: contact.body.contact.id,
      companyId,
      occurredAt: "2026-10-15T13:00:00.000Z",
    });
    const inserted = await getAdminPool().query<{ id: string }>(
      `insert into crm.call_insights (workspace_id, activity_id, contact_id, company_id, source, transcript, summary, status)
       values ($1, $2, $3, $4, 'manual', $5, 'Mark and Jane reviewed the quote.', 'ready') returning id`,
      [owner.workspaceId, logged.body.activity.id, contact.body.contact.id, companyId, TRANSCRIPT],
    );
    insightId = inserted.rows[0].id;
  });

  after(async () => {
    await getPool().end();
  });

  it("lists a read-only transcript tool and says where the full transcript is", async () => {
    const mcp = await connect(owner);
    try {
      const tools = (await mcp.client.listTools()).tools;
      const tool = tools.find((item) => item.name === "get_call_transcript");
      assert.ok(tool);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.match(tool.description ?? "", /nextOffset/);
      assert.match(tools.find((item) => item.name === "get_company_context")?.description ?? "", /get_call_transcript/);
      assert.match(mcp.client.getInstructions() ?? "", /full transcript behind one can be read with get_call_transcript/);
    } finally {
      await mcp.close();
    }
  });

  it("shows the summary with a hint to the full transcript in company context", async () => {
    const answer = await call(owner, "get_company_context", { id: companyId });
    assert.ok(!answer.isError, answer.content[0].text);
    const context = JSON.parse(answer.content[0].text) as {
      insights: Record<string, { id: string; summary: string; transcript: { length: number; tool: string } }>;
    };
    const insight = Object.values(context.insights)[0];
    assert.equal(insight.id, insightId);
    assert.equal(insight.summary, "Mark and Jane reviewed the quote.");
    assert.deepEqual(insight.transcript, { length: TRANSCRIPT.length, tool: "get_call_transcript" });
    assert.ok(!answer.content[0].text.includes("marker-"));
  });

  it("reads the whole transcript across pages with no gaps or overlaps", async () => {
    let offset = 0;
    let joined = "";
    let pages = 0;
    for (;;) {
      const answer = await call(owner, "get_call_transcript", offset === 0 ? { id: insightId } : { id: insightId, offset });
      assert.ok(!answer.isError, answer.content[0].text);
      const page = JSON.parse(answer.content[0].text) as Page;
      assert.equal(page.totalLength, TRANSCRIPT.length);
      assert.equal(page.offset, offset);
      joined += page.transcript;
      pages += 1;
      if (page.nextOffset === null) break;
      assert.equal(page.nextOffset, offset + page.transcript.length);
      offset = page.nextOffset;
    }
    assert.ok(pages >= 3);
    assert.equal(joined, TRANSCRIPT);
  });

  it("refuses another workspace and a token without crm:read", async () => {
    const other = await createUser("mcp-transcript-other@example.com", "Other Person");
    const refused = await call(other, "get_call_transcript", { id: insightId });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /not_found/);
    assert.ok(!refused.content[0].text.includes("marker-"));
    const writer = await createAgent(owner.workspaceId, ["tasks:write"]);
    const forbidden = await call(writer.actor, "get_call_transcript", { id: insightId });
    assert.equal(forbidden.isError, true);
    assert.match(forbidden.content[0].text, /crm:read/);
    const elsewhere = await createAgent(other.workspaceId, ["crm:read"]);
    const blocked = await call(elsewhere.actor, "get_call_transcript", { id: insightId });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /not_found/);
  });
});
