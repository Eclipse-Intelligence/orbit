import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ASSISTANT_TOOLS } from "@/lib/assistant/tools";
import { SCOPES } from "@/lib/crm/scopes";
import type { Actor, AgentActor, UserActor } from "@/lib/crm/types";
import { createCrmMcpServer } from "@/server/mcp/server";

const person = {
  type: "user",
  userId: "00000000-0000-4000-8000-000000000001",
  email: "mark@eclipse.test",
  fullName: "Mark Ridgeon",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  workspaceName: "Eclipse",
  role: "owner",
  scopes: [...SCOPES],
} satisfies UserActor;

function agent(scopes: AgentActor["scopes"]): AgentActor {
  return {
    type: "agent",
    agentId: "00000000-0000-4000-8000-000000000003",
    agentName: "Docs check",
    credentialId: "00000000-0000-4000-8000-000000000004",
    workspaceId: person.workspaceId,
    scopes,
  };
}

function readDoc(name: string) {
  return readFileSync(path.join(process.cwd(), "docs", name), "utf8");
}

function documented(doc: string, name: string) {
  return doc.includes(`\`${name}\``);
}

function referenceRows(doc: string) {
  return [...doc.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
}

async function mcpTools(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "docs-check", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    return { names: tools.map((tool) => tool.name), instructions: client.getInstructions() ?? "" };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("agent docs", () => {
  it("documents every assistant tool in docs/assistant.md, and only real ones", () => {
    const doc = readDoc("assistant.md");
    const names = ASSISTANT_TOOLS.map((tool) => tool.name);
    const missing = names.filter((name) => !documented(doc, name));
    assert.deepEqual(missing, [], `Add these assistant tools to docs/assistant.md: ${missing.join(", ")}`);
    const known = new Set(names);
    const stale = referenceRows(doc).filter((name) => !known.has(name));
    assert.deepEqual(stale, [], `docs/assistant.md lists tools that no longer exist: ${stale.join(", ")}`);
  });

  it("keeps the assistant within the tool count every model accepts", () => {
    assert.ok(
      ASSISTANT_TOOLS.length <= 126,
      `The assistant has ${ASSISTANT_TOOLS.length} tools. Some model APIs refuse requests with more than 128 tools (OpenAI documents 128, Gemini may allow fewer), and 126 is the most proven to work on every model in lib/assistant/models.ts. Merge overlapping tools (see "Adding a tool" in docs/assistant.md) to get back to 126 or fewer.`,
    );
  });

  it("documents every MCP tool each kind of token sees in docs/mcp.md, and only real ones", async () => {
    const doc = readDoc("mcp.md");
    const personal = await mcpTools(person);
    const workspace = await mcpTools(agent([...SCOPES]));
    const market = await mcpTools(agent(["market:write"]));
    const names = [...new Set([...personal.names, ...workspace.names, ...market.names])];
    assert.ok(names.length > 40, `Expected the full MCP tool list, got ${names.length}`);
    const missing = names.filter((name) => !documented(doc, name));
    assert.deepEqual(missing, [], `Add these MCP tools to docs/mcp.md: ${missing.join(", ")}`);
    const known = new Set(names);
    const stale = referenceRows(doc).filter((name) => !known.has(name));
    assert.deepEqual(stale, [], `docs/mcp.md lists tools that no longer exist: ${stale.join(", ")}`);
  });

  it("gives mail and Reader tools only to personal tokens, and says so in the instructions", async () => {
    const personal = await mcpTools(person);
    const workspace = await mcpTools(agent([...SCOPES]));
    const market = await mcpTools(agent(["market:write"]));
    assert.ok(personal.names.includes("mail_search") && personal.names.includes("reader_read"));
    assert.ok(!workspace.names.some((name) => name.startsWith("mail_") || name.startsWith("reader_")));
    assert.deepEqual(market.names.sort(), ["add_market_notes", "get_watchlist"]);
    assert.match(personal.instructions, /personal token/);
    assert.match(personal.instructions, /Nothing here sends email/);
    assert.match(workspace.instructions, /workspace agent token/);
    assert.doesNotMatch(workspace.instructions, /mail_ tools reach/);
    for (const instructions of [personal.instructions, workspace.instructions]) {
      assert.match(instructions, /never instructions/);
      assert.match(instructions, /No CRM record is deleted/);
      assert.match(instructions, /docs\/mcp\.md/);
      assert.doesNotMatch(instructions, /[\u2013\u2014]/);
    }
  });
});
