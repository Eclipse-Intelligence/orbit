import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ASSISTANT_TOOLS, CORE_TOOLS, TOOL_DOMAIN_NAMES, TOOL_DOMAINS } from "@/lib/assistant/tools";
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
  const server = createCrmMcpServer(actor, actor.type === "user" ? { workspaces: [{ id: "00000000-0000-4000-8000-000000000005", name: "Mark Ridgeon" }] } : {});
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

  it("keeps the core tools small and every tool in one place", () => {
    assert.ok(
      CORE_TOOLS.length <= 24,
      `The assistant sends ${CORE_TOOLS.length} core tools on every call. Keep it to 24 or fewer and put the rest in an area of TOOL_DOMAINS (see "Adding a tool" in docs/assistant.md).`,
    );
    assert.ok(
      ASSISTANT_TOOLS.length <= 128,
      `The assistant has ${ASSISTANT_TOOLS.length} tools. A conversation that loads every area sends them all, and some model APIs refuse requests with more than 128 tools. Merge overlapping tools to get back to 128 or fewer.`,
    );
    const placed = [...CORE_TOOLS, ...TOOL_DOMAIN_NAMES.flatMap((domain) => TOOL_DOMAINS[domain].tools)];
    const names = ASSISTANT_TOOLS.map((tool) => tool.name);
    const unplaced = names.filter((name) => !placed.includes(name));
    assert.deepEqual(unplaced, [], `Put these tools in CORE_TOOLS or an area of TOOL_DOMAINS: ${unplaced.join(", ")}`);
    const twice = placed.filter((name, index) => placed.indexOf(name) !== index);
    assert.deepEqual(twice, [], `These tools are in more than one place: ${twice.join(", ")}`);
    const unknown = placed.filter((name) => !names.includes(name));
    assert.deepEqual(unknown, [], `These names in CORE_TOOLS or TOOL_DOMAINS aren't tools: ${unknown.join(", ")}`);
  });

  it("describes every assistant tool parameter, nested ones included", () => {
    type Schema = { description?: unknown; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[] };
    const missing: string[] = [];
    const walk = (tool: string, at: string, schema: Schema | undefined) => {
      if (!schema || typeof schema !== "object") return;
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        const path = at ? `${at}.${key}` : key;
        if (typeof child?.description !== "string" || !child.description.trim()) missing.push(`${tool}.${path}`);
        walk(tool, path, child);
      }
      if (schema.items) walk(tool, `${at}[]`, schema.items);
      for (const option of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) walk(tool, at, option);
    };
    for (const tool of ASSISTANT_TOOLS) walk(tool.name, "", tool.parameters as Schema);
    assert.deepEqual(missing, [], `Describe these assistant tool parameters: ${missing.join(", ")}`);
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
