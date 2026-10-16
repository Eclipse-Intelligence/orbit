import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readPastedCode } from "@/lib/ai-accounts/oauth";
import {
  aiAccess,
  finishClaudeLogin,
  listAiAccounts,
  pollChatGptLogin,
  startChatGptLogin,
  startClaudeLogin,
} from "@/lib/ai-accounts/store";
import { getConversation, sendMessage, type AssistantEvent } from "@/lib/assistant/chat";
import { settingsFor, availableModels } from "@/lib/assistant/models";
import { chatGptRequest, completeChatGpt } from "@/lib/assistant/providers/chatgpt";
import { claudeRequest } from "@/lib/assistant/providers/claude";
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

type Block =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function claudeStream(blocks: Block[], stopReason: string) {
  const events: { event: string; data: unknown }[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
      events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } });
    } else if (block.type === "thinking") {
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } } });
      events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } } });
      events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } } });
    } else {
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } } });
      events.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      });
    }
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });
  events.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } } });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return sse(events);
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

  it("connects Claude with a pasted code and checks it belongs to this sign-in", async () => {
    const { url } = await startClaudeLogin(owner);
    const link = new URL(url);
    assert.equal(link.origin + link.pathname, "https://claude.ai/oauth/authorize");
    assert.equal(link.searchParams.get("code_challenge_method"), "S256");
    assert.equal(link.searchParams.get("scope"), "user:profile user:inference");
    const state = link.searchParams.get("state")!;

    const anthropic = recorder(() =>
      json({ access_token: "claude-access", refresh_token: "claude-refresh", expires_in: 28800, account: { email_address: "mark@geteclipse.co" } }),
    );
    await assert.rejects(finishClaudeLogin(owner, "code_1#someone-else", anthropic.fetchImpl), /different sign-in/);
    const result = await finishClaudeLogin(owner, `code_1#${state}`, anthropic.fetchImpl);
    assert.equal(result.label, "mark@geteclipse.co");
    const exchange = anthropic.calls[0].body as Record<string, string>;
    assert.equal(exchange.code, "code_1");
    assert.equal(exchange.code_verifier, state);
    assert.equal(exchange.grant_type, "authorization_code");
    assert.equal((await aiAccess(owner, "claude")).token, "claude-access");
  });

  it("refreshes an expired sign-in and records a failed refresh", async () => {
    await queryAsUser(owner.userId, "select 1");
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.userId, role: "authenticated" })]);
      await client.query("set local role authenticated");
      await client.query("update crm.ai_accounts set expires_at = now() - interval '1 minute' where provider = 'claude'");
      await client.query("commit");
    } finally {
      client.release();
    }
    const refreshed = recorder(() => json({ access_token: "claude-access-2", refresh_token: "claude-refresh-2", expires_in: 28800 }));
    const access = await aiAccess(owner, "claude", { fetchImpl: refreshed.fetchImpl });
    assert.equal(access.token, "claude-access-2");
    assert.equal((refreshed.calls[0].body as Record<string, string>).refresh_token, "claude-refresh");
    assert.equal((await aiAccess(owner, "claude")).token, "claude-access-2");

    const refused = recorder(() => json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400));
    await assert.rejects(aiAccess(owner, "claude", { force: true, fetchImpl: refused.fetchImpl }), /Refresh token revoked.*Reconnect it in Settings/);
    const claude = (await listAiAccounts(owner)).find((account) => account.provider === "claude")!;
    assert.match(claude.lastError ?? "", /Refresh token revoked/);
  });

  it("reads pasted codes in every shape", () => {
    assert.deepEqual(readPastedCode("abc#xyz"), { code: "abc", state: "xyz" });
    assert.deepEqual(readPastedCode("https://console.anthropic.com/oauth/code/callback?code=abc&state=xyz"), { code: "abc", state: "xyz" });
    assert.deepEqual(readPastedCode("  abc  "), { code: "abc", state: "" });
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

describe("Claude adapter", () => {
  it("builds a Messages request with tools, results, effort and replayed thinking", () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig_1" };
    const request = claudeRequest({
      modelId: "claude/claude-sonnet-5-5",
      apiModel: "claude-sonnet-5-5",
      reasoning: "high",
      webSearch: true,
      timeoutMs: 10_000,
      tools: TOOLS,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Who owns Acme?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "search_records", arguments: '{"query":"Acme"}' } }],
          state: {
            model: "claude/claude-sonnet-5-5",
            content: [thinking, { type: "tool_use", id: "toolu_1", name: "search_records", input: { query: "Acme" } }],
          },
        },
        { role: "tool", tool_call_id: "toolu_1", content: '{"companies":[]}' },
        { role: "assistant", content: "From the gateway", tool_calls: [{ id: "call:9", type: "function", function: { name: "list_tags", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call:9", content: "{}" },
        { role: "user", content: "Thanks" },
      ],
    });
    assert.equal(request.model, "claude-sonnet-5-5");
    assert.deepEqual(request.thinking, { type: "adaptive" });
    assert.deepEqual(request.output_config, { effort: "high" });
    assert.deepEqual(request.betas, ["oauth-2025-04-20", "server-side-fallback-2026-07-01"]);
    assert.equal(request.fallbacks, "default");
    assert.deepEqual(request.system, [{ type: "text", text: "Be brief." }]);
    const tools = request.tools as { name?: string; type?: string; input_schema?: { type: string } }[];
    assert.equal(tools.at(-1)!.type, "web_search_20260209");
    assert.equal(tools.find((tool) => tool.name === "search_records")!.input_schema!.type, "object");
    assert.deepEqual(
      request.messages.map((message) => [message.role, (message.content as { type: string }[]).map((block) => block.type)]),
      [
        ["user", ["text"]],
        ["assistant", ["thinking", "tool_use"]],
        ["user", ["tool_result"]],
        ["assistant", ["text", "tool_use"]],
        ["user", ["tool_result", "text"]],
      ],
    );
    const gatewayCall = (request.messages[3].content as { type: string; id?: string }[])[1];
    const gatewayResult = (request.messages[4].content as { type: string; tool_use_id?: string }[])[0];
    assert.equal(gatewayCall.id, "call_9");
    assert.equal(gatewayResult.tool_use_id, "call_9");
  });

  it("skips fallbacks for Haiku and drops replayed thinking from another model", () => {
    const request = claudeRequest({
      modelId: "claude/claude-haiku-5-5",
      apiModel: "claude-haiku-5-5",
      reasoning: "low",
      webSearch: false,
      timeoutMs: 10_000,
      tools: TOOLS,
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello", state: { model: "claude/claude-opus-5-5", content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: "Hello" }] } },
        { role: "user", content: "Again" },
      ],
    });
    assert.deepEqual(request.betas, ["oauth-2025-04-20"]);
    assert.equal(request.fallbacks, undefined);
    assert.deepEqual((request.messages[1].content as { type: string }[]).map((block) => block.type), ["text"]);
    assert.ok(!(request.tools as { type?: string }[]).some((tool) => tool.type === "web_search_20260209"));
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

describe("assistant on a connected Claude account", () => {
  let owner: UserActor;

  before(async () => {
    owner = await createUser("ai-chat@orbit.test", "Mark Ridgeon");
    const { url } = await startClaudeLogin(owner);
    const state = new URL(url).searchParams.get("state")!;
    const token = recorder(() => json({ access_token: "claude-chat-token", refresh_token: "r", expires_in: 28800 }));
    await finishClaudeLogin(owner, `code#${state}`, token.fetchImpl);
  });

  it("runs the tool loop through the Messages API and replays thinking", async () => {
    const replies = [
      claudeStream(
        [
          { type: "thinking", thinking: "Look up tags.", signature: "sig_a" },
          { type: "tool_use", id: "toolu_a", name: "list_tags", input: {} },
        ],
        "tool_use",
      ),
      claudeStream([{ type: "text", text: "You have no tags yet." }], "end_turn"),
    ];
    const anthropic = recorder(() => replies.shift() ?? claudeStream([{ type: "text", text: "Done." }], "end_turn"));
    const events: AssistantEvent[] = [];
    await sendMessage(
      owner,
      { message: "What tags do I have?", model: "claude/claude-sonnet-5-5", reasoning: "medium", webSearch: false },
      (event) => events.push(event),
      { deadline: Date.now() + 60_000, fetchImpl: anthropic.fetchImpl },
    );
    assert.ok(!events.some((event) => event.type === "error"), JSON.stringify(events.find((event) => event.type === "error")));
    assert.equal(anthropic.calls.length, 2);
    assert.equal(anthropic.calls[0].url, "https://api.anthropic.com/v1/messages?beta=true");
    const headers = new Headers(anthropic.calls[0].init.headers);
    assert.equal(headers.get("authorization"), "Bearer claude-chat-token");
    assert.equal(headers.get("x-api-key"), null);
    assert.match(headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
    const second = anthropic.calls[1].body as { messages: { role: string; content: { type: string; signature?: string }[] }[] };
    assert.deepEqual(
      second.messages.map((message) => [message.role, message.content.map((block) => block.type)]),
      [
        ["user", ["text"]],
        ["assistant", ["thinking", "tool_use"]],
        ["user", ["tool_result"]],
      ],
    );
    assert.equal(second.messages[1].content[0].signature, "sig_a");
    const conversationId = (events[0] as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
    const saved = await getConversation(owner, conversationId);
    assert.equal(saved.conversation.model, "claude/claude-sonnet-5-5");
    assert.equal(saved.messages.at(-1)!.content, "You have no tags yet.");
  });

  it("tells you to connect an account that isn't connected", async () => {
    const events: AssistantEvent[] = [];
    await assert.rejects(
      sendMessage(
        owner,
        { message: "Hi", model: "chatgpt/gpt-6-luna", reasoning: "low", webSearch: false },
        (event) => events.push(event),
        { deadline: Date.now() + 60_000 },
      ),
      /Connect your ChatGPT account in Settings › Integrations first\./,
    );
  });
});
