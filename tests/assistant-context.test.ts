import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  BROKEN_CALL,
  CUT_OFF_CALL,
  CUT_OFF_MESSAGE,
  getConversation,
  sendMessage,
  type AssistantEvent,
} from "@/lib/assistant/chat";
import { CUT_OFF, runTurn, type Sdk } from "@/companion/src/turn";
import { complete } from "@/lib/assistant/gateway";
import { OUTPUT_TOKENS, outputTokens } from "@/lib/assistant/models";
import { PAGE_CONTEXT_TAG, pageContext, readPageInput } from "@/lib/assistant/page-context";
import { createBoard } from "@/lib/crm/boards";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { createOpportunity, listPipeline } from "@/lib/crm/opportunities";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createDoc } from "@/lib/docs/store";
import { createUser, resetDatabase } from "./helpers";

type Sent = { url: string; body: Record<string, unknown> };
type Reply = (body: Record<string, unknown>, url: string) => Response;

function fake(reply: Reply) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ url, body });
    return reply(body, url);
  }) as typeof fetch;
  return { fetchImpl, sent };
}

function chatReply(message: Record<string, unknown>, finish = "stop") {
  return Response.json({ model: "claude-sonnet-5-5", choices: [{ message: { role: "assistant", ...message }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
}

function call(id: string, name: string, args: string) {
  return { id, type: "function", function: { name, arguments: args } };
}

function sse(events: Record<string, unknown>[]) {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

type Block = { type: "thinking"; thinking: string; signature: string } | { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; json: string };

function claudeStream(blocks: Block[], stop: string) {
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: { id: `msg_${Math.random()}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: block.json } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  events.push({ type: "message_stop" });
  return sse(events);
}

function conversationOf(events: AssistantEvent[]) {
  return (events.find((event) => event.type === "conversation") as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
}

async function ask(actor: UserActor, message: string, fetchImpl: typeof fetch, extra: { conversationId?: string; model?: string; reasoning?: string; page?: unknown } = {}) {
  const events: AssistantEvent[] = [];
  await sendMessage(
    actor,
    { conversationId: extra.conversationId, message, model: extra.model ?? "claude-sonnet-5-5", reasoning: extra.reasoning ?? "low", webSearch: false, page: extra.page },
    (event) => events.push(event),
    { deadline: Date.now() + 120_000, fetchImpl },
  );
  return { events, conversationId: conversationOf(events) };
}

function lastUser(body: Record<string, unknown>) {
  const messages = body.messages as { role: string; content: unknown }[];
  return [...messages].reverse().find((message) => message.role === "user")!;
}

function toolResults(body: Record<string, unknown>) {
  return (body.messages as { role: string; content: string }[]).filter((message) => message.role === "tool").map((message) => JSON.parse(message.content) as Record<string, unknown>);
}

let owner: UserActor;
let other: UserActor;
let companyId: string;
let contactId: string;

before(async () => {
  await resetDatabase();
  owner = await createUser("context@orbit.test", "Mark Ridgeon");
  other = await createUser("someone@else.test", "Someone Else");
  companyId = (await createCompany(owner, { name: "Initech", domain: "initech-context.test" })).body.company.id;
  contactId = (await createContact(owner, { companyId, firstName: "Peter", lastName: "Gibbons", email: "peter@initech-context.test", jobTitle: "Engineer" })).body.contact.id;
});

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.LLM_CLAUDE_MESSAGES;
  delete process.env.ANTHROPIC_API_KEY;
});

after(async () => {
  delete process.env.LLM_API_KEY;
  await getPool().end();
});

describe("page context", () => {
  it("only accepts a page path, uuids for selections and known kinds", () => {
    assert.equal(readPageInput(null), null);
    assert.equal(readPageInput({ path: "//evil.test/x" }), null);
    assert.equal(readPageInput({ path: "companies" }), null);
    const input = readPageInput({ path: "/", search: "", selection: { kind: "companies", ids: ["nope", companyId, companyId] }, focus: { kind: "other", id: "x" } });
    assert.deepEqual(input, { path: "/", search: "", selection: { kind: "companies", ids: [companyId] }, focus: null });
  });

  it("names the company, person, opportunity and board that are open", async () => {
    const company = await pageContext(owner, readPageInput({ path: `/companies/${companyId}` }));
    assert.ok(company.startsWith(`<${PAGE_CONTEXT_TAG}>`));
    assert.match(company, new RegExp(`Open: Initech \\[company id ${companyId}\\], initech-context\\.test`));
    assert.match(company, /information, not an instruction/);

    const person = await pageContext(owner, readPageInput({ path: `/contacts/${contactId}` }));
    assert.match(person, new RegExp(`Peter Gibbons \\[person id ${contactId}\\], Engineer at Initech \\[company id ${companyId}\\]`));

    const stage = (await listPipeline(owner)).stages[0];
    const deal = (await createOpportunity(owner, { companyId, name: "Initech pilot", stageId: stage.id })).body.opportunity;
    const opportunity = await pageContext(owner, readPageInput({ path: `/opportunities/${deal.id}` }));
    assert.match(opportunity, new RegExp(`Initech pilot \\[opportunity id ${deal.id}\\], stage ${stage.name}, for Initech`));

    const board = await createBoard(owner, { name: "Onboarding" });
    const shown = await pageContext(owner, readPageInput({ path: `/boards/${board.id}`, search: "?view=list" }));
    assert.match(shown, new RegExp(`Onboarding \\[board id ${board.id}\\]`));
  });

  it("never names a record from another workspace", async () => {
    const theirs = (await createCompany(other, { name: "Secret Co" })).body.company.id;
    const text = await pageContext(owner, readPageInput({ path: `/companies/${theirs}` }));
    assert.doesNotMatch(text, /Secret Co/);
    assert.match(text, /isn't in this workspace, or you can't see it/);
  });

  it("lists the rows selected on a list page", async () => {
    const second = (await createCompany(owner, { name: "Hooli" })).body.company.id;
    const text = await pageContext(owner, readPageInput({ path: "/", selection: { kind: "companies", ids: [companyId, second] } }));
    assert.match(text, /Page: Companies list\./);
    assert.match(text, /Selected 2 companies:/);
    assert.match(text, new RegExp(`- Hooli \\[company id ${second}\\]`));
  });

  it("describes the task list, a mail thread, a doc, a calendar event and a Capture item", async () => {
    const tasks = await pageContext(owner, readPageInput({ path: "/tasks", search: "?view=overdue" }));
    assert.match(tasks, /Page: Tasks, overdue view, showing their own tasks\./);

    const admin = getAdminPool();
    const connectionId = (
      await admin.query<{ id: string }>(
        "insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token) values ($1, $2, 'microsoft', $3, 'connected', 'cipher') returning id",
        [owner.workspaceId, owner.userId, owner.email],
      )
    ).rows[0].id;
    const sourceId = (
      await admin.query<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, $4) returning id", [
        owner.workspaceId,
        owner.userId,
        connectionId,
        owner.email,
      ])
    ).rows[0].id;
    const folderId = (
      await admin.query<{ id: string }>("insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'inbox', 'Inbox', 'inbox') returning id", [
        owner.workspaceId,
        owner.userId,
        sourceId,
      ])
    ).rows[0].id;
    const insertMail = (provider: string, subject: string, at: string) =>
      admin.query<{ id: string }>(
        `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, from_email, from_name, received_at)
         values ($1, $2, $3, $4, $5, 'conv-1', $6, 'peter@initech-context.test', 'Peter Gibbons', $7) returning id`,
        [owner.workspaceId, owner.userId, sourceId, folderId, provider, subject, at],
      );
    await insertMail("m-1", "Pilot terms", "2026-11-02T09:00:00Z");
    const latest = (await insertMail("m-2", "Re: Pilot terms", "2026-11-03T10:30:00Z")).rows[0].id;
    const mail = await pageContext(owner, readPageInput({ path: "/mail", search: `?thread=${encodeURIComponent(`${sourceId}|conv-1`)}` }));
    assert.match(mail, /Page: Mail, inbox\./);
    assert.match(mail, new RegExp(`"Re: Pilot terms" \\[email id ${latest}\\], 2 emails, latest Tue 3 Nov 10:30, from Peter Gibbons`));
    const someoneElse = await pageContext(other, readPageInput({ path: "/mail", search: `?thread=${encodeURIComponent(`${sourceId}|conv-1`)}` }));
    assert.doesNotMatch(someoneElse, /Pilot terms/);

    const doc = await createDoc(owner, { title: "Pilot plan", content: "Plan" });
    const docText = await pageContext(owner, readPageInput({ path: `/docs/${doc.id}` }));
    assert.match(docText, new RegExp(`"Pilot plan" \\[doc id ${doc.id}\\], private\\. Read it with read_knowledge`));
    const hidden = await pageContext(other, readPageInput({ path: `/docs/${doc.id}` }));
    assert.doesNotMatch(hidden, /Pilot plan/);

    const calendarId = (
      await admin.query<{ id: string }>(
        "insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color) values ($1, $2, $3, 'cal', 'Calendar', '#4f9be8') returning id",
        [owner.workspaceId, owner.userId, connectionId],
      )
    ).rows[0].id;
    const eventId = (
      await admin.query<{ id: string }>(
        `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at)
         values ($1, $2, $3, $4, 'evt-1', 'Initech kickoff', '2026-11-12T14:00:00Z', '2026-11-12T14:30:00Z') returning id`,
        [owner.workspaceId, calendarId, connectionId, owner.userId],
      )
    ).rows[0].id;
    const calendar = await pageContext(owner, readPageInput({ path: "/calendar", search: "?view=week&date=2026-11-12", focus: { kind: "calendar_event", id: eventId } }));
    assert.match(calendar, /Page: Calendar, week view around 2026-11-12\./);
    assert.match(calendar, new RegExp(`Event they last opened: "Initech kickoff" \\[calendar event id ${eventId}\\], Thu 12 Nov 14:00`));

    const task = (await createTask(owner, { title: "Send pilot terms", companyId })).body.task.id;
    const capture = await pageContext(owner, readPageInput({ path: "/capture", focus: { kind: "capture", id: `task:${task}` } }));
    assert.match(capture, new RegExp(`Capture item they last selected: task Send pilot terms \\[task id ${task}\\]`));
    const reply = await pageContext(owner, readPageInput({ path: "/capture", focus: { kind: "capture", id: `reply:${sourceId}|conv-1` } }));
    assert.match(reply, /email waiting for a reply "Re: Pilot terms"/);
  });

  it("stores the page with the message, gives it to the model on that turn and keeps it out of the chat", async () => {
    const gateway = fake(() => chatReply({ content: "You're on Initech." }));
    const { conversationId } = await ask(owner, "Summarise where we are with them", gateway.fetchImpl, { page: { path: `/companies/${companyId}`, search: "" } });
    const user = lastUser(gateway.sent[0].body);
    assert.match(String(user.content), /^Summarise where we are with them\n\n<page_context>/);
    assert.match(String(user.content), new RegExp(`Initech \\[company id ${companyId}\\]`));
    const saved = await getConversation(owner, conversationId);
    assert.equal(saved.messages[0].content, "Summarise where we are with them");

    const next = fake(() => chatReply({ content: "Done." }));
    await ask(owner, "And now?", next.fetchImpl, { conversationId, page: { path: "/tasks", search: "" } });
    const messages = next.sent[0].body.messages as { role: string; content: string }[];
    const users = messages.filter((message) => message.role === "user");
    assert.match(users.at(-2)!.content, /company id/);
    assert.match(users.at(-1)!.content, /Page: Tasks/);
  });
});

describe("cut-off replies", () => {
  it("never runs a tool call cut off mid-JSON, continues once, then says it was cut off", async () => {
    const gateway = fake(() => chatReply({ content: "", tool_calls: [call(`call_${Math.random()}`, "search_records", '{"query": "Init')] }, "length"));
    const { conversationId } = await ask(owner, "Find Initech", gateway.fetchImpl);
    assert.equal(gateway.sent.length, 2);
    assert.deepEqual(toolResults(gateway.sent[1].body), [{ error: CUT_OFF_CALL }]);
    const saved = await getConversation(owner, conversationId);
    assert.equal(saved.messages.at(-1)!.content, CUT_OFF_MESSAGE);
  });

  it("keeps the text of a reply cut off for length and says so", async () => {
    const gateway = fake(() => chatReply({ content: "Here is the first half of a long" }, "length"));
    const { conversationId } = await ask(owner, "Write a lot", gateway.fetchImpl);
    assert.equal(gateway.sent.length, 1);
    const saved = await getConversation(owner, conversationId);
    assert.equal(saved.messages.at(-1)!.content, `Here is the first half of a long\n\n${CUT_OFF_MESSAGE}`);
  });

  it("answers a call with broken arguments with an error instead of running it", async () => {
    let index = 0;
    const gateway = fake(() => (index++ === 0 ? chatReply({ content: "", tool_calls: [call("call_bad", "search_records", '{"query": ')] }, "tool_calls") : chatReply({ content: "Sorry, done." })));
    await ask(owner, "Find it", gateway.fetchImpl);
    assert.equal(gateway.sent.length, 2);
    assert.deepEqual(toolResults(gateway.sent[1].body), [{ error: BROKEN_CALL }]);
  });

  it("spots a streamed chat reply and a Responses reply that ran out of tokens", async () => {
    const stream = new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search_records", arguments: '{"query": "In' } }] } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
    const streamed = await complete({ model: "gpt-6.1-sol", reasoning: "low", webSearch: false, timeoutMs: 10_000, messages: [{ role: "user", content: "Hi" }], fetchImpl: (async () => stream) as typeof fetch, onText: () => undefined });
    assert.equal(streamed.cutOff, true);

    const responses = sse([
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "search_records", arguments: '{"query": "In' } },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: {} } },
    ]);
    const gateway = fake(() => responses);
    const result = await complete({ model: "gpt-6.1-terra", reasoning: "xhigh", webSearch: false, timeoutMs: 10_000, messages: [{ role: "user", content: "Hi" }], fetchImpl: gateway.fetchImpl });
    assert.equal(result.cutOff, true);
    assert.equal(gateway.sent[0].body.max_output_tokens, 64_000);
  });

  it("says so when Orbit Agent's last step stopped at max_tokens", async () => {
    const sdk = {
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
      query: () =>
        (async function* () {
          yield { type: "assistant", parent_tool_use_id: null, uuid: "u1", session_id: "s", message: { id: "m1", model: "claude-sonnet-5-5", stop_reason: "max_tokens", content: [{ type: "text", text: "First half" }] } };
          yield { type: "result", subtype: "success", is_error: false, result: "First half", usage: {}, uuid: "r", session_id: "s" };
        })(),
    } as unknown as Sdk;
    const result = await runTurn({ model: "claude-sonnet-5-5", effort: "low", webSearch: false, system: "", prompt: "Hi", tools: [] }, { sdk, cwd: "/tmp", env: {}, callTool: async () => ({ content: "", isError: false }) });
    assert.deepEqual(result.steps, [
      { text: "First half", calls: [] },
      { text: CUT_OFF, calls: [] },
    ]);
    assert.equal(CUT_OFF, CUT_OFF_MESSAGE);
  });

  it("gives high reasoning levels room to think, within each model's limit", async () => {
    assert.equal(outputTokens("claude-sonnet-5-5", "low"), 16_000);
    assert.equal(outputTokens("claude-opus-5-5", "high"), 32_000);
    assert.equal(outputTokens("claude-opus-5-5", "xhigh"), 64_000);
    assert.equal(outputTokens("claude-opus-5-5", "max"), OUTPUT_TOKENS.max);
    assert.equal(outputTokens("gemini-4-argon", "max"), 65_536);
    const gateway = fake(() => chatReply({ content: "Hi." }));
    await complete({ model: "claude-opus-5-5", reasoning: "max", webSearch: false, timeoutMs: 10_000, messages: [{ role: "user", content: "Hi" }], fetchImpl: gateway.fetchImpl });
    assert.equal(gateway.sent[0].body.max_tokens, 96_000);
  });
});

describe("reasoning between tool rounds", () => {
  it("sends Claude's thinking back with its signature during a turn, and drops it from earlier turns", async () => {
    process.env.LLM_CLAUDE_MESSAGES = "on";
    let index = 0;
    const gateway = fake(() => {
      index += 1;
      if (index === 1) {
        return claudeStream(
          [
            { type: "thinking", thinking: "Look the company up.", signature: "sig-round-1" },
            { type: "tool_use", id: "toolu_1", name: "search_records", json: '{"query":"Initech"}' },
          ],
          "tool_use",
        );
      }
      return claudeStream([{ type: "text", text: "Initech is a customer." }], "end_turn");
    });
    const { conversationId } = await ask(owner, "Who is Initech?", gateway.fetchImpl, { reasoning: "xhigh" });
    assert.ok(gateway.sent[0].url.endsWith("/v1/messages"));
    const first = gateway.sent[0].body as { max_tokens: number; thinking: unknown; output_config: unknown; system: string };
    assert.equal(first.max_tokens, 64_000);
    assert.deepEqual(first.thinking, { type: "adaptive" });
    assert.deepEqual(first.output_config, { effort: "xhigh" });
    assert.ok(first.system.length > 100);
    const second = gateway.sent[1].body.messages as { role: string; content: { type: string; signature?: string; tool_use_id?: string; id?: string }[] }[];
    const assistant = second.at(-2)!;
    assert.equal(assistant.role, "assistant");
    assert.deepEqual(assistant.content.map((block) => block.type), ["thinking", "tool_use"]);
    assert.equal(assistant.content[0].signature, "sig-round-1");
    assert.equal(second.at(-1)!.content[0].type, "tool_result");
    assert.equal(second.at(-1)!.content[0].tool_use_id, "toolu_1");

    const later = fake(() => claudeStream([{ type: "text", text: "Yes." }], "end_turn"));
    await ask(owner, "Are they active?", later.fetchImpl, { conversationId });
    const replay = later.sent[0].body.messages as { role: string; content: { type: string }[] }[];
    const blocks = replay.filter((message) => message.role === "assistant").flatMap((message) => message.content.map((block) => block.type));
    assert.ok(blocks.includes("tool_use"));
    assert.ok(!blocks.includes("thinking"));
  });

  it("never runs a Claude tool call cut off by max_tokens", async () => {
    process.env.LLM_CLAUDE_MESSAGES = "on";
    let index = 0;
    const gateway = fake(() =>
      index++ === 0
        ? claudeStream([{ type: "tool_use", id: "toolu_cut", name: "create_task", json: '{"title":"Call Pet' }], "max_tokens")
        : claudeStream([{ type: "text", text: "I'll keep it shorter." }], "end_turn"),
    );
    const { conversationId } = await ask(owner, "Make a task", gateway.fetchImpl);
    const results = (gateway.sent[1].body.messages as { role: string; content: { type: string; content?: string }[] }[]).at(-1)!.content;
    assert.equal(results[0].type, "tool_result");
    assert.deepEqual(JSON.parse(results[0].content!), { error: CUT_OFF_CALL });
    const saved = await getConversation(owner, conversationId);
    assert.ok(saved.messages.every((message) => message.actions.length === 0));
  });

  it("retries without thinking when Claude refuses a replayed block, and falls back to chat completions when Messages isn't available", async () => {
    process.env.LLM_CLAUDE_MESSAGES = "on";
    const messages = [
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: null, tool_calls: [{ id: "toolu_9", type: "function" as const, function: { name: "search_records", arguments: "{}" } }], state: { model: "claude-sonnet-5-5", format: "anthropic" as const, content: [{ type: "thinking", thinking: "x", signature: "old" }, { type: "tool_use", id: "toolu_9", name: "search_records", input: {} }] } },
      { role: "tool" as const, tool_call_id: "toolu_9", content: "{}" },
    ];
    let index = 0;
    const strict = fake(() =>
      index++ === 0
        ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block." } }, { status: 400 })
        : claudeStream([{ type: "text", text: "Hello." }], "end_turn"),
    );
    const retried = await complete({ model: "claude-sonnet-5-5", reasoning: "low", webSearch: false, timeoutMs: 10_000, messages, fetchImpl: strict.fetchImpl });
    assert.equal(retried.content, "Hello.");
    const resent = (strict.sent[1].body.messages as { role: string; content: { type: string }[] }[])[1].content.map((block) => block.type);
    assert.deepEqual(resent, ["tool_use"]);

    const missing = fake((_body, url) => (url.endsWith("/messages") ? new Response("not found", { status: 404 }) : chatReply({ content: "From chat." })));
    const fallback = await complete({ model: "claude-sonnet-5-5", reasoning: "low", webSearch: false, timeoutMs: 10_000, messages, fetchImpl: missing.fetchImpl });
    assert.equal(fallback.content, "From chat.");
    assert.ok(missing.sent[1].url.endsWith("/chat/completions"));
  });

  it("sends Claude straight to Anthropic when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const gateway = fake(() => claudeStream([{ type: "text", text: "Direct." }], "end_turn"));
    const result = await complete({ model: "claude-haiku-5-5", reasoning: "max", webSearch: true, timeoutMs: 10_000, messages: [{ role: "user", content: "Hi" }], fetchImpl: gateway.fetchImpl });
    assert.equal(result.content, "Direct.");
    assert.equal(gateway.sent[0].url, "https://api.anthropic.com/v1/messages");
    const tools = gateway.sent[0].body.tools as { type?: string; name: string }[];
    assert.ok(tools.some((tool) => tool.type === "web_search_20250305"));
  });

  it("passes provider reasoning fields and Gemini thought signatures back on chat completions", async () => {
    const gateway = fake(() =>
      chatReply(
        {
          content: "",
          reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }],
          tool_calls: [{ ...call("call_g", "search_records", '{"query":"Initech"}'), extra_content: { google: { thought_signature: "g-sig" } } }],
        },
        "tool_calls",
      ),
    );
    const first = await complete({ model: "gemini-4-argon", reasoning: "low", webSearch: false, timeoutMs: 10_000, messages: [{ role: "user", content: "Hi" }], fetchImpl: gateway.fetchImpl });
    await complete({
      model: "gemini-4-argon",
      reasoning: "low",
      webSearch: false,
      timeoutMs: 10_000,
      fetchImpl: gateway.fetchImpl,
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: null, tool_calls: first.toolCalls, state: first.state },
        { role: "tool", tool_call_id: "call_g", content: "{}" },
      ],
    });
    const assistant = (gateway.sent[1].body.messages as Record<string, unknown>[])[1] as { reasoning_details: unknown; tool_calls: { extra_content: unknown }[] };
    assert.deepEqual(assistant.reasoning_details, [{ type: "reasoning.encrypted", data: "opaque" }]);
    assert.deepEqual(assistant.tool_calls[0].extra_content, { google: { thought_signature: "g-sig" } });
    await complete({
      model: "gpt-6.1-sol",
      reasoning: "low",
      webSearch: false,
      timeoutMs: 10_000,
      fetchImpl: gateway.fetchImpl,
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: null, tool_calls: first.toolCalls, state: first.state },
        { role: "tool", tool_call_id: "call_g", content: "{}" },
      ],
    });
    const switched = (gateway.sent[2].body.messages as Record<string, unknown>[])[1] as { reasoning_details?: unknown; tool_calls: { extra_content?: unknown }[] };
    assert.equal(switched.reasoning_details, undefined);
    assert.equal(switched.tool_calls[0].extra_content, undefined);
  });
});
