import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { aiAccess, listAiAccounts, pollChatGptLogin, startChatGptLogin } from "@/lib/ai-accounts/store";
import { settingsFor, availableModels } from "@/lib/assistant/models";
import { complete } from "@/lib/assistant/gateway";
import { chatGptRequest, completeChatGpt } from "@/lib/assistant/providers/chatgpt";
import { toolDefinitions } from "@/lib/assistant/tools";
import type { FunctionTool } from "@/lib/assistant/providers/shared";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

type Call = { url: string; init: RequestInit; body: unknown };

function recorder(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const raw = init.body;
    let body: unknown = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    const call = { url, init, body };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function jwt(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function sse(events: { event?: string; data: unknown }[]) {
  const text = events.map((entry) => `${entry.event ? `event: ${entry.event}\n` : ""}data: ${JSON.stringify(entry.data)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const TOOLS = toolDefinitions() as FunctionTool[];

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("AI account sign-in", () => {
  let owner: UserActor;

  before(async () => {
    owner = await createUser("ai-accounts@orbit.test", "Mark Ridgeon");
  });

  it("connects ChatGPT with a device code and keeps the tokens encrypted", async () => {
    let polls = 0;
    const openai = recorder(({ url }) => {
      if (url.endsWith("/deviceauth/usercode")) return json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" });
      if (url.endsWith("/deviceauth/token")) {
        polls += 1;
        return polls === 1 ? json({}, 403) : json({ authorization_code: "auth_1", code_verifier: "ver_1" });
      }
      if (url.endsWith("/oauth/token")) {
        return json({
          access_token: "chatgpt-access",
          refresh_token: "chatgpt-refresh",
          expires_in: 3600,
          id_token: jwt({ email: "mark@geteclipse.co", "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } }),
        });
      }
      return json({}, 500);
    });
    const started = await startChatGptLogin(owner, openai.fetchImpl);
    assert.equal(started.userCode, "ABCD-1234");
    assert.equal(started.url, "https://auth.openai.com/codex/device");
    assert.equal((openai.calls[0].body as { originator: string }).originator, "orbit");

    assert.deepEqual(await pollChatGptLogin(owner, openai.fetchImpl), { status: "pending" });
    const done = await pollChatGptLogin(owner, openai.fetchImpl);
    assert.deepEqual(done, { status: "connected", label: "mark@geteclipse.co" });
    const exchange = openai.calls.at(-1)!.body as Record<string, string>;
    assert.equal(exchange.grant_type, "authorization_code");
    assert.equal(exchange.code_verifier, "ver_1");
    assert.equal(exchange.redirect_uri, "https://auth.openai.com/deviceauth/callback");

    const accounts = await listAiAccounts(owner);
    const chatgpt = accounts.find((account) => account.provider === "chatgpt")!;
    assert.equal(chatgpt.connected, true);
    assert.equal(chatgpt.label, "mark@geteclipse.co");
    const stored = await queryAsUser<{ access_token: string; account_id: string }>(
      owner.userId,
      "select access_token, account_id from crm.ai_accounts where provider = 'chatgpt'",
    );
    assert.notEqual(stored[0].access_token, "chatgpt-access");
    assert.equal(stored[0].account_id, "acct_123");

    const access = await aiAccess(owner, "chatgpt");
    assert.deepEqual(access, { provider: "chatgpt", token: "chatgpt-access", accountId: "acct_123" });
  });

});

describe("ChatGPT sign-in renewal", () => {
  let owner: UserActor;

  before(async () => {
    owner = await createUser("ai-refresh@orbit.test", "Mark Ridgeon");
    const openai = recorder(({ url }) => {
      if (url.endsWith("/deviceauth/usercode")) return json({ device_auth_id: "dev_2", user_code: "WXYZ-9876", interval: 5 });
      if (url.endsWith("/deviceauth/token")) return json({ authorization_code: "auth_2", code_verifier: "ver_2" });
      return json({
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_in: 1,
        id_token: jwt({ email: "mark@geteclipse.co", chatgpt_account_id: "acct_9" }),
      });
    });
    await startChatGptLogin(owner, openai.fetchImpl);
    await pollChatGptLogin(owner, openai.fetchImpl);
  });

  it("refreshes an expired sign-in and records a failed refresh", async () => {
    const refreshed = recorder(() => json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
    const access = await aiAccess(owner, "chatgpt", { fetchImpl: refreshed.fetchImpl });
    assert.deepEqual(access, { provider: "chatgpt", token: "new-access", accountId: "acct_9" });
    assert.equal((refreshed.calls[0].body as Record<string, string>).refresh_token, "old-refresh");
    assert.equal((await aiAccess(owner, "chatgpt")).token, "new-access");

    const refused = recorder(() => json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400));
    await assert.rejects(aiAccess(owner, "chatgpt", { force: true, fetchImpl: refused.fetchImpl }), /Refresh token revoked.*Reconnect it in Settings/);
    const chatgpt = (await listAiAccounts(owner)).find((account) => account.provider === "chatgpt")!;
    assert.match(chatgpt.lastError ?? "", /Refresh token revoked/);
  });
});

describe("account models", () => {
  it("only offers models from connected accounts", () => {
    assert.ok(availableModels([]).every((model) => model.source === "orbit"));
    assert.ok(availableModels(["claude"]).some((model) => model.id === "claude/claude-opus-5-5"));
    assert.ok(!availableModels(["claude"]).some((model) => model.source === "chatgpt"));
    assert.deepEqual(settingsFor("chatgpt/gpt-6.1-sol", "max"), { model: "chatgpt/gpt-6.1-sol", reasoning: "xhigh" });
    assert.deepEqual(settingsFor("chatgpt/gpt-6.1-sol", "high", ["claude"]), { model: "claude-sonnet-5-5", reasoning: "high" });
  });
});

describe("ChatGPT adapter", () => {
  it("builds a Responses request and reads streamed tool calls and text", async () => {
    const body = chatGptRequest({
      modelId: "chatgpt/gpt-6.1-sol",
      apiModel: "gpt-6.1-sol",
      reasoning: "high",
      webSearch: true,
      timeoutMs: 10_000,
      tools: TOOLS,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Pipeline?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "get_pipeline", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_a", content: '{"stages":[]}' },
      ],
    });
    assert.equal(body.instructions, "Be brief.");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(
      body.input.map((item) => item.type ?? item.role),
      ["user", "function_call", "function_call_output"],
    );
    assert.equal((body.tools.at(-1) as { type: string }).type, "web_search");

    const codex = recorder(() =>
      sse([
        { data: { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [] } } },
        {
          data: {
            type: "response.output_item.done",
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Checking.", annotations: [{ type: "url_citation", url: "https://geteclipse.co", title: "Eclipse" }] }],
            },
          },
        },
        { data: { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_b", name: "list_tasks", arguments: '{"view":"all"}' } } },
        { data: { type: "response.completed", response: { usage: { input_tokens: 5 } } } },
      ]),
    );
    const result = await completeChatGpt({
      modelId: "chatgpt/gpt-6.1-sol",
      apiModel: "gpt-6.1-sol",
      reasoning: "medium",
      webSearch: false,
      timeoutMs: 10_000,
      tools: TOOLS,
      messages: [{ role: "system", content: "x" }, { role: "user", content: "Tasks?" }],
      token: "tok",
      accountId: "acct_123",
      fetchImpl: codex.fetchImpl,
    });
    const headers = codex.calls[0].init.headers as Record<string, string>;
    assert.equal(codex.calls[0].url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(headers.authorization, "Bearer tok");
    assert.equal(headers["chatgpt-account-id"], "acct_123");
    assert.equal(headers.originator, "orbit");
    assert.equal(result.content, "Checking.");
    assert.deepEqual(result.toolCalls, [{ id: "call_b", type: "function", function: { name: "list_tasks", arguments: '{"view":"all"}' } }]);
    assert.deepEqual(result.sources, [{ url: "https://geteclipse.co", title: "Eclipse" }]);
    assert.equal(result.state?.content.length, 3);
  });

  it("runs GPT-6.1 Terra through the gateway's Responses endpoint, and without reasoning when that is refused", async () => {
    process.env.LLM_API_KEY = "test-gateway-key";
    try {
      const gateway = recorder(() =>
        sse([
          { data: { type: "response.output_text.delta", delta: "On " } },
          { data: { type: "response.output_text.delta", delta: "it." } },
          { data: { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "On it.", annotations: [] }] } } },
          { data: { type: "response.output_item.done", item: { type: "function_call", call_id: "call_t", name: "list_tasks", arguments: "{}" } } },
          { data: { type: "response.completed", response: { usage: { input_tokens: 3 } } } },
        ]),
      );
      const streamed: string[] = [];
      const result = await complete({
        model: "gpt-6.1-terra",
        reasoning: "high",
        webSearch: false,
        timeoutMs: 10_000,
        tools: TOOLS,
        messages: [{ role: "system", content: "x" }, { role: "user", content: "Tasks?" }],
        fetchImpl: gateway.fetchImpl,
        onText: (text) => streamed.push(text),
      });
      assert.equal(gateway.calls[0].url, "https://api.llmapi.ai/v1/responses");
      assert.equal((gateway.calls[0].init.headers as Record<string, string>).authorization, "Bearer test-gateway-key");
      assert.deepEqual((gateway.calls[0].body as { reasoning: unknown }).reasoning, { effort: "high", summary: "auto" });
      assert.equal(result.content, "On it.");
      assert.deepEqual(streamed, ["On ", "On it."]);
      assert.equal(result.toolCalls[0].function.name, "list_tasks");

      const refused = recorder((call) =>
        call.url.endsWith("/responses")
          ? Response.json({ error: { message: "Not supported" } }, { status: 400 })
          : Response.json({ model: "gpt-6.1-terra", choices: [{ message: { content: "Fallback reply." } }] }),
      );
      const fallback = await complete({
        model: "gpt-6.1-terra",
        reasoning: "high",
        webSearch: false,
        timeoutMs: 10_000,
        tools: TOOLS,
        messages: [{ role: "system", content: "x" }, { role: "user", content: "Tasks?" }],
        fetchImpl: refused.fetchImpl,
      });
      assert.equal(fallback.content, "Fallback reply.");
      assert.equal(refused.calls[1].url, "https://api.llmapi.ai/v1/chat/completions");
      assert.equal((refused.calls[1].body as { reasoning_effort: string }).reasoning_effort, "none");
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("streams ChatGPT plan replies as they are written", async () => {
    const codex = recorder(() =>
      sse([
        { data: { type: "response.output_text.delta", delta: "Hel" } },
        { data: { type: "response.output_text.delta", delta: "lo." } },
        { data: { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello.", annotations: [] }] } } },
        { data: { type: "response.completed", response: {} } },
      ]),
    );
    const streamed: string[] = [];
    const result = await completeChatGpt({
      modelId: "chatgpt/gpt-6.1-sol",
      apiModel: "gpt-6.1-sol",
      reasoning: "low",
      webSearch: false,
      timeoutMs: 10_000,
      tools: [],
      messages: [{ role: "user", content: "Hi" }],
      token: "tok",
      accountId: null,
      fetchImpl: codex.fetchImpl,
      onText: (text) => streamed.push(text),
    });
    assert.deepEqual(streamed, ["Hel", "Hello."]);
    assert.equal(result.content, "Hello.");
  });

  it("explains ChatGPT errors", async () => {
    const limited = recorder(() => json({ detail: "You've hit your usage limit." }, 429));
    await assert.rejects(
      completeChatGpt({
        modelId: "chatgpt/gpt-6-luna",
        apiModel: "gpt-6-luna",
        reasoning: "low",
        webSearch: false,
        timeoutMs: 10_000,
        tools: [],
        messages: [{ role: "user", content: "Hi" }],
        token: "tok",
        accountId: null,
        fetchImpl: limited.fetchImpl,
      }),
      /ChatGPT returned 429: You've hit your usage limit\./,
    );
  });
});
