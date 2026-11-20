import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { POST as postComplete } from "@/app/api/companion/jobs/[id]/complete/route";
import { applyCompanionResult, getConversation, sendMessage, stopConversation, type AssistantEvent } from "@/lib/assistant/chat";
import {
  EXPIRED_MESSAGE,
  LOST_MESSAGE,
  checkCompanionJob,
  companionBusy,
  enqueueCompanionJob,
  failureReply,
  finishCompanionJob,
  nextCompanionJob,
  readCompanionJob,
  runCompanionTool,
} from "@/lib/companion/jobs";
import { authenticateCompanion, createPairingCode, redeemPairing, type AuthenticatedCompanion } from "@/lib/companion/pairing";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { CompanionRequest, CompanionResult } from "@/companion/src/protocol";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const deadline = () => Date.now() + 60_000;
const request = { model: "claude-haiku-5-5", effort: "low", webSearch: false, system: "", prompt: "Hi", tools: [] } as unknown as CompanionRequest;

function answerOf(text: string): CompanionResult {
  return { steps: [{ text, calls: [] }], results: {}, sources: [], model: null, usage: null };
}

async function pair(owner: UserActor, name: string) {
  const { code } = await createPairingCode(owner);
  const paired = await redeemPairing(code.toLowerCase(), name);
  const auth: AuthenticatedCompanion = await authenticateCompanion(new Request("https://orbit.test/api/companion/me", { headers: { authorization: `Bearer ${paired.token}` } }));
  return { token: paired.token, auth };
}

async function chat(actor: UserActor, title: string) {
  const fetchImpl: typeof fetch = async () =>
    Response.json({ model: "claude-sonnet-5-5", choices: [{ message: { role: "assistant", content: "Hello." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const events: AssistantEvent[] = [];
  await sendMessage(actor, { message: title, model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), { deadline: deadline(), fetchImpl });
  return (events[0] as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
}

async function status(jobId: string) {
  return (await getAdminPool().query<{ status: string }>("select status from crm.ai_companion_jobs where id = $1", [jobId])).rows[0]?.status;
}

async function contents(conversationId: string) {
  return (await getAdminPool().query<{ role: string; content: string }>("select role, content from crm.assistant_messages where conversation_id = $1 order by seq", [conversationId])).rows;
}

async function age(jobId: string, column: "created_at" | "finished_at" | "updated_at", interval: string) {
  const admin = getAdminPool();
  await admin.query("alter table crm.ai_companion_jobs disable trigger ai_companion_jobs_set_updated_at");
  try {
    await admin.query(`update crm.ai_companion_jobs set ${column} = now() - $2::interval where id = $1`, [jobId, interval]);
  } finally {
    await admin.query("alter table crm.ai_companion_jobs enable trigger ai_companion_jobs_set_updated_at");
  }
}

async function clearJobs() {
  await getAdminPool().query("update crm.ai_companion_jobs set status = 'cancelled', finished_at = now() where status in ('queued', 'running')");
}

before(async () => {
  await resetDatabase();
});

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
});

after(async () => {
  await getPool().end();
});

describe("Stop and finishing an Orbit Agent job", () => {
  let owner: UserActor;
  let mac: AuthenticatedCompanion;
  let token = "";

  before(async () => {
    owner = await createUser("stop-finish@orbit.test", "Mark Ridgeon");
    const paired = await pair(owner, "Stop Mac");
    mac = paired.auth;
    token = paired.token;
  });

  useServerlessPool();

  afterEach(clearJobs);

  const complete = (jobId: string, body: unknown) =>
    postComplete(
      new Request(`https://orbit.test/api/companion/jobs/${jobId}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: jobId }) },
    );

  it("cancels the chat's Mac job when you stop, so the Mac is told and a late answer is refused and writes nothing", async () => {
    const id = await chat(owner, "Stop the Mac");
    const job = await enqueueCompanionJob(owner, id, request);
    assert.equal((await nextCompanionJob(mac, 5_000))?.id, job);
    const before = await contents(id);
    await stopConversation(owner, id);
    assert.equal(await status(job), "cancelled");
    assert.equal((await getConversation(owner, id)).working, null);
    await assert.rejects(checkCompanionJob(mac, job), /cancelled/);
    await assert.rejects(runCompanionTool(mac, job, { id: "late", name: "list_tags", arguments: "{}" }), /cancelled/);
    const late = await complete(job, answerOf("Too late."));
    assert.equal(late.status, 409);
    assert.deepEqual(await contents(id), before);
    assert.equal(await status(job), "cancelled");
  });

  it("cancels a job the Mac hasn't picked up yet when you stop", async () => {
    const id = await chat(owner, "Stop before pickup");
    const job = await enqueueCompanionJob(owner, id, request);
    assert.equal((await getConversation(owner, id)).working?.where, "mac");
    await stopConversation(owner, id);
    assert.equal(await status(job), "cancelled");
    assert.equal((await getConversation(owner, id)).working, null);
    assert.equal(await nextCompanionJob(mac, 1_000), null);
  });

  it("shows a job as finished only once its answer is saved", async () => {
    const id = await chat(owner, "Save slowly");
    await getAdminPool().query(
      `insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content, steering, created_at)
       values ($1, $2, $3, 'user', 'Sent while it worked', 'waiting', now() - interval '2 minutes')`,
      [id, owner.workspaceId, owner.userId],
    );
    const waitingConversations = async () =>
      (await getAdminPool().query("select 1 from private.assistant_waiting_conversations(10) where conversation_id = $1", [id])).rowCount;
    assert.equal(await waitingConversations(), 1);
    const job = await enqueueCompanionJob(owner, id, request);
    await nextCompanionJob(mac, 5_000);
    let sawDuring = false;
    await finishCompanionJob(mac, job, async (actor, conversationId) => {
      const mid = await readCompanionJob(owner, job);
      assert.equal(mid.status, "running");
      assert.equal(mid.result, null);
      assert.equal((await getConversation(owner, id)).working?.where, "mac");
      assert.equal(await waitingConversations(), 0);
      await checkCompanionJob(mac, job);
      await assert.rejects(runCompanionTool(mac, job, { id: "late", name: "list_tags", arguments: "{}" }), /cancelled/);
      await assert.rejects(finishCompanionJob(mac, job, async () => []), /cancelled/);
      await companionBusy(owner, "00000000-0000-0000-0000-000000000000");
      assert.equal(await status(job), "running");
      sawDuring = true;
      return applyCompanionResult(actor, conversationId, answerOf("Saved at last."));
    });
    assert.ok(sawDuring);
    const finished = await readCompanionJob(owner, job);
    assert.equal(finished.status, "done");
    assert.equal(finished.result?.messageIds.length, 1);
    assert.equal((await contents(id)).filter((row) => row.content === "Saved at last.").length, 1);
    assert.equal((await getConversation(owner, id)).working, null);
  });

  it("lets an answer that is being saved finish when you stop, without showing the chat as working", async () => {
    const id = await chat(owner, "Stop while saving");
    const job = await enqueueCompanionJob(owner, id, request);
    await nextCompanionJob(mac, 5_000);
    await finishCompanionJob(mac, job, async (actor, conversationId) => {
      await stopConversation(owner, id);
      assert.equal(await status(job), "running");
      assert.equal((await getConversation(owner, id)).working, null);
      return applyCompanionResult(actor, conversationId, answerOf("Saved anyway."));
    });
    assert.equal(await status(job), "done");
    assert.equal((await contents(id)).at(-1)!.content, "Saved anyway.");
  });

  it("saves a failure once and ends the job when the answer can't be saved", async () => {
    const id = await chat(owner, "Failing save");
    const job = await enqueueCompanionJob(owner, id, request);
    await nextCompanionJob(mac, 5_000);
    await assert.rejects(
      finishCompanionJob(mac, job, async () => {
        throw new Error("The database went away.");
      }),
      /database went away/,
    );
    assert.equal(await status(job), "failed");
    assert.deepEqual((await contents(id)).filter((row) => row.content === failureReply("Couldn't save the answer.")).length, 1);
  });

  it("expires a job whose answer was never saved, but not one that is being saved now", async () => {
    const live = await chat(owner, "Saving now");
    const liveJob = await enqueueCompanionJob(owner, live, request);
    await nextCompanionJob(mac, 5_000);
    let during: string | undefined;
    await finishCompanionJob(mac, liveJob, async (actor, conversationId) => {
      await age(liveJob, "updated_at", "10 minutes");
      await companionBusy(owner, "00000000-0000-0000-0000-000000000000");
      during = await status(liveJob);
      return applyCompanionResult(actor, conversationId, answerOf("Still saved."));
    });
    assert.equal(during, "running");
    assert.equal(await status(liveJob), "done");

    const dead = await chat(owner, "Server died while saving");
    const deadJob = await enqueueCompanionJob(owner, dead, request);
    await nextCompanionJob(mac, 5_000);
    await getAdminPool().query("update crm.ai_companion_jobs set finished_at = now() where id = $1", [deadJob]);
    await age(deadJob, "finished_at", "6 minutes");
    await companionBusy(owner, "00000000-0000-0000-0000-000000000000");
    assert.equal(await status(deadJob), "cancelled");
    assert.equal((await contents(dead)).at(-1)!.content, LOST_MESSAGE);
  });
});

describe("A new message and expired jobs", () => {
  let owner: UserActor;
  let mac: AuthenticatedCompanion;

  before(async () => {
    owner = await createUser("stale-order@orbit.test", "Mark Ridgeon");
    mac = (await pair(owner, "Order Mac")).auth;
  });

  useServerlessPool();

  afterEach(clearJobs);

  it("never writes a stale failure after the message you just sent in the same chat", async () => {
    const id = await chat(owner, "Ordering");
    const other = await chat(owner, "Another chat");
    const stale = await enqueueCompanionJob(owner, id, request);
    await age(stale, "created_at", "25 minutes");
    const otherStale = await getAdminPool().query<{ id: string }>(
      `insert into crm.ai_companion_jobs (workspace_id, user_id, conversation_id, request, created_at)
       values ($1, $2, $3, '{}'::jsonb, now() - interval '25 minutes') returning id`,
      [owner.workspaceId, owner.userId, other],
    );
    await getAdminPool().query(
      "insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content) values ($1, $2, $3, 'user', 'My new question')",
      [id, owner.workspaceId, owner.userId],
    );
    const next = await enqueueCompanionJob(owner, id, request);
    assert.equal(await status(stale), "cancelled");
    assert.equal(await status(next), "queued");
    assert.equal(await status(otherStale.rows[0].id), "cancelled");
    const rows = await contents(id);
    assert.equal(rows.at(-1)!.content, "My new question");
    assert.ok(!rows.some((row) => row.content === EXPIRED_MESSAGE || row.content === LOST_MESSAGE));
    assert.equal((await contents(other)).at(-1)!.content, EXPIRED_MESSAGE);
    assert.equal((await nextCompanionJob(mac, 5_000))?.id, next);
  });

  it("never writes a lost-job message after the new message either", async () => {
    const id = await chat(owner, "Ordering running");
    const running = await enqueueCompanionJob(owner, id, request);
    await nextCompanionJob(mac, 5_000);
    await age(running, "updated_at", "10 minutes");
    await getAdminPool().query(
      "insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content) values ($1, $2, $3, 'user', 'Try something else')",
      [id, owner.workspaceId, owner.userId],
    );
    await enqueueCompanionJob(owner, id, request);
    assert.equal(await status(running), "cancelled");
    assert.equal((await contents(id)).at(-1)!.content, "Try something else");
  });
});

describe("Expired jobs in another workspace", () => {
  let eclipse: UserActor;
  let ridgeon: UserActor;

  before(async () => {
    const mark = await createUser("two-workspaces@orbit.test", "Mark Ridgeon");
    eclipse = mark;
    const created = await getAdminPool().query<{ id: string }>("select private.create_workspace($1, 'Mark Ridgeon', null) as id", [mark.userId]);
    ridgeon = { ...mark, workspaceId: created.rows[0].id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    await pair(eclipse, "Workspace Mac");
  });

  useServerlessPool();

  afterEach(clearJobs);

  it("answers the messages left waiting there as that workspace, once the transaction has committed", async () => {
    const elsewhere = await chat(ridgeon, "Ridgeon chat");
    const here = await chat(eclipse, "Eclipse chat");
    await getAdminPool().query("update crm.assistant_conversations set model = 'claude/claude-haiku-5-5' where id = $1", [elsewhere]);
    const stale = await getAdminPool().query<{ id: string }>(
      `insert into crm.ai_companion_jobs (workspace_id, user_id, conversation_id, request, created_at)
       values ($1, $2, $3, '{}'::jsonb, now() - interval '25 minutes') returning id`,
      [ridgeon.workspaceId, ridgeon.userId, elsewhere],
    );
    await getAdminPool().query(
      `insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content, steering)
       values ($1, $2, $3, 'user', 'Left waiting in Ridgeon', 'waiting')`,
      [elsewhere, ridgeon.workspaceId, ridgeon.userId],
    );
    await enqueueCompanionJob(eclipse, here, request);
    assert.equal(await status(stale.rows[0].id), "cancelled");
    let followOn: { workspace_id: string } | undefined;
    for (let tries = 0; tries < 100 && !followOn; tries += 1) {
      followOn = (await getAdminPool().query<{ workspace_id: string }>("select workspace_id from crm.ai_companion_jobs where conversation_id = $1 and status = 'queued'", [elsewhere])).rows[0];
      if (!followOn) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(followOn, "the waiting message gets a follow-on job");
    assert.equal(followOn.workspace_id, ridgeon.workspaceId);
    const rows = await contents(elsewhere);
    assert.ok(rows.some((row) => row.content === EXPIRED_MESSAGE));
    assert.equal((await getAdminPool().query("select steering from crm.assistant_messages where content = 'Left waiting in Ridgeon'")).rows[0].steering, null);
  });
});
