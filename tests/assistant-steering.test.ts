import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  applyCompanionResult,
  companionSteers,
  decideActions,
  getConversation,
  history,
  resumeConversation,
  sendMessage,
  stopConversation,
  type AssistantEvent,
} from "@/lib/assistant/chat";
import { finishCompanionJob, nextCompanionJob, readCompanionResult } from "@/lib/companion/jobs";
import { authenticateCompanion, createPairingCode, redeemPairing, type AuthenticatedCompanion } from "@/lib/companion/pairing";
import { buildPrompt } from "@/lib/companion/transcript";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { CompanionJob, CompanionResult } from "@/companion/src/protocol";
import { PROPOSED, runTurn, type Sdk } from "@/companion/src/turn";
import { createUser, messageText, resetDatabase } from "./helpers";

type Call = { id: string; name: string; args: Record<string, unknown> };
type Reply = { content?: string; calls?: Call[] };
type Body = { messages: { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }[] };

function model(replies: Reply[], during: (index: number) => Promise<void> = async () => undefined, name = "claude-sonnet-5-5") {
  const bodies: Body[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    await during(bodies.length);
    const reply = replies.shift() ?? { content: "Done." };
    return Response.json({
      model: name,
      choices: [
        {
          message: {
            role: "assistant",
            content: reply.content ?? "",
            tool_calls: reply.calls?.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })),
          },
        },
      ],
    });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

const deadline = () => Date.now() + 120_000;

function conversationOf(events: AssistantEvent[]) {
  return (events.find((event) => event.type === "conversation") as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
}

function texts(body: Body) {
  return body.messages.map((message) => [message.role, messageText(message.content)] as const);
}

async function rowsOf(conversationId: string) {
  const result = await getAdminPool().query<{ id: string; role: string; content: string; steering: string | null; turn_context: string | null; tool_call_id: string | null }>(
    "select id, role, content, steering, turn_context, tool_call_id from crm.assistant_messages where conversation_id = $1 order by seq",
    [conversationId],
  );
  return result.rows;
}

async function steer(actor: UserActor, conversationId: string, message: string, fetchImpl: typeof fetch, events: AssistantEvent[] = []) {
  await sendMessage(actor, { conversationId, message, model: "claude-sonnet-5-5", reasoning: "low", webSearch: false, steer: true }, (event) => events.push(event), {
    deadline: deadline(),
    fetchImpl,
  });
  return events;
}

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

describe("steering Orbit models", () => {
  let owner: UserActor;

  before(async () => {
    owner = await createUser("steering@orbit.test", "Mark Ridgeon");
  });

  it("picks up messages sent mid-turn before the next round, in order, after the tool results", async () => {
    let conversationId = "";
    const late: AssistantEvent[] = [];
    const fake = model(
      [{ content: "Looking.", calls: [{ id: "call_search", name: "search_records", args: { query: "Acme" } }] }, { content: "Only the London ones, then." }],
      async (index) => {
        if (index !== 1) return;
        await steer(owner, conversationId, "By the way, only the London ones", fake.fetchImpl, late);
        await steer(owner, conversationId, "And skip the archived ones", fake.fetchImpl, late);
      },
    );
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: "Find the Acme offices", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => {
      events.push(event);
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: deadline(), fetchImpl: fake.fetchImpl });

    assert.equal(fake.bodies.length, 2);
    const second = fake.bodies[1].messages;
    assert.deepEqual(
      second.slice(1).map((message) => message.role),
      ["user", "assistant", "tool", "user", "user"],
    );
    assert.equal(messageText(second[4].content), "By the way, only the London ones");
    assert.equal(messageText(second[5].content), "And skip the archived ones");
    assert.match(messageText(second[1].content), /^Find the Acme offices\n\n<orbit_context>/);
    assert.ok(!messageText(second[4].content).includes("<orbit_context>"));

    const userEvents = late.filter((event) => event.type === "user") as Extract<AssistantEvent, { type: "user" }>[];
    assert.equal(userEvents.length, 2);
    assert.ok(userEvents.every((event) => event.message.waiting === true));
    const steered = events.filter((event) => event.type === "steered") as Extract<AssistantEvent, { type: "steered" }>[];
    assert.deepEqual(steered.flatMap((event) => event.ids), userEvents.map((event) => event.message.id));

    const rows = await rowsOf(conversationId);
    assert.deepEqual(
      rows.map((row) => [row.role, row.steering]),
      [
        ["user", null],
        ["assistant", null],
        ["tool", null],
        ["user", "folded"],
        ["user", "folded"],
        ["assistant", null],
      ],
    );
    assert.ok(rows[0].turn_context);
    assert.equal(rows[3].turn_context, null);
    const shown = await getConversation(owner, conversationId);
    assert.deepEqual(
      shown.messages.map((message) => [message.role, message.content, Boolean(message.waiting)]),
      [
        ["user", "Find the Acme offices", false],
        ["assistant", "Looking.", false],
        ["user", "By the way, only the London ones", false],
        ["user", "And skip the archived ones", false],
        ["assistant", "Only the London ones, then.", false],
      ],
    );
    assert.equal(shown.working, null);
  });

  it("keeps every earlier message byte for byte when a steer is folded in, so the cached prefix holds", async () => {
    let conversationId = "";
    const fake = model(
      [
        { content: "", calls: [{ id: "call_one", name: "search_records", args: { query: "Acme" } }] },
        { content: "", calls: [{ id: "call_two", name: "search_records", args: { query: "Globex" } }] },
        { content: "Both found." },
      ],
      async (index) => {
        if (index === 2) await steer(owner, conversationId, "Actually, Globex too", fake.fetchImpl);
      },
      "gpt-6.1-sol",
    );
    await sendMessage(owner, { message: "Find Acme", model: "gpt-6.1-sol", reasoning: "low", webSearch: false }, (event) => {
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(fake.bodies.length, 3);
    const [one, two, three] = fake.bodies.map((body) => body.messages);
    assert.deepEqual(two.slice(0, one.length), one);
    assert.deepEqual(three.slice(0, two.length), two);
    assert.equal(messageText(three[two.length + 2].content), "Actually, Globex too");

    const rows = (await getAdminPool().query("select * from crm.assistant_messages where conversation_id = $1 order by seq", [conversationId])).rows;
    const anchor = rows[0];
    const rebuilt = history(rows, 900_000, anchor.turn_context);
    assert.deepEqual(rebuilt.slice(0, three.length - 1).map((message) => messageText(message.content)), three.slice(1).map((message) => messageText(message.content)));
  });

  it("starts a follow-on turn when a message arrives after the last round", async () => {
    let conversationId = "";
    const fake = model([{ content: "Here are all of them." }, { content: "Just the London ones: two." }], async (index) => {
      if (index === 1) await steer(owner, conversationId, "Actually, only the London ones", fake.fetchImpl);
    });
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: "List the offices", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => {
      events.push(event);
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: deadline(), fetchImpl: fake.fetchImpl });

    assert.equal(fake.bodies.length, 2);
    const latest = fake.bodies[1].messages.at(-1)!;
    assert.equal(latest.role, "user");
    assert.match(messageText(latest.content), /^Actually, only the London ones\n\n<orbit_context>/);
    assert.match(messageText(fake.bodies[1].messages[1].content), /^List the offices$/);
    const rows = await rowsOf(conversationId);
    assert.deepEqual(
      rows.map((row) => [row.role, row.content, row.steering]),
      [
        ["user", "List the offices", null],
        ["assistant", "Here are all of them.", null],
        ["user", "Actually, only the London ones", null],
        ["assistant", "Just the London ones: two.", null],
      ],
    );
    assert.ok(rows[2].turn_context);
    assert.ok(events.some((event) => event.type === "steered"));
    assert.equal(events.filter((event) => event.type === "done").length, 1);
  });

  it("holds a message sent while a card waits, and answers it once the card is decided", async () => {
    let conversationId = "";
    const fake = model(
      [{ content: "I'll add the task.", calls: [{ id: "call_task", name: "create_task", args: { title: "Call Acme" } }] }, { content: "Added, and noted the Friday deadline." }],
      async (index) => {
        if (index === 1) await steer(owner, conversationId, "Make it due Friday", fake.fetchImpl);
      },
    );
    const first: AssistantEvent[] = [];
    await sendMessage(owner, { message: "Add a task to call Acme", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => {
      first.push(event);
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(fake.bodies.length, 1);
    let rows = await rowsOf(conversationId);
    assert.deepEqual(rows.map((row) => [row.role, row.steering]), [
      ["user", null],
      ["user", "waiting"],
      ["assistant", null],
    ]);
    const shown = await getConversation(owner, conversationId);
    assert.equal(shown.messages.at(-1)!.content, "Make it due Friday");
    assert.equal(shown.messages.at(-1)!.waiting, true);

    const resumed: AssistantEvent[] = [];
    await resumeConversation(owner, conversationId, (event) => resumed.push(event), { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(fake.bodies.length, 1);

    const second: AssistantEvent[] = [];
    await decideActions(owner, { conversationId, decisions: [{ id: "call_task", approve: true }] }, (event) => second.push(event), { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(fake.bodies.length, 2);
    const messages = fake.bodies[1].messages;
    assert.deepEqual(messages.slice(-3).map((message) => message.role), ["assistant", "tool", "user"]);
    assert.match(messageText(messages.at(-2)!.content), /Approved at/);
    assert.equal(messageText(messages.at(-1)!.content), "Make it due Friday");
    assert.ok(second.some((event) => event.type === "steered"));
    rows = await rowsOf(conversationId);
    assert.deepEqual(rows.map((row) => [row.role, row.steering]), [
      ["user", null],
      ["assistant", null],
      ["tool", null],
      ["user", "folded"],
      ["assistant", null],
    ]);
  });

  it("never picks a message up twice when two runs race for the conversation", async () => {
    const quiet = model([{ content: "First answer." }]);
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: "Hello", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), { deadline: deadline(), fetchImpl: quiet.fetchImpl });
    const conversationId = conversationOf(events);
    await getAdminPool().query(
      `insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content, steering)
       values ($1, $2, $3, 'user', 'One more thing', 'waiting'), ($1, $2, $3, 'user', 'And another', 'waiting')`,
      [conversationId, owner.workspaceId, owner.userId],
    );
    const slow = model([{ content: "Both covered." }, { content: "Should not run." }], () => new Promise((resolve) => setTimeout(resolve, 300)));
    const runs = await Promise.all(
      [0, 1, 2].map(async () => {
        const seen: AssistantEvent[] = [];
        await resumeConversation(owner, conversationId, (event) => seen.push(event), { deadline: deadline(), fetchImpl: slow.fetchImpl });
        return seen;
      }),
    );
    assert.equal(slow.bodies.length, 1);
    assert.deepEqual(texts(slow.bodies[0]).slice(-2).map(([, text]) => text.replace(/\n\n<orbit_context>[\s\S]*$/, "")), ["One more thing", "And another"]);
    assert.equal(runs.flat().filter((event) => event.type === "steered").length, 1);
    const rows = await rowsOf(conversationId);
    assert.deepEqual(rows.map((row) => row.content), ["Hello", "First answer.", "One more thing", "And another", "Both covered."]);
    assert.ok(rows.every((row) => row.steering === null));
  });

  it("answers messages that arrive after the turn ends from the request that saved them", async () => {
    const quiet = model([{ content: "First answer." }, { content: "Second answer." }]);
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: "Hello again", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), { deadline: deadline(), fetchImpl: quiet.fetchImpl });
    const conversationId = conversationOf(events);
    const late = await steer(owner, conversationId, "Thanks, and the totals?", quiet.fetchImpl);
    assert.equal(quiet.bodies.length, 2);
    assert.ok(late.some((event) => event.type === "steered"));
    assert.ok(late.some((event) => event.type === "message" && event.message.content === "Second answer."));
  });

  it("stops everything on Stop and keeps the unanswered message as an ordinary one", async () => {
    let conversationId = "";
    const fake = model([{ content: "", calls: [{ id: "call_stop", name: "search_records", args: { query: "Acme" } }] }], async (index) => {
      if (index !== 1) return;
      await steer(owner, conversationId, "Never mind the rest", fake.fetchImpl);
      await stopConversation(owner, conversationId);
      await new Promise((resolve) => setTimeout(resolve, 3_500));
    });
    await sendMessage(owner, { message: "Search everything", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => {
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(fake.bodies.length, 1);
    const rows = await rowsOf(conversationId);
    assert.ok(rows.every((row) => row.steering === null));
    assert.ok(rows.some((row) => row.content === "Never mind the rest"));
  });

  it("refuses to steer someone else's conversation", async () => {
    const stranger = await createUser("steering-stranger@orbit.test", "Someone Else");
    const quiet = model([{ content: "Hi." }]);
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: "Private", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), { deadline: deadline(), fetchImpl: quiet.fetchImpl });
    await assert.rejects(steer(stranger, conversationOf(events), "Let me in", quiet.fetchImpl), /Conversation not found/);
  });
});

async function pairMac(owner: UserActor) {
  const { code } = await createPairingCode(owner);
  const paired = await redeemPairing(code.toLowerCase(), "Steering Mac");
  return authenticateCompanion(new Request("https://orbit.test/api/companion/me", { headers: { authorization: `Bearer ${paired.token}` } }));
}

async function answer(auth: AuthenticatedCompanion, respond: (job: CompanionJob) => Promise<CompanionResult>) {
  const job = await nextCompanionJob(auth, 15_000);
  assert.ok(job, "the companion should receive a job");
  const result = readCompanionResult(JSON.parse(JSON.stringify(await respond(job))));
  await finishCompanionJob(auth, job.id, (actor, conversationId) => applyCompanionResult(actor, conversationId, result));
  return job;
}

describe("steering Orbit Agent", () => {
  let owner: UserActor;
  let auth: AuthenticatedCompanion;

  before(async () => {
    owner = await createUser("steering-mac@orbit.test", "Mark Ridgeon");
    auth = await pairMac(owner);
  });

  it("hands mid-turn messages to the agent and places them where the agent read them", async () => {
    const events: AssistantEvent[] = [];
    let conversationId = "";
    const turn = sendMessage(owner, { message: "Find the Acme offices", model: "claude/claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => {
      events.push(event);
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: deadline() });
    let steerId = "";
    const job = await answer(auth, async (claimed) => {
      const saved = await steer(owner, conversationId, "Only the London ones", (async () => Response.json({})) as unknown as typeof fetch);
      steerId = (saved.find((event) => event.type === "user") as Extract<AssistantEvent, { type: "user" }>).message.id;
      const fetched = await companionSteers(auth, claimed.id);
      assert.deepEqual(fetched.map((entry) => entry.id), [steerId]);
      assert.match(fetched[0].text, /^Only the London ones/);
      assert.deepEqual((await companionSteers(auth, claimed.id)).map((entry) => entry.id), [steerId]);
      return {
        steps: [
          { text: "Looking.", calls: [{ id: "toolu_a", name: "search_records", arguments: '{"query":"Acme"}' }] },
          { text: "Two London offices.", calls: [] },
        ],
        results: { toolu_a: { content: '{"companies":[]}', isError: false } },
        sources: [],
        model: "claude-sonnet-5-5",
        usage: null,
        steered: [{ id: steerId, step: 1 }],
      };
    });
    await turn;
    assert.ok(job);
    const rows = await rowsOf(conversationId);
    assert.deepEqual(
      rows.map((row) => [row.role, row.content, row.steering]),
      [
        ["user", "Find the Acme offices", null],
        ["assistant", "Looking.", null],
        ["tool", '{"companies":[]}', null],
        ["user", "Only the London ones", "folded"],
        ["assistant", "Two London offices.", null],
      ],
    );
    const jobs = await getAdminPool().query("select count(*)::int as count from crm.ai_companion_jobs where conversation_id = $1", [conversationId]);
    assert.equal(jobs.rows[0].count, 1);
    const order = events.filter((event) => event.type === "message" || event.type === "steered").map((event) => (event.type === "steered" ? `steered` : event.message.content));
    assert.deepEqual(order.slice(-3), ["Looking.", "steered", "Two London offices."]);
  });

  it("answers in a follow-on job when an older agent never reads the message", async () => {
    let conversationId = "";
    const turn = sendMessage(owner, { message: "List the offices", model: "claude/claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => {
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: deadline() });
    await answer(auth, async () => {
      await steer(owner, conversationId, "Only London, please", (async () => Response.json({})) as unknown as typeof fetch);
      return { steps: [{ text: "All five offices.", calls: [] }], results: {}, sources: [], model: null, usage: null };
    });
    let followUp: CompanionJob | null = null;
    await answer(auth, async (job) => {
      followUp = job;
      return { steps: [{ text: "Two in London.", calls: [] }], results: {}, sources: [], model: null, usage: null };
    });
    await turn;
    assert.match((followUp as CompanionJob | null)!.request.prompt, /The user's latest message:\nOnly London, please\n\n<orbit_context>/);
    const rows = await rowsOf(conversationId);
    assert.deepEqual(rows.map((row) => row.content), ["List the offices", "All five offices.", "Only London, please", "Two in London."]);
  });

  it("feeds steering messages into a running Claude Code turn and reports which it read", async () => {
    const prompts: string[] = [];
    let release = () => undefined as void;
    const steerArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const steerId = "6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
    let served = false;
    const sdk = {
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
      query: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        async function* stream(): AsyncGenerator<SDKMessage> {
          const input = prompt[Symbol.asyncIterator]();
          const first = await input.next();
          prompts.push(String((first.value as SDKUserMessage).message.content));
          const firstId = (first.value as SDKUserMessage).uuid;
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } } as unknown as SDKMessage;
          yield { type: "assistant", parent_tool_use_id: null, uuid: "a1", session_id: "s", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t1", name: "mcp__orbit__search_records", input: { query: "Acme" } }] } } as unknown as SDKMessage;
          await steerArrived;
          const second = await input.next();
          prompts.push(String((second.value as SDKUserMessage).message.content));
          yield { type: "user", parent_tool_use_id: null, session_id: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "found" }] } } as unknown as SDKMessage;
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } } as unknown as SDKMessage;
          yield { type: "assistant", parent_tool_use_id: null, uuid: "a2", session_id: "s", message: { id: "m2", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Two in London." }] } } as unknown as SDKMessage;
          yield { type: "result", subtype: "success", is_error: false, result: "", usage: {}, uuid: "r", session_id: "s", user_message_uuids: [firstId, steerId], queued_turn_count: 0 } as unknown as SDKMessage;
          const end = await input.next();
          assert.equal(end.done, true);
        }
        return stream();
      },
    } as unknown as Sdk;
    const result = await runTurn(
      { model: "claude-sonnet-5-5", effort: "low", webSearch: false, system: "", prompt: "Find offices", tools: [{ name: "search_records", description: "Search", parameters: { type: "object", properties: {} }, write: false }] },
      {
        sdk,
        cwd: "/tmp",
        env: {},
        callTool: async () => ({ content: "found", isError: false }),
        steerEveryMs: 5,
        steers: async () => {
          if (served) return [{ id: steerId, text: "Only London" }];
          served = true;
          release();
          return [{ id: steerId, text: "Only London" }];
        },
      },
    );
    assert.deepEqual(prompts, ["Find offices", "Only London"]);
    assert.deepEqual(result.steered, [{ id: steerId, step: 1 }]);
    assert.equal(result.steps.length, 2);
  });

  it("leaves out a message the agent fetched but Claude Code never read", async () => {
    const steerId = "7f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
    let fetched = false;
    const sdk = {
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
      query: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        async function* stream(): AsyncGenerator<SDKMessage> {
          const input = prompt[Symbol.asyncIterator]();
          const first = await input.next();
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } } as unknown as SDKMessage;
          while (!fetched) await new Promise((resolve) => setTimeout(resolve, 5));
          yield { type: "assistant", parent_tool_use_id: null, uuid: "a1", session_id: "s", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Done." }] } } as unknown as SDKMessage;
          yield { type: "result", subtype: "success", is_error: false, result: "", usage: {}, uuid: "r", session_id: "s", user_message_uuids: [(first.value as SDKUserMessage).uuid], queued_turn_count: 0 } as unknown as SDKMessage;
        }
        return stream();
      },
    } as unknown as Sdk;
    const result = await runTurn(
      { model: "claude-sonnet-5-5", effort: "low", webSearch: false, system: "", prompt: "Hi", tools: [] },
      {
        sdk,
        cwd: "/tmp",
        env: {},
        callTool: async () => ({ content: "", isError: false }),
        steerEveryMs: 5,
        steers: async () => {
          fetched = true;
          return [{ id: steerId, text: "Late" }];
        },
      },
    );
    assert.equal(result.steered, undefined);
  });

  it("puts messages sent during an approval after the results in the agent's transcript", () => {
    const prompt = buildPrompt(
      [
        { role: "user", content: "Add a task" },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "create_task", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: '{"approved":"Approved at now."}' },
        { role: "user", content: "Make it Friday" },
      ],
      1,
    );
    assert.match(prompt, /approved or cancelled the actions you proposed[\s\S]*While you were working, the user also wrote:\n<user>\nMake it Friday\n<\/user>$/);
    assert.ok(!prompt.includes("The user's latest message"));
    assert.equal(PROPOSED.length > 0, true);
  });
});
