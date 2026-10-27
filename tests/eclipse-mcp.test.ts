import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { z } from "zod";
import { shapeFor } from "@/companion/src/schema";
import { describeAction, runTool, toolDefinitions } from "@/lib/assistant/tools";
import type { UserActor } from "@/lib/crm/types";
import { callEclipseTool, clearEclipseToolCache, eclipseGuide, findEclipseTools } from "@/lib/eclipse-mcp";

const actor = { type: "user", userId: "u", workspaceId: "w", email: "mark@eclipse.test", fullName: "Mark", role: "owner", scopes: [] } as unknown as UserActor;

const TOOLS = [
  { name: "list_clients", description: "List the clients. This read is free and changes nothing.", inputSchema: { type: "object", properties: {} } },
  { name: "geo_trends", description: "AI visibility trends for a GEO profile over time.", inputSchema: { type: "object", properties: { profileId: { type: "number" } } } },
  { name: "update_client_details", description: "Update the client's details.", inputSchema: { type: "object", properties: { website: { type: "string" } } } },
  { name: "start_deep_research", description: "Start deep research. This is a paid tool.", inputSchema: { type: "object", properties: { question: { type: "string" }, confirm: { type: "boolean" }, idempotencyKey: { type: "string" } } } },
];

type Sent = { method: string; params: { name?: string; arguments?: Record<string, unknown> }; auth: string | null };

function server(options: { sse?: boolean; big?: boolean } = {}) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ method: body.method, params: body.params, auth: new Headers(init?.headers).get("authorization") });
    let result: unknown;
    if (body.method === "initialize") result = { instructions: "You are connected to Eclipse. Start with list_clients." };
    else if (body.method === "tools/list") result = { tools: TOOLS };
    else result = { content: [{ type: "text", text: options.big ? "x".repeat(250_000) : JSON.stringify({ called: body.params.name, args: body.params.arguments }) }] };
    const json = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    return options.sse
      ? new Response(`event: message\ndata: ${json}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : new Response(json, { headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, sent };
}

describe("Eclipse MCP", () => {
  beforeEach(() => {
    process.env.ECLIPSE_MCP_TOKEN = "ecl_pat_test";
    clearEclipseToolCache();
  });

  afterEach(() => {
    delete process.env.ECLIPSE_MCP_TOKEN;
  });

  it("reads the guide and finds tools by what they do, marking reads and approvals", async () => {
    const { fetchImpl, sent } = server();
    assert.match(await eclipseGuide({ fetchImpl }), /Start with list_clients/);
    const found = await findEclipseTools("geo trends", { fetchImpl });
    assert.equal(found.total, 4);
    assert.equal(found.tools[0].name, "geo_trends");
    assert.equal(found.tools[0].kind, "read");
    const all = await findEclipseTools("client research", { fetchImpl, limit: 10 });
    assert.deepEqual(
      Object.fromEntries(all.tools.map((tool) => [tool.name, tool.kind])),
      {
        list_clients: "read",
        update_client_details: "needs approval (changes data)",
        start_deep_research: "needs approval (costs or consequences, can be previewed)",
      },
    );
    assert.equal(sent[0].auth, "Bearer ecl_pat_test");
    assert.equal(sent.filter((call) => call.method === "tools/list").length, 1);
  });

  it("runs reads, previews paid tools without confirming, and confirms only after approval", async () => {
    const { fetchImpl, sent } = server({ sse: true });
    const read = await callEclipseTool("list_clients", {}, "read", { fetchImpl });
    assert.match(read.result, /"called":"list_clients"/);
    await assert.rejects(callEclipseTool("update_client_details", { website: "x" }, "read", { fetchImpl }), /needs the user's approval\. Use eclipse_action/);
    const preview = await callEclipseTool("start_deep_research", { question: "Who leads AI search?", confirm: true, idempotencyKey: "mine" }, "read", { fetchImpl });
    assert.match(preview.preview!, /preview only/);
    assert.deepEqual(sent.at(-1)!.params.arguments, { question: "Who leads AI search?" });
    await callEclipseTool("start_deep_research", { question: "Who leads AI search?" }, "action", { fetchImpl });
    const confirmed = sent.at(-1)!.params.arguments!;
    assert.equal(confirmed.confirm, true);
    assert.match(String(confirmed.idempotencyKey), /^[0-9a-f-]{36}$/);
    await callEclipseTool("update_client_details", { website: "https://acme.test" }, "action", { fetchImpl });
    assert.deepEqual(sent.at(-1)!.params.arguments, { website: "https://acme.test" });
    await assert.rejects(callEclipseTool("made_up", {}, "read", { fetchImpl }), /no tool called made_up/);
  });

  it("cuts very long results and explains when Eclipse isn't connected", async () => {
    const { fetchImpl } = server({ big: true });
    const long = await callEclipseTool("list_clients", {}, "read", { fetchImpl });
    assert.match(long.result, /Cut at 200000 characters/);
    delete process.env.ECLIPSE_MCP_TOKEN;
    clearEclipseToolCache();
    await assert.rejects(findEclipseTools("clients", { fetchImpl }), /Add ECLIPSE_MCP_TOKEN/);
  });

  it("keeps the arguments when they come as JSON text, through the Orbit Agent's validator too", async () => {
    const { fetchImpl, sent } = server();
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const read = (await runTool(actor, "eclipse_read", { tool: "geo_trends", argumentsJson: '{"profileId": 7}' })) as { result: string };
      assert.match(read.result, /"profileId":7/);
      assert.deepEqual(sent.at(-1)!.params.arguments, { profileId: 7 });
      const bad = (await runTool(actor, "eclipse_read", { tool: "geo_trends", argumentsJson: "{profileId: 7" })) as { error: string };
      assert.match(bad.error, /isn't valid JSON/);
    } finally {
      globalThis.fetch = original;
    }
    const definition = toolDefinitions().find((tool) => tool.function.name === "eclipse_read")!.function.parameters;
    const parsed = z.object(shapeFor(definition)).parse({ tool: "get_canvas", argumentsJson: '{"canvasId": 12}' });
    assert.equal(parsed.argumentsJson, '{"canvasId": 12}');
    const loose = z.object(shapeFor({ type: "object", properties: { arguments: { type: "object" } } })).parse({ arguments: { canvasId: 12 } });
    assert.deepEqual(loose.arguments, { canvasId: 12 });
  });

  it("stops a slow read, but lets an approved action finish and reuses its key on a retry", async () => {
    const original = globalThis.fetch;
    const keys: unknown[] = [];
    let pause = 0;
    const { fetchImpl } = server();
    globalThis.fetch = (async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/call" && body.params.name === "geo_trends") return new Promise<Response>(() => undefined);
      if (body.method === "tools/call") {
        keys.push(body.params.arguments.idempotencyKey);
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    try {
      const started = Date.now();
      const slow = (await runTool(actor, "eclipse_read", { tool: "geo_trends", argumentsJson: "{}" }, { deadline: Date.now() })) as { error: string };
      assert.match(slow.error, /took too long and was stopped after 5 seconds/);
      assert.ok(Date.now() - started < 8_000);

      pause = 6_000;
      const action = (await runTool(actor, "eclipse_action", { tool: "start_deep_research", summary: "Research", argumentsJson: '{"question": "Who leads?"}' }, { deadline: Date.now(), callId: "call_1" })) as { error?: string; result?: string };
      assert.equal(action.error, undefined);
      assert.match(String(action.result), /start_deep_research/);
      pause = 0;
      await runTool(actor, "eclipse_action", { tool: "start_deep_research", summary: "Research", argumentsJson: '{"question": "Who leads?"}' }, { callId: "call_1" });
      await runTool(actor, "eclipse_action", { tool: "start_deep_research", summary: "Research", argumentsJson: '{"question": "Who leads?"}' }, { callId: "call_2" });
      assert.equal(keys.length, 3);
      assert.match(String(keys[0]), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(keys[0], keys[1]);
      assert.notEqual(keys[1], keys[2]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("lets only owners and admins run Eclipse actions", async () => {
    const original = globalThis.fetch;
    const { fetchImpl, sent } = server();
    globalThis.fetch = fetchImpl;
    try {
      const member = { ...actor, role: "member" } as UserActor;
      const refused = (await runTool(member, "eclipse_action", { tool: "update_client_details", summary: "Update", argumentsJson: '{"website": "https://x.test"}' })) as { error: string };
      assert.match(refused.error, /Only workspace owners and admins can run Eclipse actions/);
      assert.ok(!sent.some((call) => call.method === "tools/call"));
      const admin = { ...actor, role: "admin" } as UserActor;
      const allowed = (await runTool(admin, "eclipse_action", { tool: "update_client_details", summary: "Update", argumentsJson: '{"website": "https://x.test"}' })) as { error?: string };
      assert.equal(allowed.error, undefined);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("gives the assistant the guide, discovery, reads and approved actions", () => {
    const tools = Object.fromEntries(toolDefinitions().map((tool) => [tool.function.name, tool]));
    for (const name of ["eclipse_guide", "eclipse_tools", "eclipse_read", "eclipse_action"]) assert.ok(tools[name], name);
    const card = describeAction("eclipse_action", { tool: "start_deep_research", summary: "Starts deep research on AI search leaders, costing about £0.28.", argumentsJson: '{"question": "Who leads?", "confirm": true}' });
    assert.equal(card.title, "Eclipse: start_deep_research");
    assert.deepEqual(card.lines, ["Starts deep research on AI search leaders, costing about £0.28.", "question: Who leads?", "Runs through Orbit's shared Eclipse connection. Anything it costs comes from Eclipse's own account."]);
  });
});
