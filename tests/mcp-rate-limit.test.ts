import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { MCP_BATCH_LIMIT, mcpCost } from "@/lib/api/mcp-request";
import { createPersonalToken } from "@/lib/auth/personal";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createAgent, createUser, resetDatabase } from "./helpers";

type RpcReply = { id: unknown; result?: unknown; error?: { code: number; message: string; data?: Record<string, unknown> } };

function call(id: number) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "search_companies", arguments: { query: "acme" } } };
}

async function post(token: string, body: unknown) {
  const response = await mcpRoute(
    new Request("http://crm.test/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: (await response.json()) as RpcReply | RpcReply[] };
}

async function used(key: string) {
  const result = await getAdminPool().query<{ request_count: number }>("select request_count from private.rate_limit_buckets where bucket_key = $1", [key]);
  return result.rows[0]?.request_count ?? 0;
}

async function setUsed(key: string, count: number) {
  await getAdminPool().query("update private.rate_limit_buckets set request_count = $2 where bucket_key = $1", [key, count]);
}

describe("MCP rate limit", () => {
  let owner: UserActor;
  let agentToken: string;
  let agentKey: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mcp-limit@orbit.test", "Mark Ridgeon");
    const agent = await createAgent(owner.workspaceId, ["crm:read"]);
    agentToken = agent.token;
    agentKey = `agent:${agent.actor.credentialId}`;
  });

  after(async () => {
    await getPool().end();
  });

  it("counts every tool call in a batch, and a request without calls as one", () => {
    assert.equal(mcpCost(call(1)), 1);
    assert.equal(mcpCost([call(1), call(2), call(3)]), 3);
    assert.equal(mcpCost([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]), 1);
    assert.equal(mcpCost([call(1), { jsonrpc: "2.0", id: 2, method: "tools/list" }]), 1);
  });

  it("charges a batch once per tool call", async () => {
    const single = await post(agentToken, call(1));
    assert.equal(single.status, 200);
    assert.equal(await used(agentKey), 1);
    const batch = await post(agentToken, [call(2), call(3), call(4), call(5)]);
    assert.equal(batch.status, 200);
    assert.equal((batch.body as RpcReply[]).length, 4);
    assert.equal(await used(agentKey), 5);
  });

  it("refuses a batch over the limit with a JSON-RPC error", async () => {
    const calls = Array.from({ length: MCP_BATCH_LIMIT + 1 }, (_, index) => call(index + 1));
    const refused = await post(agentToken, calls);
    assert.equal(refused.status, 400);
    const reply = refused.body as RpcReply;
    assert.equal(reply.error?.code, -32600);
    assert.match(reply.error?.message ?? "", new RegExp(`at most ${MCP_BATCH_LIMIT} messages`));
  });

  it("refuses with a JSON-RPC rate limit error once the calls would pass 120 a minute", async () => {
    await setUsed(agentKey, 117);
    const batch = await post(agentToken, [call(1), call(2), call(3), call(4)]);
    assert.equal(batch.status, 429);
    assert.equal(batch.retryAfter, "60");
    const reply = batch.body as RpcReply;
    assert.equal(reply.id, null);
    assert.equal(reply.error?.code, -32029);
    assert.match(reply.error?.message ?? "", /120 tool calls a minute/);
    assert.match(reply.error?.message ?? "", /needed 4/);
    assert.deepEqual(reply.error?.data, { code: "rate_limited", retryAfterSeconds: 60, cost: 4 });

    const single = await post(agentToken, call(9));
    assert.equal(single.status, 429);
    assert.equal((single.body as RpcReply).id, 9);
  });

  it("counts batches on personal tokens too", async () => {
    const personal = await createPersonalToken(owner, "Claude");
    const key = `personal:${personal.details.id}`;
    const batch = await post(personal.token, [call(1), call(2), call(3)]);
    assert.equal(batch.status, 200);
    assert.equal(await used(key), 3);
    await setUsed(key, 119);
    const refused = await post(personal.token, [call(4), call(5)]);
    assert.equal(refused.status, 429);
    assert.equal((refused.body as RpcReply).error?.code, -32029);
  });
});
