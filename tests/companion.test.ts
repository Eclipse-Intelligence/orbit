import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { applyCompanionResult, decideActions, getConversation, listConversations, sendMessage, STOPPED_MESSAGE, type AssistantEvent } from "@/lib/assistant/chat";
import {
  LOST_MESSAGE,
  cancelCompanionJob,
  checkCompanionJob,
  companionBusy,
  companionWorking,
  enqueueCompanionJob,
  failCompanionJob,
  failureReply,
  finishCompanionJob,
  nextCompanionJob,
  saveCompanionDraft,
  runCompanionTool,
} from "@/lib/companion/jobs";
import {
  authenticateCompanion,
  companionOfflineMessage,
  createPairingCode,
  listCompanions,
  redeemPairing,
  revokeCompanion,
  type AuthenticatedCompanion,
} from "@/lib/companion/pairing";
import { buildPrompt } from "@/lib/companion/transcript";
import { createCompany } from "@/lib/crm/companies";
import { listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { CompanionJob, CompanionRequest, CompanionResult } from "@/companion/src/protocol";
import { shapeFor } from "@/companion/src/schema";
import { launchPath, launchPlist } from "@/companion/src/launch";
import { PROPOSED, STOPPED, cleanEnv, runTurn, type Sdk } from "@/companion/src/turn";
import { createUser, resetDatabase } from "./helpers";

function bearer(token: string) {
  return new Request("https://orbit.test/api/companion/me", { headers: { authorization: `Bearer ${token}` } });
}

async function pairMac(owner: UserActor, name = "Mark's Mac mini") {
  const { code } = await createPairingCode(owner);
  const paired = await redeemPairing(code.toLowerCase(), name);
  return { token: paired.token, auth: await authenticateCompanion(bearer(paired.token)) };
}

async function answer(auth: AuthenticatedCompanion, respond: (job: CompanionJob) => Promise<CompanionResult>) {
  const job = await nextCompanionJob(auth, 15_000);
  assert.ok(job, "the companion should receive a job");
  const result = await respond(job);
  await finishCompanionJob(auth, job.id, (actor, conversationId) => applyCompanionResult(actor, conversationId, result));
  return job;
}

const deadline = () => Date.now() + 60_000;

before(async () => {
  await resetDatabase();
});

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
});

after(async () => {
  await getPool().end();
});

describe("Orbit Agent pairing", () => {
  let owner: UserActor;

  before(async () => {
    owner = await createUser("agent-pair@orbit.test", "Mark Ridgeon");
  });

  it("pairs a Mac once with a short-lived code and authenticates its token", async () => {
    const { code } = await createPairingCode(owner);
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const paired = await redeemPairing(code, "Studio");
    assert.match(paired.token, /^oa_/);
    assert.equal(paired.email, "agent-pair@orbit.test");
    await assert.rejects(redeemPairing(code, "Again"), /expired or was already used/);

    const auth = await authenticateCompanion(bearer(paired.token));
    assert.equal(auth.actor.userId, owner.userId);
    assert.equal(auth.name, "Studio");
    const listed = await listCompanions(owner);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].online, true);

    await revokeCompanion(owner, listed[0].id);
    await assert.rejects(authenticateCompanion(bearer(paired.token)), /removed from Orbit/);
    await assert.rejects(authenticateCompanion(bearer("oa_made-up")), /removed from Orbit/);
    assert.equal((await listCompanions(owner)).length, 0);
  });

  it("stores only a hash of the companion token", async () => {
    const { token } = await pairMac(owner, "Hash check");
    const stored = await getPool().query("select 1 from pg_tables where tablename = 'ai_companions'");
    assert.equal(stored.rowCount, 1);
    const admin = await (await import("@/lib/db/pool")).getAdminPool().query<{ token_hash: string }>(
      "select token_hash from crm.ai_companions where name = 'Hash check'",
    );
    assert.notEqual(admin.rows[0].token_hash, token);
    assert.equal(admin.rows[0].token_hash.length, 64);
  });
});

describe("Orbit Agent turns", () => {
  let owner: UserActor;
  let auth: AuthenticatedCompanion;

  before(async () => {
    owner = await createUser("agent-turns@orbit.test", "Mark Ridgeon");
    await createCompany(owner, { name: "Acme Agent", domain: "acme-agent.test" });
    auth = (await pairMac(owner)).auth;
  });

  it("runs a Claude turn on the Mac, records the tools and waits for approval of changes", async () => {
    const events: AssistantEvent[] = [];
    let firstJob: CompanionJob | null = null;
    const companion = answer(auth, async (job) => {
      firstJob = job;
      const tool = await runCompanionTool(auth, job.id, { id: "evt_1", name: "search_records", arguments: '{"query":"Acme"}' });
      assert.equal(tool.isError, false);
      assert.match(tool.content, /Acme Agent/);
      const blocked = await runCompanionTool(auth, job.id, { id: "evt_2", name: "create_task", arguments: '{"title":"x"}' });
      assert.equal(blocked.isError, true);
      return {
        steps: [
          { text: "Looking up Acme.", calls: [{ id: "toolu_read", name: "search_records", arguments: '{"query":"Acme"}' }] },
          { text: "I'll add a follow-up task.", calls: [{ id: "toolu_write", name: "create_task", arguments: '{"title":"Call Acme","sendToClickUp":false}' }] },
        ],
        results: { toolu_read: { content: tool.content, isError: false } },
        sources: [],
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 10 },
      };
    });
    await Promise.all([
      sendMessage(
        owner,
        { message: "Add a task to call Acme", model: "claude/claude-sonnet-5-5", reasoning: "high", webSearch: false },
        (event) => events.push(event),
        { deadline: deadline() },
      ),
      companion,
    ]);
    assert.ok(!events.some((event) => event.type === "error"), JSON.stringify(events.filter((event) => event.type === "error")));
    const request = (firstJob as CompanionJob | null)!.request as CompanionRequest;
    assert.equal(request.model, "claude-sonnet-5-5");
    assert.equal(request.effort, "high");
    assert.equal(request.prompt, "Add a task to call Acme");
    assert.ok(request.tools.find((tool) => tool.name === "create_task")!.write);
    assert.ok(!request.tools.find((tool) => tool.name === "search_records")!.write);
    assert.match(request.system, /You are the assistant inside Orbit/);

    assert.deepEqual(
      events.filter((event) => event.type === "tool").map((event) => [(event as { name: string }).name, (event as { status: string }).status]),
      [
        ["search_records", "running"],
        ["search_records", "done"],
      ],
    );
    const pending = events.find((event) => event.type === "actions") as Extract<AssistantEvent, { type: "actions" }>;
    assert.equal(pending.actions.length, 1);
    assert.equal(pending.actions[0].title, "Create task: Call Acme");
    assert.equal(pending.actions[0].status, "pending");
    assert.equal((await listTasks(owner, { query: "Call Acme" })).data.length, 0);

    const conversationId = (events[0] as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
    const second: AssistantEvent[] = [];
    let secondJob: CompanionJob | null = null;
    await Promise.all([
      decideActions(owner, { conversationId, decisions: [{ id: "toolu_write", approve: true }] }, (event) => second.push(event), {
        deadline: deadline(),
      }),
      answer(auth, async (job) => {
        secondJob = job;
        return { steps: [{ text: "Done. The task is in Orbit.", calls: [] }], results: {}, sources: [], model: null, usage: null };
      }),
    ]);
    assert.equal((await listTasks(owner, { query: "Call Acme" })).data.length, 1);
    const followUp = (secondJob as CompanionJob | null)!.request.prompt;
    assert.match(followUp, /<tool_call id="toolu_write" name="create_task">/);
    assert.match(followUp, /<tool_result id="toolu_write" name="create_task">/);
    assert.match(followUp, /approved or cancelled/);

    const saved = await getConversation(owner, conversationId);
    assert.deepEqual(
      saved.messages.map((message) => [message.role, message.content]),
      [
        ["user", "Add a task to call Acme"],
        ["assistant", "Looking up Acme."],
        ["assistant", "I'll add a follow-up task."],
        ["assistant", "Done. The task is in Orbit."],
      ],
    );
    assert.deepEqual(saved.messages[1].tools.map((tool) => tool.name), ["search_records"]);
    assert.equal(saved.messages[2].actions[0].status, "done");
  });

  it("asks you to pair a Mac before using a Claude account, and saves a reply when the Mac is off", async () => {
    const lonely = await createUser("agent-none@orbit.test", "Mark Ridgeon");
    await assert.rejects(
      sendMessage(lonely, { message: "Hi", model: "claude/claude-opus-5-5", reasoning: "medium", webSearch: false }, () => undefined, { deadline: deadline() }),
      /To use your Claude account, pair your Mac in Settings › Integrations/,
    );
    assert.equal((await listConversations(lonely)).length, 0);

    await pairMac(lonely, "Sleeping Mac");
    await getAdminPool().query("update crm.ai_companions set last_seen_at = now() - interval '2 hours' where name = 'Sleeping Mac'");
    const events: AssistantEvent[] = [];
    await sendMessage(lonely, { message: "Hi", model: "claude/claude-opus-5-5", reasoning: "medium", webSearch: false }, (event) => events.push(event), {
      deadline: deadline(),
    });
    const reply = events.find((event) => event.type === "message" && event.message.role === "assistant") as Extract<AssistantEvent, { type: "message" }>;
    assert.match(reply.message.content, /^I couldn't finish that\. .*isn't running on your Mac/);
    const conversationId = (events.find((event) => event.type === "conversation") as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
    const saved = await getConversation(lonely, conversationId);
    assert.match(saved.messages.at(-1)!.content, /isn't running on your Mac/);
  });

  it("explains how to start Orbit Agent and when it was last seen", async () => {
    const message = await companionOfflineMessage(owner, Date.now() + 21 * 3_600_000);
    assert.match(message, /isn't running on your Mac\. .+ was last seen 21 hours ago\./);
    assert.ok(message.endsWith("orbit-agent --install"));
  });


  it("streams the reply text from the Mac while it is being written", async () => {
    const events: AssistantEvent[] = [];
    const run = sendMessage(owner, { message: "Stream please", model: "claude/claude-opus-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), {
      deadline: deadline(),
    });
    await answer(auth, async (job) => {
      await saveCompanionDraft(auth, job.id, "Here is the start");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await saveCompanionDraft(auth, job.id, "Here is the start of it");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return { steps: [{ text: "Here is the start of it.", calls: [] }], results: {}, sources: [], model: null, usage: null };
    });
    await run;
    const drafts = events.filter((event) => event.type === "draft").map((event) => (event as { text: string }).text);
    assert.deepEqual(drafts, ["Here is the start", "Here is the start of it"]);
    assert.ok(events.some((event) => event.type === "message" && event.message.content === "Here is the start of it."));
  });

  it("only gives a job to the Mac that claimed it", async () => {
    const other = await createUser("agent-other@orbit.test", "Someone Else");
    const stranger = (await pairMac(other, "Other Mac")).auth;
    const events: AssistantEvent[] = [];
    const run = sendMessage(owner, { message: "Hello", model: "claude/claude-haiku-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), {
      deadline: deadline(),
    });
    assert.equal(await nextCompanionJob(stranger, 2_000), null);
    const job = await answer(auth, async () => ({ steps: [{ text: "Hi Mark.", calls: [] }], results: {}, sources: [], model: null, usage: null }));
    await run;
    await assert.rejects(runCompanionTool(stranger, job.id, { id: "x", name: "list_tags", arguments: "{}" }), /That request is gone/);
    assert.ok(events.some((event) => event.type === "message" && event.message.content === "Hi Mark."));
  });
});

describe("Orbit Agent job lifecycle", () => {
  let owner: UserActor;
  let mac: AuthenticatedCompanion;
  const request = { model: "claude-haiku-5-5", effort: "low", webSearch: false, system: "", prompt: "Hi", tools: [] } as unknown as CompanionRequest;

  async function conversation(title: string) {
    const fetchImpl: typeof fetch = async () =>
      Response.json({ model: "claude-sonnet-5-5", choices: [{ message: { role: "assistant", content: "Hello." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: title, model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), { deadline: deadline(), fetchImpl });
    return (events[0] as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
  }

  async function status(jobId: string) {
    return (await getAdminPool().query<{ status: string }>("select status from crm.ai_companion_jobs where id = $1", [jobId])).rows[0]?.status;
  }

  async function lastReply(conversationId: string) {
    return (await getConversation(owner, conversationId)).messages.at(-1)!.content;
  }

  before(async () => {
    owner = await createUser("agent-life@orbit.test", "Mark Ridgeon");
    mac = (await pairMac(owner, "Life Mac")).auth;
  });

  it("cancels the old answer when you follow up, tells the Mac, and answers the follow-up", async () => {
    const firstEvents: AssistantEvent[] = [];
    const first = sendMessage(owner, { message: "First question", model: "claude/claude-haiku-5-5", reasoning: "low", webSearch: false }, (event) => firstEvents.push(event), {
      deadline: deadline(),
    });
    const jobA = await nextCompanionJob(mac, 15_000);
    assert.ok(jobA);
    const conversationId = (firstEvents[0] as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
    const secondEvents: AssistantEvent[] = [];
    const second = sendMessage(
      owner,
      { conversationId, message: "Actually, a second question", model: "claude/claude-haiku-5-5", reasoning: "low", webSearch: false },
      (event) => secondEvents.push(event),
      { deadline: deadline() },
    );
    for (let tries = 0; tries < 50 && (await status(jobA.id)) !== "cancelled"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await status(jobA.id), "cancelled");
    await assert.rejects(checkCompanionJob(mac, jobA.id), /cancelled/);
    await assert.rejects(runCompanionTool(mac, jobA.id, { id: "late", name: "list_tags", arguments: "{}" }), /cancelled/);
    const queued = (await getAdminPool().query<{ id: string }>("select id from crm.ai_companion_jobs where conversation_id = $1 and status = 'queued'", [conversationId])).rows[0];
    assert.ok(queued);
    assert.equal(await companionBusy(owner, queued.id), true);
    await answer(mac, async (job) => {
      assert.equal(job.id, queued.id);
      return { steps: [{ text: "Here's the second answer.", calls: [] }], results: {}, sources: [], model: null, usage: null };
    });
    await Promise.all([first, second]);
    assert.ok(secondEvents.some((event) => event.type === "message" && event.message.content === "Here's the second answer."));
    assert.ok(!secondEvents.some((event) => event.type === "error"));
  });

  it("gives a reply when an answer goes quiet, but not when a second copy of Orbit Agent asks for work", async () => {
    const shared = await conversation("Two copies");
    const sharedJob = await enqueueCompanionJob(owner, shared, request);
    assert.equal((await nextCompanionJob(mac, 5_000))?.id, sharedJob);
    assert.equal(await nextCompanionJob(mac, 1_000), null);
    assert.equal(await status(sharedJob), "running");
    await checkCompanionJob(mac, sharedJob);
    await cancelCompanionJob(owner, sharedJob);

    const quiet = await conversation("Quiet Mac");
    const quietJob = await enqueueCompanionJob(owner, quiet, request);
    assert.equal((await nextCompanionJob(mac, 5_000))?.id, quietJob);
    await getAdminPool().query("alter table crm.ai_companion_jobs disable trigger ai_companion_jobs_set_updated_at");
    await getAdminPool().query("update crm.ai_companion_jobs set updated_at = now() - interval '4 minutes' where id = $1", [quietJob]);
    await getAdminPool().query("alter table crm.ai_companion_jobs enable trigger ai_companion_jobs_set_updated_at");
    assert.equal(await companionWorking(owner), false);
    await companionBusy(owner, "00000000-0000-0000-0000-000000000000");
    assert.equal(await status(quietJob), "cancelled");
    assert.equal(await lastReply(quiet), LOST_MESSAGE);
  });

  it("reports what the Mac is doing so a reopened chat shows progress", async () => {
    const progress = await conversation("Progress check");
    const job = await enqueueCompanionJob(owner, progress, request);
    assert.deepEqual((await getConversation(owner, progress)).working?.where, "mac");
    await nextCompanionJob(mac, 5_000);
    await runCompanionTool(mac, job, { id: "p1", name: "list_tags", arguments: "{}" });
    const working = (await getConversation(owner, progress)).working!;
    assert.equal(working.steps, 1);
    assert.equal(working.current, null);
    await finishCompanionJob(mac, job, (actor, conversationId) =>
      applyCompanionResult(actor, conversationId, { steps: [{ text: "All done.", calls: [] }], results: {}, sources: [], model: null, usage: null }),
    );
    const finished = await getConversation(owner, progress);
    assert.equal(finished.working, null);
    assert.equal(finished.messages.at(-1)!.content, "All done.");
  });

  it("counts a Mac that is busy answering as available even when it hasn't polled lately", async () => {
    const busy = await conversation("Busy Mac");
    const job = await enqueueCompanionJob(owner, busy, request);
    await nextCompanionJob(mac, 5_000);
    await getAdminPool().query("update crm.ai_companions set last_seen_at = now() - interval '2 minutes' where id = $1", [mac.companionId]);
    assert.equal((await listCompanions(owner)).some((companion) => companion.online), false);
    assert.equal(await companionWorking(owner), true);
    await cancelCompanionJob(owner, job);
  });

  it("keeps an answer that finishes while a cancel arrives, and saves a failure as a reply", async () => {
    const racing = await conversation("Racing cancel");
    const job = await enqueueCompanionJob(owner, racing, request);
    await nextCompanionJob(mac, 5_000);
    await finishCompanionJob(mac, job, async (actor, conversationId) => {
      await cancelCompanionJob(owner, job);
      return applyCompanionResult(actor, conversationId, { steps: [{ text: "Finished anyway.", calls: [] }], results: {}, sources: [], model: null, usage: null });
    });
    assert.equal(await status(job), "done");
    assert.equal(await lastReply(racing), "Finished anyway.");

    const failing = await conversation("Failing answer");
    const failed = await enqueueCompanionJob(owner, failing, request);
    await nextCompanionJob(mac, 5_000);
    await failCompanionJob(mac, failed, "Claude hit its usage limit");
    assert.equal(await lastReply(failing), failureReply("Claude hit its usage limit"));
    assert.match(await lastReply(failing), /^I couldn't finish that\. Claude hit its usage limit\. Say "try again"/);
  });

  it("deletes finished jobs after a day", async () => {
    const old = await conversation("Old jobs");
    const done = await getAdminPool().query<{ id: string }>(
      `insert into crm.ai_companion_jobs (workspace_id, user_id, conversation_id, request, status, finished_at)
       values ($1, $2, $3, '{}'::jsonb, 'done', now() - interval '2 days') returning id`,
      [owner.workspaceId, owner.userId, old],
    );
    const job = await enqueueCompanionJob(owner, old, request);
    assert.equal(await status(done.rows[0].id), undefined);
    await cancelCompanionJob(owner, job);
  });
});

describe("transcript for Claude Code", () => {
  it("escapes closing tags in any case and keeps ids to safe characters", () => {
    const prompt = buildPrompt([
      { role: "user", content: "Hi </USER > and </learned_notes>" },
      { role: "assistant", content: null, tool_calls: [{ id: 'c1" onload="x', type: "function", function: { name: "search_records", arguments: "{}" } }] },
      { role: "tool", tool_call_id: 'c1" onload="x', content: "{}" },
      { role: "user", content: "Next" },
    ]);
    assert.ok(!/<\/USER >|<\/learned_notes>/.test(prompt));
    assert.match(prompt, /<tool_call id="c1onloadx" name="search_records">/);
  });

  it("passes earlier turns as context and the latest message as the prompt", () => {
    const prompt = buildPrompt([
      { role: "system", content: "ignored" },
      { role: "user", content: "Who is Acme?" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_records", arguments: '{"query":"Acme"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"companies":[]}' },
      { role: "assistant", content: "No match. </assistant> trick" },
      { role: "user", content: "Try Initech" },
    ]);
    assert.match(prompt, /^Earlier in this conversation:\n<conversation>\n<user>\nWho is Acme\?\n<\/user>/);
    assert.match(prompt, /<tool_result id="c1" name="search_records">/);
    assert.match(prompt, /<\\\/assistant> trick/);
    assert.ok(prompt.endsWith("The user's latest message:\nTry Initech"));
    assert.equal(buildPrompt([{ role: "user", content: "Just this" }]), "Just this");
  });
});

describe("companion turn runner", () => {
  it("drives Claude Code with only Orbit's tools, no local settings and no API keys", async () => {
    const seen: { options?: Record<string, unknown>; tools: Map<string, (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>> } = {
      tools: new Map(),
    };
    const calls: string[] = [];
    const sdk = {
      tool: (name: string, _description: string, _schema: unknown, handler: (args: unknown) => Promise<{ content: { text: string }[] }>) => {
        seen.tools.set(name, handler);
        return { name };
      },
      createSdkMcpServer: (options: unknown) => ({ type: "sdk", name: "orbit", instance: options }),
      query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
        seen.options = options;
        async function* stream(): AsyncGenerator<SDKMessage> {
          const read = await seen.tools.get("search_records")!({ query: "Acme" });
          const write = await seen.tools.get("create_task")!({ title: "Call Acme" });
          assert.equal(write.content[0].text, PROPOSED);
          yield { type: "assistant", parent_tool_use_id: null, uuid: "u1", session_id: "s", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Checking." }] } } as unknown as SDKMessage;
          yield { type: "assistant", parent_tool_use_id: null, uuid: "u2", session_id: "s", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t1", name: "mcp__orbit__search_records", input: { query: "Acme" } }] } } as unknown as SDKMessage;
          yield { type: "user", parent_tool_use_id: null, session_id: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: read.content }] } } as unknown as SDKMessage;
          yield { type: "assistant", parent_tool_use_id: null, uuid: "u3", session_id: "s", message: { id: "m2", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t2", name: "mcp__orbit__create_task", input: { title: "Call Acme" } }, { type: "tool_use", id: "t3", name: "WebSearch", input: { query: "Acme" } }] } } as unknown as SDKMessage;
          yield { type: "user", parent_tool_use_id: null, session_id: "s", tool_use_result: { results: [{ title: "Acme", url: "https://acme.test" }] }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "found" }] } } as unknown as SDKMessage;
          yield { type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 3 }, uuid: "r", session_id: "s" } as unknown as SDKMessage;
        }
        return stream();
      },
    } as unknown as Sdk;

    const result = await runTurn(
      {
        model: "claude-sonnet-5-5",
        effort: "high",
        webSearch: true,
        system: "Be Orbit.",
        prompt: "Call Acme",
        tools: [
          { name: "search_records", description: "Search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, write: false },
          { name: "create_task", description: "Create", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, write: true },
        ],
      },
      {
        sdk,
        cwd: "/tmp/orbit-agent-test",
        env: { PATH: "/usr/bin", HOME: "/Users/mark", ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://proxy" },
        callTool: async (call) => {
          calls.push(call.name);
          return { content: '{"companies":[{"name":"Acme"}]}', isError: false };
        },
      },
    );
    const options = seen.options!;
    assert.equal(options.model, "claude-sonnet-5-5");
    assert.equal(options.effort, "high");
    assert.equal(options.systemPrompt, "Be Orbit.");
    assert.deepEqual(options.tools, ["WebSearch"]);
    assert.deepEqual(options.allowedTools, ["mcp__orbit__search_records", "mcp__orbit__create_task", "WebSearch"]);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.strictMcpConfig, true);
    assert.equal(options.permissionMode, "dontAsk");
    assert.equal(options.persistSession, false);
    assert.deepEqual(options.env, { PATH: "/usr/bin", HOME: "/Users/mark", MAX_MCP_OUTPUT_TOKENS: "60000" });
    assert.deepEqual(calls, ["search_records"]);
    assert.deepEqual(result.steps, [
      { text: "Checking.", calls: [{ id: "t1", name: "search_records", arguments: '{"query":"Acme"}' }] },
      { text: "", calls: [{ id: "t2", name: "create_task", arguments: '{"title":"Call Acme"}' }] },
    ]);
    assert.deepEqual(result.results, { t1: { content: '{"companies":[{"name":"Acme"}]}', isError: false } });
    assert.deepEqual(result.sources, [{ url: "https://acme.test", title: "Acme" }]);
    assert.deepEqual(cleanEnv({ ANTHROPIC_API_KEY: "x", KEEP: "y" }), { KEEP: "y" });
  });

  it("passes Claude Code's text to onDraft as it streams, starting afresh for each message", async () => {
    let options: Record<string, unknown> | undefined;
    const sdk = {
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
      query: (input: { options: Record<string, unknown> }) => {
        options = input.options;
        return (async function* () {
          const delta = (text: string, parent: string | null = null) =>
            ({ type: "stream_event", parent_tool_use_id: parent, uuid: "e", session_id: "s", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }) as unknown as SDKMessage;
          yield { type: "stream_event", parent_tool_use_id: null, uuid: "e", session_id: "s", event: { type: "message_start", message: {} } } as unknown as SDKMessage;
          yield delta("Look");
          yield delta("ing.");
          yield delta("ignored", "sub");
          yield { type: "stream_event", parent_tool_use_id: null, uuid: "e", session_id: "s", event: { type: "message_start", message: {} } } as unknown as SDKMessage;
          yield delta("Done");
          yield { type: "assistant", parent_tool_use_id: null, uuid: "u1", session_id: "s", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Done" }] } } as unknown as SDKMessage;
          yield { type: "result", subtype: "success", is_error: false, result: "", usage: {}, uuid: "r", session_id: "s" } as unknown as SDKMessage;
        })();
      },
    } as unknown as Sdk;
    const drafts: string[] = [];
    await runTurn(
      { model: "claude-sonnet-5-5", effort: "low", webSearch: false, system: "", prompt: "Hi", tools: [] },
      { sdk, cwd: "/tmp", env: {}, callTool: async () => ({ content: "", isError: false }), onDraft: (text) => drafts.push(text) },
    );
    assert.equal(options?.includePartialMessages, true);
    assert.deepEqual(drafts, ["Look", "Looking.", "Done"]);
  });

  it("reports Claude Code errors such as usage limits", async () => {
    const sdk = {
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
      query: () =>
        (async function* () {
          yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 6pm", usage: {}, uuid: "r", session_id: "s" } as unknown as SDKMessage;
        })(),
    } as unknown as Sdk;
    await assert.rejects(
      runTurn({ model: "claude-opus-5-5", effort: "low", webSearch: false, system: "", prompt: "Hi", tools: [] }, { sdk, cwd: "/tmp", env: {}, callTool: async () => ({ content: "", isError: false }) }),
      /You've hit your limit/,
    );
  });

  it("ends with a stop message instead of failing when Claude runs out of turns", async () => {
    const sdk = {
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
      query: () =>
        (async function* () {
          yield { type: "assistant", parent_tool_use_id: null, uuid: "u1", session_id: "s", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Looking." }] } } as unknown as SDKMessage;
          yield { type: "result", subtype: "error_max_turns", is_error: true, errors: [], usage: {}, uuid: "r", session_id: "s" } as unknown as SDKMessage;
        })(),
    } as unknown as Sdk;
    const result = await runTurn({ model: "claude-sonnet-5-5", effort: "low", webSearch: false, system: "", prompt: "Hi", tools: [] }, { sdk, cwd: "/tmp", env: {}, callTool: async () => ({ content: "", isError: false }) });
    assert.deepEqual(result.steps, [
      { text: "Looking.", calls: [] },
      { text: STOPPED, calls: [] },
    ]);
    assert.equal(STOPPED, STOPPED_MESSAGE);
  });

  it("converts Orbit's tool schemas for the SDK", () => {
    const shape = shapeFor({
      type: "object",
      properties: {
        title: { type: "string" },
        remindMinutes: { type: "integer", enum: [0, 5, 60] },
        dueAt: { type: "string", description: "When it's due, or null to clear it." },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        ids: { type: "array", items: { type: "string" } },
        attendees: { type: "array", items: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } },
      },
      required: ["title"],
    });
    assert.equal(shape.title.safeParse("Call").success, true);
    assert.equal(shape.title.safeParse(undefined).success, false);
    assert.equal(shape.remindMinutes.safeParse(60).success, true);
    assert.equal(shape.remindMinutes.safeParse(7).success, false);
    assert.equal(shape.remindMinutes.safeParse(undefined).success, true);
    assert.equal(shape.remindMinutes.safeParse(null).success, false);
    assert.equal(shape.dueAt.safeParse(null).success, true);
    assert.equal(shape.priority.safeParse("urgent").success, false);
    assert.equal(shape.attendees.safeParse([{ email: "a@b.c" }]).success, true);
    assert.equal(shape.attendees.safeParse([{ name: "x" }]).success, false);
  });

  it("writes a Mac launch file that starts at login and restarts", () => {
    const plist = launchPlist({ npx: "/opt/homebrew/bin/npx", url: "https://orbit.geteclipse.co", path: "/opt/homebrew/bin:/usr/bin", log: "/Users/m/Library/Logs/orbit-agent.log" });
    assert.ok(plist.includes("<string>co.geteclipse.orbit-agent</string>"));
    assert.ok(plist.includes("<string>--package=https://orbit.geteclipse.co/downloads/orbit-agent.tgz</string>"));
    assert.ok(plist.includes("<key>RunAtLoad</key>\n  <true/>"));
    assert.ok(plist.includes("<key>KeepAlive</key>\n  <true/>"));
    assert.ok(!plist.includes("--pair"));
    assert.ok(launchPath("/opt/homebrew/bin/npx").split(":").includes("/opt/homebrew/bin"));
  });
});
