import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { z } from "zod";
import { shapeFor } from "@/companion/src/schema";
import { sendMessage } from "@/lib/assistant/chat";
import { ECLIPSE_UNAVAILABLE, eclipseScopeFor } from "@/lib/assistant/eclipse-scope";
import { systemPrompt, UNBRANDED } from "@/lib/assistant/prompt";
import { describeAction, runTool, toolDefinitions } from "@/lib/assistant/tools";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { callEclipseTool, clearEclipseToolCache, eclipseGuide, findEclipseTools, OUT_OF_SCOPE, readClients, sameName } from "@/lib/eclipse-mcp";
import { createUser, resetDatabase } from "./helpers";

let actor: UserActor;
let ridgeon: UserActor;
let globex: UserActor;
let initech: UserActor;
let squatter: UserActor;

const CLIENTS = [
  { id: 1, name: "Eclipse", website: "geteclipse.co" },
  { id: 2, name: "mark ridgeon ", website: "markridgeon.com" },
  { id: 3, name: "Acme Agency Client", website: "acme.test" },
  { id: 4, name: "Globex", website: "globex.test" },
  { id: 5, name: "Old Brand", website: "old.test" },
  { id: 6, name: "Twin", website: "twin-a.test" },
  { id: 7, name: "twin", website: "twin-b.test" },
];
let clients: { id: number; name: string; website: string }[] = CLIENTS;

const TOOLS = [
  { name: "list_clients", description: "List the clients. This read is free and changes nothing.", inputSchema: { type: "object", properties: {} } },
  { name: "geo_trends", description: "AI visibility trends for a GEO profile over time.", inputSchema: { type: "object", properties: { clientId: { type: "number" }, profileId: { type: "number" } } } },
  { name: "update_client_details", description: "Update the client's details.", inputSchema: { type: "object", properties: { clientId: { type: "number" }, website: { type: "string" } } } },
  { name: "start_deep_research", description: "Start deep research. This is a paid tool.", inputSchema: { type: "object", properties: { client_id: { type: "number" }, question: { type: "string" }, confirm: { type: "boolean" }, idempotencyKey: { type: "string" } } } },
  { name: "get_operation", description: "Check a long-running operation. This read is free and changes nothing.", inputSchema: { type: "object", properties: { operationId: { type: "string" } } } },
  { name: "list_transactions", description: "List the account's transactions. This read is free and changes nothing.", inputSchema: { type: "object", properties: {} } },
  { name: "get_operations", description: "List recent operations. This read is free and changes nothing.", inputSchema: { type: "object", properties: {} } },
];

const TRANSACTIONS = { transactions: [{ id: "t1", clientId: 1, amount: 5 }, { id: "t2", clientId: 2, amount: 9 }, { id: "t3", amount: 1 }, { id: "t4", clientName: "Globex" }] };

type Sent = { method: string; params: { name?: string; arguments?: Record<string, unknown> }; auth: string | null };

function server(options: { sse?: boolean; big?: boolean } = {}) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ method: body.method, params: body.params, auth: new Headers(init?.headers).get("authorization") });
    let result: unknown;
    if (body.method === "initialize") result = { instructions: "You are connected to Eclipse. Start with list_clients." };
    else if (body.method === "tools/list") result = { tools: TOOLS };
    else if (body.params.name === "list_clients" && !options.big) result = { content: [{ type: "text", text: JSON.stringify({ clients, total: clients.length }) }] };
    else if (body.params.name === "list_transactions" && !options.big) result = { content: [{ type: "text", text: JSON.stringify(TRANSACTIONS) }] };
    else result = { content: [{ type: "text", text: options.big ? "x".repeat(250_000) : JSON.stringify({ called: body.params.name, args: body.params.arguments }) }] };
    const json = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    return options.sse
      ? new Response(`event: message\ndata: ${json}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : new Response(json, { headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, sent };
}

describe("Eclipse MCP", () => {
  before(async () => {
    await resetDatabase();
    const admin = getAdminPool();
    const mark = await createUser("mark@eclipse.test", "Mark Ridgeon");
    await admin.query("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    await admin.query(
      "insert into crm.workspace_brands (workspace_id, eclipse_tools, eclipse_backfill) values ($1, true, true) on conflict (workspace_id) do update set eclipse_tools = true, eclipse_backfill = true",
      [mark.workspaceId],
    );
    actor = { ...mark, workspaceName: "Eclipse" };
    process.env.ECLIPSE_MCP_TOKEN = "ecl_pat_test";
    clearEclipseToolCache();
    const created = await createWorkspace(actor, { name: "Mark Ridgeon" }, { fetchImpl: server().fetchImpl });
    ridgeon = { ...actor, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    const sam = await createUser("sam@globex.test", "Sam Lee");
    await admin.query("update crm.workspaces set name = 'Globex' where id = $1", [sam.workspaceId]);
    globex = { ...sam, workspaceName: "Globex" };
    const pat = await createUser("pat@initech.test", "Pat Kim");
    await admin.query("update crm.workspaces set name = 'Initech' where id = $1", [pat.workspaceId]);
    initech = { ...pat, workspaceName: "Initech" };
    const squat = await createWorkspace(sam, { name: "Acme Agency Client" }, { fetchImpl: server().fetchImpl });
    squatter = { ...sam, workspaceId: squat.id, workspaceName: "Acme Agency Client", role: "owner", scopes: scopesForRole("owner") };
    delete process.env.ECLIPSE_MCP_TOKEN;
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  beforeEach(() => {
    process.env.ECLIPSE_MCP_TOKEN = "ecl_pat_test";
    clients = CLIENTS;
    clearEclipseToolCache();
  });

  afterEach(() => {
    delete process.env.ECLIPSE_MCP_TOKEN;
  });

  it("reads the guide and finds tools by what they do, marking reads and approvals", async () => {
    const { fetchImpl, sent } = server();
    assert.match(await eclipseGuide({ fetchImpl }), /Start with list_clients/);
    const found = await findEclipseTools("geo trends", { fetchImpl });
    assert.equal(found.total, 7);
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
    assert.match(read.result, /"name":"Acme Agency Client"/);
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
      assert.deepEqual(sent.at(-1)!.params.arguments, { profileId: 7, clientId: 1 });
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
      if (body.method === "tools/call" && body.params.name !== "list_clients") {
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
      assert.deepEqual(sent.at(-1)!.params.arguments, { website: "https://x.test", clientId: 1 });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("gives every workspace the same Eclipse tools and names its own client in the prompt", () => {
    for (const multiWorkspace of [false, true]) {
      const names = toolDefinitions({ multiWorkspace }).map((tool) => tool.function.name);
      for (const name of ["eclipse_guide", "eclipse_tools", "eclipse_read", "eclipse_action", "eclipse_docs"]) assert.ok(names.includes(name), name);
      assert.ok(!names.includes("eclipse_articles"));
    }
    const eclipse = systemPrompt({ ...actor, workspaceName: "Eclipse" }, { webSearch: false, brand: { ...UNBRANDED, workspaceName: "Eclipse" } });
    const ridgeon = systemPrompt({ ...actor, workspaceName: "Mark Ridgeon" }, { webSearch: false, brand: { ...UNBRANDED, workspaceName: "Mark Ridgeon" } });
    assert.match(eclipse, /In Eclipse, use the Eclipse client named 'Eclipse'\. Find it with list_clients and pass its clientId on every call\. Use another client only when the user names it\./);
    assert.match(ridgeon, /In Mark Ridgeon, use the Eclipse client named 'Mark Ridgeon'\. Find it with list_clients and pass its clientId on every call\. Use another client only when the user names it\./);
    assert.doesNotMatch(ridgeon, /client named 'Eclipse'/);
    for (const prompt of [eclipse, ridgeon]) {
      assert.match(prompt, /If no client of that name exists, say so and ask the user which client to use/);
      assert.match(prompt, /goes through eclipse_action, which the user approves/);
      assert.match(prompt, /never share one client's data with another company/);
    }
  });

  it("gives the assistant the guide, discovery, reads and approved actions", () => {
    const tools = Object.fromEntries(toolDefinitions().map((tool) => [tool.function.name, tool]));
    for (const name of ["eclipse_guide", "eclipse_tools", "eclipse_read", "eclipse_action"]) assert.ok(tools[name], name);
    const card = describeAction("eclipse_action", { tool: "start_deep_research", summary: "Starts deep research on AI search leaders, costing about £0.28.", argumentsJson: '{"question": "Who leads?", "confirm": true}' });
    assert.equal(card.title, "Eclipse: start_deep_research");
    assert.deepEqual(card.lines, ["Starts deep research on AI search leaders, costing about £0.28.", "question: Who leads?", "Runs through Orbit's shared Eclipse connection. Anything it costs comes from Eclipse's own account."]);
  });

  it("links a client only when the Eclipse owner creates the workspace or a workspace that existed before, never by a name chosen later", async () => {
    const { fetchImpl } = server();
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const link = async (workspaceId: string) =>
        (await getAdminPool().query<{ eclipse_client_id: string | null }>("select eclipse_client_id from crm.workspace_brands where workspace_id = $1", [workspaceId])).rows[0]?.eclipse_client_id ?? null;
      assert.equal(await link(ridgeon.workspaceId), "2");
      assert.ok((await eclipseScopeFor(actor))!.clientId === 1);
      assert.equal(await link(actor.workspaceId), "1");
      assert.equal(await eclipseScopeFor(globex), null);
      assert.equal(await link(globex.workspaceId), null);
      assert.equal(await eclipseScopeFor(squatter), null);
      assert.equal(await link(squatter.workspaceId), null);

      const admin = getAdminPool();
      const old = (await admin.query<{ id: string }>("insert into crm.workspaces (name, slug) values ('Old Brand', 'ws-old-brand') returning id")).rows[0].id;
      await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [old, globex.userId]);
      await admin.query("insert into crm.workspace_brands (workspace_id, eclipse_backfill) values ($1, true)", [old]);
      const oldBrand = { ...globex, workspaceId: old, workspaceName: "Old Brand" };
      assert.equal((await eclipseScopeFor(oldBrand))!.clientId, 5);
      assert.deepEqual(
        (await admin.query("select eclipse_client_id, eclipse_backfill from crm.workspace_brands where workspace_id = $1", [old])).rows,
        [{ eclipse_client_id: "5", eclipse_backfill: false }],
      );
      clients = CLIENTS.map((client) => (client.id === 5 ? { ...client, name: "Renamed in Eclipse" } : client));
      clearEclipseToolCache();
      assert.equal((await eclipseScopeFor(oldBrand))!.clientId, 5);

      const twin = (await admin.query<{ id: string }>("insert into crm.workspaces (name, slug) values ('Twin', 'ws-twin') returning id")).rows[0].id;
      await admin.query("insert into crm.workspace_brands (workspace_id, eclipse_backfill) values ($1, true)", [twin]);
      assert.equal(await eclipseScopeFor({ ...globex, workspaceId: twin, workspaceName: "Twin" }), null);


      const client = await getPool().connect();
      try {
        await client.query("begin");
        await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: globex.userId, role: "authenticated" })]);
        await client.query("savepoint attempt");
        await assert.rejects(client.query("update crm.workspace_brands set eclipse_client_id = '1' where workspace_id = $1", [globex.workspaceId]), /permission denied/);
        await client.query("rollback to savepoint attempt");
        await assert.rejects(client.query("select private.link_eclipse_client($1, '3', null)", [globex.workspaceId]), /permission denied/);
      } finally {
        await client.query("rollback");
        client.release();
      }
      assert.deepEqual((await admin.query("select private.link_eclipse_client($1, '3', null) as linked", [globex.workspaceId])).rows, [{ linked: false }]);
      assert.deepEqual((await admin.query("select private.link_eclipse_client($1, '3', $2) as linked", [squatter.workspaceId, squatter.userId])).rows, [{ linked: false }]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps workspace names unique, ignoring case and spaces", async () => {
    await assert.rejects(createWorkspace(actor, { name: " mark  RIDGEON " }), /There is already a workspace called/);
    await assert.rejects(getAdminPool().query("update crm.workspaces set name = 'ECLIPSE' where id = $1", [initech.workspaceId]), /There is already a workspace called/);
  });

  it("hides Eclipse where there's no link or no token", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = server().fetchImpl;
    try {
      assert.equal(await eclipseScopeFor(initech), null);
      for (const name of ["eclipse_guide", "eclipse_tools", "eclipse_read", "eclipse_action"]) {
        assert.deepEqual(await runTool(initech, name, { query: "clients", tool: "list_clients", argumentsJson: "{}", summary: "x" }), { error: ECLIPSE_UNAVAILABLE }, name);
      }
      const hidden = toolDefinitions({ eclipse: false }).map((tool) => tool.function.name);
      for (const name of ["eclipse_guide", "eclipse_tools", "eclipse_read", "eclipse_action"]) assert.ok(!hidden.includes(name), name);
      assert.ok(hidden.includes("eclipse_docs"));
      delete process.env.ECLIPSE_MCP_TOKEN;
      assert.equal(await eclipseScopeFor(actor), null);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("puts the workspace's client on every call in a brand workspace and refuses any other client, however it's written", async () => {
    const original = globalThis.fetch;
    const { fetchImpl, sent } = server();
    globalThis.fetch = fetchImpl;
    try {
      await runTool(ridgeon, "eclipse_read", { tool: "geo_trends", argumentsJson: '{"profileId": 7}' });
      assert.deepEqual(sent.at(-1)!.params.arguments, { profileId: 7, clientId: 2 });
      await runTool(ridgeon, "eclipse_read", { tool: "geo_trends", argumentsJson: '{"profileId": 7, "clientId": "2"}' });
      assert.deepEqual(sent.at(-1)!.params.arguments, { profileId: 7, clientId: "2" });
      const calls = () => sent.filter((call) => call.method === "tools/call" && call.params.name !== "list_clients").length;
      const before = calls();
      for (const argumentsJson of [
        '{"clientId": 1}',
        '{"client_id": 3}',
        '{"clientIds": [2, 3]}',
        '{"profileId": 7, "clientId": 4}',
        '{"clientId": " 2"}',
        '{"clientId": "02"}',
        '{"clientId": [2]}',
        '{"clientId": {"id": 2}}',
        '{"filter": {"clientId": 3}}',
        '{"items": [{"targetClientId": 1}]}',
        '{"sourceClientId": 1}',
        '{"client": "Eclipse"}',
        '{"brandId": 1}',
        '{"clientId": true}',
      ]) {
        assert.deepEqual(await runTool(ridgeon, "eclipse_read", { tool: "geo_trends", argumentsJson }), { error: OUT_OF_SCOPE }, argumentsJson);
      }
      assert.match(((await runTool(ridgeon, "eclipse_read", { tool: "list_transactions", argumentsJson: "{}" })) as { error: string }).error, /isn't tied to one client/);
      assert.match(((await runTool(ridgeon, "eclipse_read", { tool: "get_operations", argumentsJson: "{}" })) as { error: string }).error, /isn't tied to one client/);
      assert.equal(calls(), before);
      await runTool(ridgeon, "eclipse_read", { tool: "geo_trends", argumentsJson: '{"filter": {"clientId": 2}}' });
      assert.deepEqual(sent.at(-1)!.params.arguments, { filter: { clientId: 2 }, clientId: 2 });
      await runTool(ridgeon, "eclipse_read", { tool: "start_deep_research", argumentsJson: '{"question": "Who leads?"}' });
      assert.deepEqual(sent.at(-1)!.params.arguments, { question: "Who leads?", client_id: 2 });
      const operation = (await runTool(ridgeon, "eclipse_read", { tool: "get_operation", argumentsJson: '{"operationId": "op_1"}' })) as { error?: string };
      assert.equal(operation.error, undefined);
      const listed = (await runTool(ridgeon, "eclipse_read", { tool: "list_clients", argumentsJson: "{}" })) as { result: string };
      assert.deepEqual(JSON.parse(listed.result).clients.map((client: { id: number }) => client.id), [2]);
      const action = (await runTool(ridgeon, "eclipse_action", { tool: "update_client_details", summary: "Update", argumentsJson: '{"clientId": 1, "website": "https://x.test"}' })) as { error: string };
      assert.equal(action.error, OUT_OF_SCOPE);
      assert.ok(!sent.some((call) => call.params.name === "update_client_details"));
      const member = { ...ridgeon, role: "member" as const };
      assert.match(((await runTool(member, "eclipse_action", { tool: "update_client_details", summary: "Update", argumentsJson: "{}" })) as { error: string }).error, /Only workspace owners and admins/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("lets the workspace that owns Eclipse use its customers' clients, but never another workspace's client", async () => {
    const original = globalThis.fetch;
    const { fetchImpl, sent } = server();
    globalThis.fetch = fetchImpl;
    try {
      await runTool(actor, "eclipse_read", { tool: "geo_trends", argumentsJson: '{"clientId": 3}' });
      assert.deepEqual(sent.at(-1)!.params.arguments, { clientId: 3 });
      await runTool(actor, "eclipse_read", { tool: "geo_trends", argumentsJson: "{}" });
      assert.deepEqual(sent.at(-1)!.params.arguments, { clientId: 1 });
      for (const argumentsJson of ['{"clientId": 2}', '{"clientId": 5}', '{"clientId": " 2"}', '{"filter": {"clientIds": [3, 2]}}', '{"clientId": 99}']) {
        assert.deepEqual(await runTool(actor, "eclipse_read", { tool: "geo_trends", argumentsJson }), { error: OUT_OF_SCOPE }, argumentsJson);
      }
      const transactions = (await runTool(actor, "eclipse_read", { tool: "list_transactions", argumentsJson: "{}" })) as { result: string };
      assert.deepEqual(JSON.parse(transactions.result).transactions.map((row: { id: string }) => row.id), ["t1", "t3", "t4"]);
      const listed = (await runTool(actor, "eclipse_read", { tool: "list_clients", argumentsJson: "{}" })) as { result: string };
      assert.deepEqual(JSON.parse(listed.result).clients.map((client: { name: string }) => client.name), ["Eclipse", "Acme Agency Client", "Globex", "Twin", "twin"]);
      assert.deepEqual(await runTool(actor, "eclipse_action", { tool: "update_client_details", summary: "Update", argumentsJson: '{"clientId": 2}' }), { error: OUT_OF_SCOPE });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("matches names after NFKC, invisible characters and curly apostrophes, and reads body.clients first", () => {
    assert.ok(sameName("Mark​ Ridgeon’s", " mark ridgeon's "));
    assert.ok(sameName("ＡＣＭＥ", "acme"));
    assert.deepEqual(readClients({ staff: [{ id: 9, name: "Staff" }], clients: [{ id: 1, name: "Eclipse" }] }), [{ id: 1, name: "Eclipse" }]);
    assert.deepEqual(readClients({ data: { rows: [{ id: 1, name: "Eclipse" }] } }), [{ id: 1, name: "Eclipse" }]);
  });

  it("checks the client again when an approved action runs, using a fresh client list", async () => {
    const original = globalThis.fetch;
    const { fetchImpl, sent } = server();
    globalThis.fetch = fetchImpl;
    try {
      const args = { tool: "update_client_details", summary: "Update", argumentsJson: '{"website": "https://x.test"}' };
      assert.equal(((await runTool(ridgeon, "eclipse_action", args, { callId: "call_a" })) as { error?: string }).error, undefined);
      clients = CLIENTS.filter((client) => client.id !== 2);
      clearEclipseToolCache();
      const sentBefore = sent.filter((call) => call.params.name === "update_client_details").length;
      assert.deepEqual(await runTool(ridgeon, "eclipse_action", args, { callId: "call_b" }), { error: ECLIPSE_UNAVAILABLE });
      assert.equal(sent.filter((call) => call.params.name === "update_client_details").length, sentBefore);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses rather than guessing when the client list can't be read", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = server({ big: true }).fetchImpl;
    try {
      assert.deepEqual(await runTool(ridgeon, "eclipse_read", { tool: "geo_trends", argumentsJson: "{}" }), { error: "Couldn't read Eclipse's client list." });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("offers the Eclipse tools and prompt section to the model only where the workspace has a client", async () => {
    process.env.LLM_API_KEY = "llm-test";
    const eclipse = server().fetchImpl;
    const seen: { tools: string[]; system: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes("geteclipse")) return eclipse(input, init);
      const body = JSON.parse(String(init?.body));
      seen.push({ tools: (body.tools ?? []).map((tool: { function?: { name: string }; name?: string }) => tool.function?.name ?? tool.name), system: body.messages[0].content });
      return Response.json({ model: "claude-sonnet-5-5", choices: [{ message: { role: "assistant", content: "Hi." } }], usage: {} });
    };
    try {
      for (const who of [ridgeon, initech]) {
        await sendMessage(who, { message: "Hi", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, () => undefined, { deadline: Date.now() + 60_000, fetchImpl });
      }
      assert.ok(seen[0].tools.includes("eclipse_read") && seen[0].tools.includes("eclipse_action"));
      assert.match(seen[0].system, /# Eclipse\n/);
      assert.ok(!seen[1].tools.includes("eclipse_read") && !seen[1].tools.includes("eclipse_guide"));
      assert.ok(seen[1].tools.includes("eclipse_docs"));
      assert.doesNotMatch(seen[1].system, /# Eclipse\n|# Linear\n/);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });
});
