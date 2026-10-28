import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentActor } from "@/lib/crm/types";
import { createCrmMcpServer } from "@/server/mcp/server";

function agent(scopes: AgentActor["scopes"]): AgentActor {
  return {
    type: "agent",
    agentId: "00000000-0000-4000-8000-000000000003",
    agentName: "Tool check",
    credentialId: "00000000-0000-4000-8000-000000000004",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    scopes,
  };
}

async function listed(actor: AgentActor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "tool-check", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP tool definitions", () => {
  it("only gives the market-only server to tokens that have market:write and nothing else", async () => {
    const market = (await listed(agent(["market:write"]))).map((tool) => tool.name);
    assert.ok(market.includes("add_market_notes"));
    assert.ok(!market.includes("search_opportunities"));
    const empty = (await listed(agent([]))).map((tool) => tool.name);
    assert.ok(empty.includes("search_opportunities"));
  });

  it("lets create_webhook subscribe to every event and list_pipeline_stages take no arguments", async () => {
    const tools = await listed(agent(["crm:read", "admin"]));
    const webhook = tools.find((tool) => tool.name === "create_webhook");
    assert.ok(JSON.stringify(webhook?.inputSchema.properties?.events).includes('"*"'));
    const stages = tools.find((tool) => tool.name === "list_pipeline_stages");
    assert.deepEqual(Object.keys(stages?.inputSchema.properties ?? {}), []);
    const search = tools.find((tool) => tool.name === "search_opportunities");
    assert.match(search?.description ?? "", /board cards/);
  });
});
