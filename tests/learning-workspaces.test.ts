import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { listMemories, memoryBriefing, recall, rememberNote, updateMemory } from "@/lib/learning/memories";
import { learnNow, runNightlyLearning, sortPersonalMemories } from "@/lib/learning/nightly";
import { createUser, resetDatabase } from "./helpers";

type Call = { kind: string; system: string; user: string };

function reply(content: unknown) {
  return Response.json({ model: "test", choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] });
}

function gateway(answers: { sort?: (user: string) => unknown; personal?: (system: string, user: string) => unknown }) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const [system, user] = body.messages.map((message) => message.content);
    const kind = system.includes("Sort every note") ? "sort" : system.includes("long-term memory") ? "personal" : system.includes("morning brief") ? "brief" : "other";
    calls.push({ kind, system, user });
    if (kind === "sort") return reply(answers.sort?.(user) ?? { notes: [] });
    if (kind === "personal") return reply(answers.personal?.(system, user) ?? { add: [], update: [], archive: [] });
    if (kind === "brief") return reply({ brief: "### What Orbit learned\n- Nothing much." });
    return reply({ add: [], update: [], archive: [] });
  };
  return { fetchImpl, calls };
}

function idOf(user: string, title: string) {
  const match = user.match(new RegExp(`id ([0-9a-f-]{36}) \\[[^\\]]*\\] ${title}`));
  assert.ok(match, `no id for ${title}`);
  return match[1];
}

describe("personal learning across workspaces", () => {
  let eclipse: UserActor;
  let ridgeon: UserActor;

  before(async () => {
    await resetDatabase();
    process.env.LLM_API_KEY = "llm-test";
    eclipse = await createUser("mark@wlp.test", "Mark Ridgeon");
    await getAdminPool().query("update crm.workspaces set name = 'Eclipse' where id = $1", [eclipse.workspaceId]);
    eclipse = { ...eclipse, workspaceName: "Eclipse" };
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
    ridgeon = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
  });

  after(async () => {
    delete process.env.LLM_API_KEY;
    await getPool().end();
    await getAdminPool().end();
  });

  it("shows a personal note where it was learned, and elsewhere only when it applies in all workspaces", async () => {
    const admin = getAdminPool();
    const insert = (title: string, everywhere: boolean | null) =>
      admin.query("insert into crm.memories (workspace_id, user_id, scope, kind, title, body, all_workspaces) values ($1, $2, 'personal', 'fact', $3, $3, $4)", [
        eclipse.workspaceId,
        eclipse.userId,
        title,
        everywhere,
      ]);
    await insert("Eclipse pitch leads with AI visibility", false);
    await insert("Wants first emails under 90 words", true);
    await insert("Andy Horn is an affiliate partner", null);

    const inEclipse = (await listMemories(eclipse, { scope: "personal" })).map((memory) => memory.title).sort();
    assert.deepEqual(inEclipse, ["Andy Horn is an affiliate partner", "Eclipse pitch leads with AI visibility", "Wants first emails under 90 words"]);
    const inRidgeon = await listMemories(ridgeon, { scope: "personal" });
    assert.deepEqual(inRidgeon.map((memory) => memory.title), ["Wants first emails under 90 words"]);
    assert.equal(inRidgeon[0].workspaceName, "Eclipse");
    assert.equal(inRidgeon[0].allWorkspaces, true);

    const briefing = await memoryBriefing(ridgeon);
    assert.match(briefing, /Wants first emails under 90 words/);
    assert.doesNotMatch(briefing, /Eclipse pitch|Andy Horn/);
    assert.deepEqual((await recall(ridgeon, "affiliate partner")).memories, []);
    assert.equal((await recall(eclipse, "affiliate partner")).memories.length, 1);
  });

  it("keeps notes added by hand or by the assistant to this workspace unless the person picks all workspaces", async () => {
    const local = await rememberNote(ridgeon, { body: "Consulting day rate is £1,200." }, "manual");
    assert.equal(local.allWorkspaces, false);
    assert.equal(local.workspaceName, "Mark Ridgeon");
    const shared = await rememberNote(ridgeon, { body: "Signs off with just Mark.", allWorkspaces: true }, "manual");
    assert.equal(shared.allWorkspaces, true);
    const viaAssistant = (await runTool(ridgeon, "remember", { body: "Prefers calls before 11am.", kind: "preference" })) as { memory: { allWorkspaces: boolean } };
    assert.equal(viaAssistant.memory.allWorkspaces, false);
    const titles = (await listMemories(eclipse, { scope: "personal" })).map((memory) => memory.title);
    assert.ok(titles.includes("Signs off with just Mark."));
    assert.ok(!titles.includes("Consulting day rate is £1,200."));

    const moved = await updateMemory(ridgeon, local.id, { allWorkspaces: true });
    assert.equal(moved.allWorkspaces, true);
    assert.ok((await listMemories(eclipse, { scope: "personal" })).some((memory) => memory.id === local.id));
    await updateMemory(eclipse, local.id, { allWorkspaces: false });
    assert.ok(!(await listMemories(eclipse, { scope: "personal" })).some((memory) => memory.id === local.id));

    const business = await rememberNote(ridgeon, { body: "Clients are mostly founders.", shared: true, allWorkspaces: true }, "manual");
    assert.equal(business.allWorkspaces, null);
    assert.ok(!(await listMemories(eclipse, { scope: "business" })).some((memory) => memory.id === business.id));
  });

  it("sorts notes learned before workspaces in one call per person, keeping anything it leaves out to where it was learned", async () => {
    const admin = getAdminPool();
    await admin.query("delete from crm.memories");
    const titles = ["Eclipse ICP is UK agencies", "Writes in UK English", "James O'Toole cofounder trial", "Hates hype words"];
    for (const title of titles) {
      await admin.query("insert into crm.memories (workspace_id, user_id, scope, kind, title, body) values ($1, $2, 'personal', 'fact', $3, $3)", [eclipse.workspaceId, eclipse.userId, title]);
    }
    const { fetchImpl, calls } = gateway({
      sort: (user) => ({
        notes: [
          { id: idOf(user, "Eclipse ICP is UK agencies"), allWorkspaces: false },
          { id: idOf(user, "Writes in UK English"), allWorkspaces: true },
          { id: idOf(user, "Hates hype words"), allWorkspaces: true },
          { id: "00000000-0000-0000-0000-000000000000", allWorkspaces: true },
        ],
      }),
    });
    assert.deepEqual(await sortPersonalMemories(ridgeon, { deadline: Date.now() + 60_000, fetchImpl }), { sorted: 4 });
    assert.equal(calls.length, 1);
    assert.match(calls[0].user, /learned in Eclipse\] Eclipse ICP is UK agencies/);
    assert.match(calls[0].system, /its products, pitch, ICP, clients, partners, people, boards or deals/);
    const rows = await admin.query<{ title: string; all_workspaces: boolean | null }>("select title, all_workspaces from crm.memories order by title");
    assert.deepEqual(Object.fromEntries(rows.rows.map((row) => [row.title, row.all_workspaces])), {
      "Eclipse ICP is UK agencies": false,
      "Hates hype words": true,
      "James O'Toole cofounder trial": false,
      "Writes in UK English": true,
    });
    assert.deepEqual((await listMemories(ridgeon, { scope: "personal" })).map((memory) => memory.title).sort(), ["Hates hype words", "Writes in UK English"]);
    assert.deepEqual(await sortPersonalMemories(eclipse, { deadline: Date.now() + 60_000, fetchImpl }), { sorted: 0 });
    assert.equal(calls.length, 1);
  });

  it("sorts a long backlog in batches of 60, each run carrying on where the last stopped", async () => {
    const admin = getAdminPool();
    await admin.query("delete from crm.memories");
    await admin.query(
      `insert into crm.memories (workspace_id, user_id, scope, kind, title, body, updated_at)
       select $1, $2, 'personal', 'fact', 'Backlog note ' || n, 'Backlog note ' || n, now() - make_interval(mins => n) from generate_series(1, 65) n`,
      [eclipse.workspaceId, eclipse.userId],
    );
    const { fetchImpl, calls } = gateway({ sort: (user) => ({ notes: [...user.matchAll(/id ([0-9a-f-]{36}) /g)].map((match) => ({ id: match[1], allWorkspaces: true })) }) });
    assert.deepEqual(await sortPersonalMemories(eclipse, { deadline: Date.now() + 60_000, fetchImpl }), { sorted: 60 });
    assert.equal((calls[0].user.match(/^- id /gm) ?? []).length, 60);
    assert.deepEqual(await sortPersonalMemories(ridgeon, { deadline: Date.now() + 60_000, fetchImpl }), { sorted: 5 });
    assert.equal((calls[1].user.match(/^- id /gm) ?? []).length, 5);
    const left = await admin.query<{ count: number }>("select count(*)::int as count from crm.memories where all_workspaces is null");
    assert.equal(left.rows[0].count, 0);
    assert.deepEqual(await sortPersonalMemories(eclipse, { deadline: Date.now() + 60_000, fetchImpl }), { sorted: 0 });
    assert.equal(calls.length, 2);
  });

  it("keeps the notes of someone in one workspace to that workspace without a model call", async () => {
    const solo = await createUser("solo@wlp.test", "Solo Person");
    const admin = getAdminPool();
    await admin.query("insert into crm.memories (workspace_id, user_id, scope, kind, title, body) values ($1, $2, 'personal', 'fact', 'Solo note', 'Solo note.')", [solo.workspaceId, solo.userId]);
    const { fetchImpl, calls } = gateway({});
    assert.deepEqual(await sortPersonalMemories(solo, { deadline: Date.now() + 60_000, fetchImpl }), { sorted: 1 });
    assert.equal(calls.length, 0);
    const row = await admin.query<{ all_workspaces: boolean | null }>("select all_workspaces from crm.memories where user_id = $1", [solo.userId]);
    assert.deepEqual(row.rows, [{ all_workspaces: false }]);
  });

  it("runs the personal learner in every workspace from that workspace's own conversations", async () => {
    const admin = getAdminPool();
    await admin.query("delete from crm.memories");
    await admin.query("delete from crm.learning_runs");
    const general = (
      await admin.query<{ id: string }>(
        "insert into crm.memories (workspace_id, user_id, scope, kind, title, body, all_workspaces) values ($1, $2, 'personal', 'writing', 'Keeps emails short', 'Mark keeps emails short.', true) returning id",
        [eclipse.workspaceId, eclipse.userId],
      )
    ).rows[0].id;
    const signOff = (
      await admin.query<{ id: string }>(
        "insert into crm.memories (workspace_id, user_id, scope, kind, title, body, all_workspaces) values ($1, $2, 'personal', 'writing', 'Signs off with Mark', 'Mark signs off with Mark.', true) returning id",
        [eclipse.workspaceId, eclipse.userId],
      )
    ).rows[0].id;
    await admin.query("insert into crm.memories (workspace_id, user_id, scope, kind, title, body) values ($1, $2, 'personal', 'fact', 'Old unsorted note', 'Old unsorted note.')", [
      eclipse.workspaceId,
      eclipse.userId,
    ]);
    const chat = async (actor: UserActor, text: string) => {
      const id = (
        await admin.query<{ id: string }>(
          "insert into crm.assistant_conversations (workspace_id, user_id, title, model, reasoning) values ($1, $2, 'Chat', 'claude-sonnet-5-5', 'medium') returning id",
          [actor.workspaceId, actor.userId],
        )
      ).rows[0].id;
      await admin.query("insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content) values ($1, $2, $3, 'user', $4)", [id, actor.workspaceId, actor.userId, text]);
    };
    await chat(eclipse, "Always mention the Agency Pilot to agencies.");
    await chat(ridgeon, "My consulting clients want a one page proposal.");

    const { fetchImpl, calls } = gateway({
      sort: (user) => ({ notes: [{ id: idOf(user, "Old unsorted note"), allWorkspaces: false }] }),
      personal: (system, user) =>
        system.includes("Mark Ridgeon's CRM")
          ? {
              add: [
                { kind: "preference", title: "Consulting proposals fit on one page", body: "Mark's consulting clients want a one page proposal.", allWorkspaces: false },
                { kind: "writing", title: "Plain words in proposals", body: "Mark wants plain words.", allWorkspaces: true },
              ],
              update: [
                { id: idOf(user, "Keeps emails short"), body: "Mark keeps consulting emails short.", allWorkspaces: false },
                { id: idOf(user, "Signs off with Mark"), body: "Mark signs off with just his first name.", allWorkspaces: true },
              ],
            }
          : { add: [{ kind: "instruction", title: "Mention the Agency Pilot to agencies", body: "Mark wants the Agency Pilot offered to agencies.", allWorkspaces: false }] },
    });
    const run = await runNightlyLearning({ deadline: Date.now() + 600_000, fetchImpl, now: new Date("2026-11-04T02:00:00Z") });
    const personal = run.report.filter((item) => item.kind === "personal" && item.userId === eclipse.userId);
    assert.equal(personal.length, 2);
    assert.deepEqual(personal.map((item) => item.workspaceId).sort(), [eclipse.workspaceId, ridgeon.workspaceId].sort());
    assert.equal(calls.filter((call) => call.kind === "sort").length, 1);
    const prompts = calls.filter((call) => call.kind === "personal");
    assert.equal(prompts.length, 2);
    const ridgeonPrompt = prompts.find((call) => call.system.includes("Mark Ridgeon's CRM"))!;
    assert.match(ridgeonPrompt.user, /one page proposal/);
    assert.doesNotMatch(ridgeonPrompt.user, /Agency Pilot|Old unsorted note/);
    assert.match(ridgeonPrompt.user, /all workspaces, learned in Eclipse\] Keeps emails short/);
    assert.match(ridgeonPrompt.system, /also works in other workspaces \(Eclipse\)/);
    assert.doesNotMatch(prompts.find((call) => call.system.includes("Eclipse's CRM"))!.user, /one page proposal/);

    const inRidgeon = (await listMemories(ridgeon, { scope: "personal" })).map((memory) => memory.title).sort();
    assert.deepEqual(inRidgeon, ["Consulting proposals fit on one page", "Keeps emails short", "Plain words in proposals", "Signs off with Mark"]);
    const inEclipse = (await listMemories(eclipse, { scope: "personal" })).map((memory) => memory.title).sort();
    assert.deepEqual(inEclipse, ["Keeps emails short", "Mention the Agency Pilot to agencies", "Old unsorted note", "Plain words in proposals", "Signs off with Mark"]);
    const kept = (await listMemories(eclipse, { scope: "personal" })).find((memory) => memory.id === general)!;
    assert.equal(kept.body, "Mark keeps emails short.");
    assert.equal(kept.allWorkspaces, false);
    const revised = (await listMemories(ridgeon, { scope: "personal" })).find((memory) => memory.id === signOff)!;
    assert.deepEqual([revised.body, revised.allWorkspaces, revised.workspaceName], ["Mark signs off with just his first name.", true, "Eclipse"]);
    const local = await admin.query<{ body: string; all_workspaces: boolean }>("select body, all_workspaces from crm.memories where workspace_id = $1 and title = 'Keeps emails short'", [ridgeon.workspaceId]);
    assert.deepEqual(local.rows, [{ body: "Mark keeps consulting emails short.", all_workspaces: false }]);

    const again = await runNightlyLearning({ deadline: Date.now() + 600_000, fetchImpl, now: new Date("2026-11-04T02:30:00Z") });
    assert.deepEqual(again.report.filter((item) => item.kind === "personal"), []);
    const quiet = await learnNow(ridgeon, { deadline: Date.now() + 600_000, fetchImpl, kinds: ["personal"] });
    assert.equal(quiet.personal?.skipped, "Nothing new to learn from.");
  });
});
