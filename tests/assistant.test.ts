import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { decideAction, getConversation, listConversations, sendMessage, type AssistantEvent } from "@/lib/assistant/chat";
import { settingsFor } from "@/lib/assistant/models";
import { systemPrompt } from "@/lib/assistant/prompt";
import { londonTime, runTool, toolJson } from "@/lib/assistant/tools";
import { parseBlocks } from "@/components/assistant/markdown";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { createOpportunity, listPipeline } from "@/lib/crm/opportunities";
import { createTask, listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

type Reply = { content?: string; tool_calls?: { id: string; name: string; args: Record<string, unknown> }[] };

function gateway(replies: Reply[]) {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const reply = replies.shift() ?? { content: "Done." };
    return new Response(
      JSON.stringify({
        model: "claude-sonnet-5-5",
        choices: [
          {
            message: {
              role: "assistant",
              content: reply.content ?? "",
              tool_calls: reply.tool_calls?.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function collect() {
  const events: AssistantEvent[] = [];
  return { events, emit: (event: AssistantEvent) => events.push(event) };
}

const deadline = () => Date.now() + 120_000;

before(async () => {
  await resetDatabase();
});

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
});

after(async () => {
  delete process.env.LLM_API_KEY;
  await getPool().end();
});

describe("assistant tools", () => {
  let owner: UserActor;
  let companyId: string;
  let contactId: string;

  before(async () => {
    owner = await createUser("assistant@orbit.test", "Mark Ridgeon");
    companyId = (await createCompany(owner, { name: "Initech", domain: "initech-ai.test" })).body.company.id;
    contactId = (await createContact(owner, { companyId, firstName: "Peter", lastName: "Gibbons", email: "peter@initech-ai.test" })).body.contact.id;
    await createTask(owner, { title: "Send TPS report", companyId, contactId, dueAt: "2026-10-20T10:00", remindMinutes: 60 });
    const stage = (await listPipeline(owner)).stages[0];
    await createOpportunity(owner, { companyId, name: "Initech pilot", value: 12000, stageId: stage.id, expectedCloseDate: "2026-10-30" });
  });

  it("returns tasks with links, reminders and ClickUp state", async () => {
    const result = (await runTool(owner, "list_tasks", { view: "all" })) as { data: Record<string, unknown>[] };
    const task = result.data.find((item) => item.title === "Send TPS report")!;
    assert.equal(task.reminder, "1 hour before");
    assert.equal(task.inClickUp, false);
    assert.equal(task.companyHref, `/companies/${companyId}`);
    assert.equal(task.contactHref, `/contacts/${contactId}`);
  });

  it("summarises the pipeline by stage and closing window", async () => {
    const result = (await runTool(owner, "get_pipeline", {})) as { stages: { count: number; totalValue: number }[]; totals: { open: number } };
    assert.equal(result.totals.open, 12000);
    assert.equal(result.stages.reduce((sum, stage) => sum + stage.count, 0), 1);
    const narrow = (await runTool(owner, "get_pipeline", { closingWithinDays: 1 })) as { totals: { count: number } };
    assert.ok(narrow.totals.count <= 1);
  });

  it("searches and reads full records", async () => {
    const found = (await runTool(owner, "search_records", { query: "initech" })) as { companies: { id: string; href: string }[]; contacts: unknown[] };
    assert.equal(found.companies[0].id, companyId);
    assert.equal(found.companies[0].href, `/companies/${companyId}`);
    assert.equal(found.contacts.length, 1);
    const company = (await runTool(owner, "get_company", { companyId })) as { company: { name: string }; contacts: unknown[]; tasks: unknown[]; opportunities: unknown[] };
    assert.equal(company.company.name, "Initech");
    assert.equal(company.contacts.length, 1);
    assert.equal(company.tasks.length, 1);
    assert.equal(company.opportunities.length, 1);
    const person = (await runTool(owner, "get_contact", { contactId })) as { contact: { name: string }; openTasks: unknown[] };
    assert.equal(person.contact.name, "Peter Gibbons");
    assert.equal(person.openTasks.length, 1);
  });

  it("reports bad input as an error the model can read", async () => {
    assert.deepEqual(await runTool(owner, "get_company", { companyId: "nope" }), { error: "Company not found.", field: null });
    assert.deepEqual(await runTool(owner, "no_such_tool", {}), { error: "There is no tool called no_such_tool." });
  });

  it("shows times in London time", () => {
    assert.equal(londonTime("2026-10-20T09:00:00.000Z"), "2026-10-20T10:00+01:00");
    assert.equal(londonTime("2026-12-01T09:00:00.000Z"), "2026-12-01T09:00+00:00");
    assert.equal(toolJson({ at: "2026-10-20T09:00:00.000Z", name: "x" }), '{"at":"2026-10-20T10:00+01:00","name":"x"}');
  });

  it("writes the system prompt with Eclipse context and the house rules", () => {
    const prompt = systemPrompt(owner, { webSearch: false, now: new Date("2026-10-16T08:00:00Z") });
    assert.match(prompt, /Eclipse is a B2B SaaS platform/);
    assert.match(prompt, /UK English/);
    assert.match(prompt, /Friday,? 16 October 2026/);
    assert.match(prompt, /list_tasks/);
    assert.match(prompt, /create_task/);
    assert.match(prompt, /Web search is off/);
    assert.ok(!/[—–]/.test(prompt.replace(/No em dashes or en dashes/, "")));
  });
});

describe("assistant conversations", () => {
  let owner: UserActor;
  let other: UserActor;
  let companyId: string;

  before(async () => {
    owner = await createUser("chat@orbit.test", "Mark Ridgeon");
    other = await createUser("someone@orbit.test", "Someone Else");
    companyId = (await createCompany(owner, { name: "Globex", domain: "globex-ai.test" })).body.company.id;
    await createTask(owner, { title: "Call Hank", companyId, dueAt: "2026-10-01T09:00" });
  });

  it("calls tools, answers and saves the conversation", async () => {
    const fake = gateway([
      { tool_calls: [{ id: "call_1", name: "list_tasks", args: { view: "all" } }] },
      { content: "You have one task: **Call Hank**." },
    ]);
    const { events, emit } = collect();
    await sendMessage(
      owner,
      { message: "What tasks have I got outstanding?", model: "claude-sonnet-5-5", reasoning: "high", webSearch: false },
      emit,
      { deadline: deadline(), fetchImpl: fake.fetchImpl },
    );
    const types = events.map((event) => event.type);
    assert.deepEqual(types, ["conversation", "user", "message", "tool", "tool", "message", "done"]);
    const first = fake.requests[0];
    assert.equal(first.model, "claude-sonnet-5-5");
    assert.equal(first.reasoning_effort, "high");
    assert.ok(!(first.tools as { type: string }[]).some((tool) => tool.type === "web_search"));
    const second = fake.requests[1].messages as { role: string; tool_call_id?: string; content: string }[];
    const toolMessage = second.find((message) => message.role === "tool")!;
    assert.equal(toolMessage.tool_call_id, "call_1");
    assert.match(toolMessage.content, /Call Hank/);

    const conversation = (events[0] as Extract<AssistantEvent, { type: "conversation" }>).conversation;
    assert.equal(conversation.title, "What tasks have I got outstanding?");
    const saved = await getConversation(owner, conversation.id);
    assert.deepEqual(saved.messages.map((message) => message.role), ["user", "assistant", "assistant"]);
    assert.deepEqual(saved.messages[1].tools.map((tool) => tool.name), ["list_tasks"]);
    assert.equal(saved.messages[2].content, "You have one task: **Call Hank**.");
    assert.equal((await listConversations(owner))[0].id, conversation.id);
    await assert.rejects(getConversation(other, conversation.id), /Conversation not found/);
    assert.deepEqual(await listConversations(other), []);
  });

  it("adds web search alongside Orbit's tools when it's on", async () => {
    const fake = gateway([{ content: "Here's what I found." }]);
    const { emit } = collect();
    await sendMessage(owner, { message: "Review the Eclipse website", model: "gemini-4-argon", reasoning: "max", webSearch: true }, emit, {
      deadline: deadline(),
      fetchImpl: fake.fetchImpl,
    });
    const tools = fake.requests[0].tools as { type: string; function?: { name: string } }[];
    assert.ok(tools.some((tool) => tool.type === "web_search"));
    assert.ok(tools.some((tool) => tool.function?.name === "get_pipeline"));
    assert.equal(fake.requests[0].reasoning_effort, "high");
    assert.match(String((fake.requests[0].messages as { content: string }[])[0].content), /Web search is on/);
  });

  it("waits for confirmation before changing anything, then carries on", async () => {
    const fake = gateway([
      {
        content: "I'll add that task.",
        tool_calls: [{ id: "call_w", name: "create_task", args: { title: "Send Globex proposal", companyId, dueAt: "2026-10-22T09:00", sendToClickUp: false } }],
      },
      { content: "Added [Send Globex proposal](/tasks)." },
    ]);
    const first = collect();
    await sendMessage(owner, { message: "Add a task to send Globex the proposal on Wednesday", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, first.emit, {
      deadline: deadline(),
      fetchImpl: fake.fetchImpl,
    });
    const pending = first.events.find((event) => event.type === "actions") as Extract<AssistantEvent, { type: "actions" }>;
    assert.equal(pending.actions[0].status, "pending");
    assert.equal(pending.actions[0].title, "Create task: Send Globex proposal");
    assert.ok(pending.actions[0].lines.includes("ClickUp: no"));
    assert.ok(pending.actions[0].lines.some((line) => /^Due: Thu 22 Oct, 09:00$/.test(line)));
    const before = await listTasks(owner, { query: "Globex proposal" });
    assert.equal(before.data.length, 0);

    const conversationId = (first.events[0] as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
    const second = collect();
    await decideAction(owner, { conversationId, actionId: "call_w", approve: true }, second.emit, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    const statuses = second.events.filter((event) => event.type === "actions").map((event) => (event as Extract<AssistantEvent, { type: "actions" }>).actions[0].status);
    assert.deepEqual(statuses, ["running", "done"]);
    const created = await listTasks(owner, { query: "Globex proposal" });
    assert.equal(created.data.length, 1);
    assert.equal(created.data[0].dueAt, "2026-10-22T08:00:00.000Z");
    assert.ok(second.events.some((event) => event.type === "message"));
    await assert.rejects(
      decideAction(owner, { conversationId, actionId: "call_w", approve: true }, second.emit, { deadline: deadline(), fetchImpl: fake.fetchImpl }),
      /already been handled/,
    );
  });

  it("records a declined action and declines leftovers when you move on", async () => {
    const fake = gateway([
      { tool_calls: [{ id: "call_a", name: "complete_task", args: { taskId: "00000000-0000-0000-0000-000000000000" } }] },
      { content: "Fine, I've left it." },
      { tool_calls: [{ id: "call_b", name: "create_company", args: { name: "Hooli" } }] },
      { content: "Okay." },
    ]);
    const first = collect();
    await sendMessage(owner, { message: "Mark it done", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, first.emit, {
      deadline: deadline(),
      fetchImpl: fake.fetchImpl,
    });
    const conversationId = (first.events[0] as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
    const declined = collect();
    await decideAction(owner, { conversationId, actionId: "call_a", approve: false }, declined.emit, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    const lastRequest = fake.requests[1].messages as { role: string; tool_call_id?: string; content: string }[];
    assert.match(lastRequest.find((message) => message.tool_call_id === "call_a")!.content, /declined/);

    const third = collect();
    await sendMessage(owner, { conversationId, message: "Add Hooli as a company", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, third.emit, {
      deadline: deadline(),
      fetchImpl: fake.fetchImpl,
    });
    const fourth = collect();
    await sendMessage(owner, { conversationId, message: "Actually, never mind", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, fourth.emit, {
      deadline: deadline(),
      fetchImpl: fake.fetchImpl,
    });
    const saved = await getConversation(owner, conversationId);
    const hooli = saved.messages.flatMap((message) => message.actions).find((action) => action.id === "call_b");
    assert.equal(hooli?.status, "declined");
    const finalRequest = fake.requests.at(-1)!.messages as { role: string; tool_call_id?: string; content: string }[];
    assert.match(finalRequest.find((message) => message.tool_call_id === "call_b")!.content, /without confirming/);
  });

  it("falls back to supported models and reasoning levels", () => {
    assert.deepEqual(settingsFor("made-up", "max"), { model: "claude-sonnet-5-5", reasoning: "max" });
    assert.deepEqual(settingsFor("grok-4.7", "max"), { model: "grok-4.7", reasoning: "xhigh" });
    assert.deepEqual(settingsFor("gpt-6-astra", "nonsense"), { model: "gpt-6-astra", reasoning: "medium" });
    assert.deepEqual(settingsFor("gemini-4-argon", "high"), { model: "gemini-4-argon", reasoning: "high" });
  });
});

describe("assistant markdown", () => {
  it("parses headings, lists, tables, code and paragraphs", () => {
    const blocks = parseBlocks(
      "## Pipeline\n\n| Stage | Value |\n| --- | --- |\n| New | £1,000 |\n\n- One\n- Two\n  - Nested\n\n1. First\n2. Second\n\n```\ncode\n```\n\nPlain text\nsecond line",
    );
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ["heading", "table", "list", "list", "code", "paragraph"],
    );
    const table = blocks[1] as { head: string[]; rows: string[][] };
    assert.deepEqual(table.head, ["Stage", "Value"]);
    assert.deepEqual(table.rows, [["New", "£1,000"]]);
    const list = blocks[2] as { items: { text: string; depth: number }[] };
    assert.deepEqual(list.items.map((item) => item.depth), [0, 0, 1]);
  });
});
