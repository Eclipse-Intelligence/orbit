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
  sweepWaitingSteers,
  type AssistantEvent,
} from "@/lib/assistant/chat";
import { POST as postMessages } from "@/app/api/companion/jobs/[id]/messages/route";
import { POST as postComplete } from "@/app/api/companion/jobs/[id]/complete/route";
import { POST as postFail } from "@/app/api/companion/jobs/[id]/fail/route";
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
    const composed: boolean[] = [];
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
          composed.push((second.value as SDKUserMessage).client_composed === true, (first.value as SDKUserMessage).client_composed === true);
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
    assert.deepEqual(composed, [true, false]);
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

describe("steering safeguards", () => {
  let owner: UserActor;

  before(async () => {
    owner = await createUser("steering-guards@orbit.test", "Mark Ridgeon");
  });

  async function finished(message: string, fetchImpl: typeof fetch) {
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message, model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), { deadline: deadline(), fetchImpl });
    return conversationOf(events);
  }

  it("holds the lease while approved changes run, so a message sent then waits for their results", async () => {
    let conversationId = "";
    let leaseSeen: string | null = null;
    const fake = model([{ content: "Adding it.", calls: [{ id: "call_hold", name: "create_task", args: { title: "Call Initech" } }] }, { content: "Done, and due Friday." }], async (index) => {
      if (index !== 2) return;
      leaseSeen = (await getAdminPool().query("select turn_runner from crm.assistant_conversations where id = $1", [conversationId])).rows[0].turn_runner;
    });
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: "Add a task to call Initech", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), { deadline: deadline(), fetchImpl: fake.fetchImpl });
    conversationId = conversationOf(events);
    const card = (await rowsOf(conversationId)).find((row) => row.role === "assistant")!;
    await getAdminPool().query(`update crm.assistant_messages set actions = jsonb_set(actions, '{0,status}', '"running"') where id = $1`, [card.id]);
    await steer(owner, conversationId, "Make it due Friday", fake.fetchImpl);
    await resumeConversation(owner, conversationId, () => undefined, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(fake.bodies.length, 1);
    assert.equal((await rowsOf(conversationId)).at(-1)!.steering, "waiting");
    await getAdminPool().query(`update crm.assistant_messages set actions = jsonb_set(actions, '{0,status}', '"pending"') where id = $1`, [card.id]);

    await decideActions(owner, { conversationId, decisions: [{ id: "call_hold", approve: true }] }, () => undefined, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.ok(leaseSeen);
    assert.deepEqual(fake.bodies[1].messages.slice(-3).map((message) => message.role), ["assistant", "tool", "user"]);
    const lease = await getAdminPool().query("select turn_runner from crm.assistant_conversations where id = $1", [conversationId]);
    assert.equal(lease.rows[0].turn_runner, null);
  });

  it("keeps each tool result with its call whatever order the rows were saved in", () => {
    const at = new Date().toISOString();
    const base = { tool_calls: null, tool_call_id: null, tool_name: null, actions: null, sources: null, provider_state: null, created_at: at };
    const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
    const rows = [
      { ...base, id: "u1", role: "user" as const, content: "Search", steering: null },
      { ...base, id: "a1", role: "assistant" as const, content: "", tool_calls: [call("c1", "search_records"), call("c2", "list_tasks")] },
      { ...base, id: "t2", role: "tool" as const, content: "two", tool_call_id: "c2" },
      { ...base, id: "s1", role: "user" as const, content: "Stop that", steering: null },
      { ...base, id: "t1", role: "tool" as const, content: "one", tool_call_id: "c1" },
    ];
    assert.deepEqual(
      history(rows).map((message) => [message.role, message.role === "tool" ? message.tool_call_id : messageText(message.content)]),
      [
        ["user", "Search"],
        ["assistant", ""],
        ["tool", "c2"],
        ["tool", "c1"],
        ["user", "Stop that"],
      ],
    );
  });

  it("saves a message sent after Stop as an ordinary one and doesn't answer it", async () => {
    const fake = model([{ content: "First." }]);
    const conversationId = await finished("Start something", fake.fetchImpl);
    await stopConversation(owner, conversationId);
    const events = await steer(owner, conversationId, "And another thing", fake.fetchImpl);
    assert.equal(fake.bodies.length, 1);
    const user = events.find((event) => event.type === "user") as Extract<AssistantEvent, { type: "user" }>;
    assert.equal(user.message.waiting, undefined);
    assert.equal((await rowsOf(conversationId)).at(-1)!.steering, null);
  });

  it("leaves messages waiting while an Orbit Agent job is queued or running", async () => {
    const fake = model([{ content: "First." }, { content: "Should not run." }]);
    const conversationId = await finished("Hello Mac", fake.fetchImpl);
    const job = await getAdminPool().query<{ id: string }>(
      `insert into crm.ai_companion_jobs (workspace_id, user_id, conversation_id, request, status) values ($1, $2, $3, '{}'::jsonb, 'running') returning id`,
      [owner.workspaceId, owner.userId, conversationId],
    );
    await steer(owner, conversationId, "Only London", fake.fetchImpl);
    await resumeConversation(owner, conversationId, () => undefined, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(fake.bodies.length, 1);
    const status = await getAdminPool().query("select status from crm.ai_companion_jobs where id = $1", [job.rows[0].id]);
    assert.equal(status.rows[0].status, "running");
    assert.equal((await rowsOf(conversationId)).at(-1)!.steering, "waiting");
    await getAdminPool().query("update crm.ai_companion_jobs set status = 'cancelled' where id = $1", [job.rows[0].id]);
  });

  it("never picks a message up for a run that has lost the lease", async () => {
    let conversationId = "";
    const fake = model([{ content: "", calls: [{ id: "call_lost", name: "search_records", args: { query: "Acme" } }] }, { content: "Should not run." }], async (index) => {
      if (index !== 1) return;
      await getAdminPool().query("update crm.assistant_conversations set turn_runner = gen_random_uuid(), turn_until = now() + interval '5 minutes' where id = $1", [conversationId]);
      await steer(owner, conversationId, "Only the London ones", fake.fetchImpl);
    });
    await sendMessage(owner, { message: "Search Acme", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => {
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(fake.bodies.length, 1);
    assert.equal((await rowsOf(conversationId)).find((row) => row.content === "Only the London ones")!.steering, "waiting");
  });

  it("takes over an expired lease to answer a message", async () => {
    const fake = model([{ content: "First." }, { content: "Answered." }]);
    const conversationId = await finished("Hello lease", fake.fetchImpl);
    await getAdminPool().query("update crm.assistant_conversations set turn_runner = gen_random_uuid(), turn_until = now() - interval '1 minute' where id = $1", [conversationId]);
    await steer(owner, conversationId, "Still there?", fake.fetchImpl);
    assert.equal(fake.bodies.length, 2);
    assert.equal((await rowsOf(conversationId)).at(-1)!.content, "Answered.");
  });

  it("leaves a message for the dock to resume when the turn is nearly out of time", async () => {
    let conversationId = "";
    const fake = model([{ content: "Quick answer." }, { content: "Now the London ones." }], async (index) => {
      if (index === 1) await steer(owner, conversationId, "Only London", fake.fetchImpl);
    });
    await sendMessage(owner, { message: "Quick one", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => {
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: Date.now() + 40_000, fetchImpl: fake.fetchImpl });
    assert.equal(fake.bodies.length, 1);
    assert.equal((await rowsOf(conversationId)).find((row) => row.content === "Only London")!.steering, "waiting");
    await resumeConversation(owner, conversationId, () => undefined, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(fake.bodies.length, 2);
    assert.equal((await rowsOf(conversationId)).at(-1)!.content, "Now the London ones.");
  });

  it("answers messages nothing else is answering from the cron sweep", async () => {
    const fake = model([{ content: "First." }, { content: "Swept." }]);
    const conversationId = await finished("Hello sweep", fake.fetchImpl);
    await getAdminPool().query(
      `insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content, steering, created_at)
       values ($1, $2, $3, 'user', 'Left behind', 'waiting', now() - interval '2 minutes')`,
      [conversationId, owner.workspaceId, owner.userId],
    );
    const answered = await sweepWaitingSteers(Date.now() + 200_000, { fetchImpl: fake.fetchImpl });
    assert.ok(answered >= 1);
    assert.deepEqual(
      (await rowsOf(conversationId)).slice(-2).map((row) => [row.content, row.steering]),
      [
        ["Left behind", null],
        ["Swept.", null],
      ],
    );
  });

  it("doesn't move the chat up the list when only the lease changes", async () => {
    const fake = model([{ content: "First." }]);
    const conversationId = await finished("Hello order", fake.fetchImpl);
    const read = async () => (await getAdminPool().query("select updated_at from crm.assistant_conversations where id = $1", [conversationId])).rows[0].updated_at;
    const before = await read();
    await resumeConversation(owner, conversationId, () => undefined, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(new Date(await read()).getTime(), new Date(before).getTime());
  });

  it("keeps the page and file notes of each message sent while Orbit works", async () => {
    let conversationId = "";
    const file = await getAdminPool().query<{ id: string }>(
      "insert into crm.chat_files (workspace_id, user_id, name, content_type, size) values ($1, $2, 'Offices.pdf', 'application/pdf', 2048) returning id",
      [owner.workspaceId, owner.userId],
    );
    const fake = model([{ content: "", calls: [{ id: "call_notes", name: "search_records", args: { query: "Acme" } }] }, { content: "Read it." }], async (index) => {
      if (index !== 1) return;
      await sendMessage(
        owner,
        { conversationId, message: "Use this list", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false, steer: true, files: [file.rows[0].id], page: { path: "/tasks" } },
        () => undefined,
        { deadline: deadline(), fetchImpl: fake.fetchImpl },
      );
    });
    await sendMessage(owner, { message: "Find the offices", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => {
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.match(messageText(fake.bodies[1].messages.at(-1)!.content), /^Use this list\n\n\[Orbit note: the user attached this file[\s\S]*Offices\.pdf[\s\S]*<page_context>/);
  });
});

describe("Orbit Agent steering routes", () => {
  let owner: UserActor;
  let token = "";

  before(async () => {
    owner = await createUser("steering-routes@orbit.test", "Mark Ridgeon");
    const { code } = await createPairingCode(owner);
    token = (await redeemPairing(code.toLowerCase(), "Route Mac")).token;
  });

  const call = (handler: typeof postMessages, jobId: string, body: unknown, bearer = token) =>
    handler(
      new Request(`https://orbit.test/api/companion/jobs/${jobId}/x`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: jobId }) },
    );

  const mac = () => authenticateCompanion(new Request("https://orbit.test/api/companion/me", { headers: { authorization: `Bearer ${token}` } }));

  async function claimJob() {
    const job = await nextCompanionJob(await mac(), 15_000);
    assert.ok(job);
    return job;
  }

  it("serves waiting messages to the job's own Mac, places what it read on /complete and answers the rest after /fail", async () => {
    let conversationId = "";
    const turn = sendMessage(owner, { message: "Count the offices", model: "claude/claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => {
      if (event.type === "conversation") conversationId = event.conversation.id;
    }, { deadline: deadline() });
    const job = await claimJob();
    const saved = await steer(owner, conversationId, "Only London", (async () => Response.json({})) as unknown as typeof fetch);
    const steerId = (saved.find((event) => event.type === "user") as Extract<AssistantEvent, { type: "user" }>).message.id;

    const stranger = await createUser("steering-routes-stranger@orbit.test", "Someone Else");
    const { code } = await createPairingCode(stranger);
    const strangerToken = (await redeemPairing(code.toLowerCase(), "Other Mac")).token;
    assert.equal((await call(postMessages, job.id, {}, strangerToken)).status, 404);

    const served = (await (await call(postMessages, job.id, {})).json()) as { messages: { id: string; text: string }[] };
    assert.deepEqual(served.messages.map((message) => message.id), [steerId]);
    const done = await call(postComplete, job.id, {
      steps: [
        { text: "Looking.", calls: [] },
        { text: "Two in London.", calls: [] },
      ],
      results: {},
      sources: [],
      model: null,
      usage: null,
      steered: [{ id: steerId, step: 1 }],
    });
    assert.equal(done.status, 200);
    await turn;
    assert.deepEqual(
      (await rowsOf(conversationId)).map((row) => [row.content, row.steering]),
      [
        ["Count the offices", null],
        ["Looking.", null],
        ["Only London", "folded"],
        ["Two in London.", null],
      ],
    );

    const second = sendMessage(owner, { conversationId, message: "And Paris?", model: "claude/claude-sonnet-5-5", reasoning: "low", webSearch: false }, () => undefined, { deadline: deadline() });
    const failing = await claimJob();
    await steer(owner, conversationId, "Skip Paris, do Berlin", (async () => Response.json({})) as unknown as typeof fetch);
    assert.equal((await call(postFail, failing.id, { error: "Claude Code crashed." })).status, 200);
    const followUp = await claimJob();
    assert.match(followUp.request.prompt, /The user's latest message:\nSkip Paris, do Berlin/);
    await finishCompanionJob(await mac(), followUp.id, (actor, id) => applyCompanionResult(actor, id, { steps: [{ text: "Berlin has one.", calls: [] }], results: {}, sources: [], model: null, usage: null }));
    await second;
  });

  it("gives email jobs no messages from the dock", async () => {
    const quiet = model([{ content: "Hi." }]);
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: "Email chat", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), { deadline: deadline(), fetchImpl: quiet.fetchImpl });
    const conversationId = conversationOf(events);
    await getAdminPool().query(`insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content, steering) values ($1, $2, $3, 'user', 'From the dock', 'waiting')`, [
      conversationId,
      owner.workspaceId,
      owner.userId,
    ]);
    const auth = await mac();
    const job = await getAdminPool().query<{ id: string }>(
      `insert into crm.ai_companion_jobs (workspace_id, user_id, conversation_id, request, status, companion_id, claimed_at) values ($1, $2, $3, '{}'::jsonb, 'running', $4, now()) returning id`,
      [owner.workspaceId, owner.userId, conversationId, auth.companionId],
    );
    const jobId = job.rows[0].id;
    assert.equal((await companionSteers(auth, jobId)).length, 1);
    await getAdminPool().query(`begin; set local session_replication_role = replica; update crm.ai_companion_jobs set agent_mail_id = gen_random_uuid() where id = '${jobId}'; commit;`);
    assert.deepEqual(await companionSteers(auth, jobId), []);
    await getAdminPool().query("update crm.ai_companion_jobs set status = 'cancelled' where id = $1", [jobId]);
  });
});

describe("Orbit Agent turn endings", () => {
  function sdkWith(frames: (firstId: string) => SDKMessage[]) {
    return {
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
      query: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        async function* stream(): AsyncGenerator<SDKMessage> {
          const input = prompt[Symbol.asyncIterator]();
          const first = await input.next();
          await new Promise((resolve) => setTimeout(resolve, 30));
          for (const frame of frames((first.value as SDKUserMessage).uuid ?? "")) yield frame;
        }
        return stream();
      },
    } as unknown as Sdk;
  }

  const request = { model: "claude-sonnet-5-5", effort: "low" as const, webSearch: false, system: "", prompt: "Hi", tools: [] };
  const deps = (sdk: Sdk, steerId: string) => ({
    sdk,
    cwd: "/tmp",
    env: {},
    callTool: async () => ({ content: "", isError: false }),
    steerEveryMs: 5,
    steers: async () => [{ id: steerId, text: "Also this" }],
  });

  it("never counts a message as read when Claude Code doesn't confirm it", async () => {
    const steerId = "8f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
    const sdk = sdkWith(
      () =>
        [
          { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } },
          { type: "assistant", parent_tool_use_id: null, uuid: "a1", session_id: "s", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Done." }] } },
          { type: "result", subtype: "success", is_error: false, result: "", usage: {}, uuid: "r", session_id: "s" },
        ] as unknown as SDKMessage[],
    );
    const result = await runTurn(request, deps(sdk, steerId));
    assert.equal(result.steered, undefined);
  });

  it("places a message where an assistant frame says it was read, and ends the job from its last turn", async () => {
    const steerId = "9f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
    const sdk = sdkWith(
      (firstId) =>
        [
          { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } },
          { type: "assistant", parent_tool_use_id: null, uuid: "a1", session_id: "s", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Working." }] } },
          { type: "result", subtype: "error_max_turns", is_error: true, errors: [], usage: {}, uuid: "r1", session_id: "s", user_message_uuids: [firstId], queued_turn_count: 1 },
          { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } },
          { type: "assistant", parent_tool_use_id: null, uuid: "a2", session_id: "s", user_message_uuids: [steerId], message: { id: "m2", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Also done." }] } },
          { type: "result", subtype: "success", is_error: false, result: "", usage: {}, uuid: "r2", session_id: "s", user_message_uuids: [steerId], queued_turn_count: 0 },
        ] as unknown as SDKMessage[],
    );
    const result = await runTurn(request, deps(sdk, steerId));
    assert.deepEqual(result.steered, [{ id: steerId, step: 1 }]);
    assert.deepEqual(
      result.steps.map((step) => step.text),
      ["Working.", "Also done."],
    );
  });
});
