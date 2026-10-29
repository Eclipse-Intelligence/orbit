import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { decideActions, sendMessage, type AssistantEvent } from "@/lib/assistant/chat";
import { ASSISTANT_TOOLS, describeAction, findTool, recordNames, runTool, toolDefinitions } from "@/lib/assistant/tools";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createFolder } from "@/lib/docs/folders";
import { createDoc, getDoc, listVersions, setAssistantCanEdit } from "@/lib/docs/store";
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
              tool_calls: reply.tool_calls?.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })),
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

function lastActions(events: AssistantEvent[]) {
  return (events.filter((event) => event.type === "actions").at(-1) as Extract<AssistantEvent, { type: "actions" }> | undefined)?.actions ?? [];
}

const deadline = () => Date.now() + 120_000;

let mark: UserActor;
let priya: UserActor;

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@docs-assistant.test", "Mark Ridgeon");
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user('priya@docs-assistant.test', 'password-123', 'Priya Shah') as id")).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  priya = { ...mark, userId: id, email: "priya@docs-assistant.test", fullName: "Priya Shah", role: "member", scopes: scopesForRole("member") };
});

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
});

after(async () => {
  delete process.env.LLM_API_KEY;
  await getPool().end();
  await getAdminPool().end();
});

describe("assistant tools for docs", () => {
  it("stays at 126 tools with save_doc, and still runs forget through remember", async () => {
    assert.equal(ASSISTANT_TOOLS.length, 126);
    const names = ASSISTANT_TOOLS.map((tool) => tool.name);
    assert.ok(names.includes("save_doc"));
    assert.ok(!names.includes("forget"));
    assert.equal(findTool("forget")?.name, "remember");
    assert.equal(findTool("save_doc")?.write, true);
    assert.ok(toolDefinitions().some((tool) => tool.function.name === "save_doc" && /Needs the user's approval/.test(tool.function.description)));
    const saved = (await runTool(mark, "remember", { body: "Mark prefers short notes." })) as { memory: { id: string } };
    assert.deepEqual(describeAction("forget", { memoryId: saved.memory.id, title: "Short notes" }), { title: "Forget a note", lines: ["Short notes"] });
    assert.deepEqual(await runTool(mark, "forget", { memoryId: saved.memory.id }), { forgotten: "Mark prefers short notes." });
    assert.deepEqual(await runTool(mark, "remember", { forgetId: saved.memory.id }), { error: "That memory doesn't exist or was already forgotten.", field: null });
  });

  it("finds docs in search_knowledge and reads them with read_knowledge", async () => {
    delete process.env.LLM_API_KEY;
    const doc = await createDoc(mark, { title: "Acme renewal risk", content: `Acme renews in January. ${"More words. ".repeat(10)}`, shared: true });
    await createDoc(priya, { title: "Acme renewal private to Priya", content: "Acme renews." });
    const found = (await runTool(mark, "search_knowledge", { query: "acme renewal" })) as { notice: string; results: unknown[]; docs: { type: string; docId: string; title: string; href: string }[] };
    assert.ok(found.notice);
    assert.deepEqual(found.docs.map((hit) => [hit.type, hit.title]), [["doc", "Acme renewal risk"]]);
    assert.equal(found.docs[0].href, `/docs/${doc.id}`);
    const without = (await runTool(mark, "search_knowledge", { query: "acme renewal", docs: false })) as { docs: unknown[] };
    assert.deepEqual(without.docs, []);
    const read = (await runTool(mark, "read_knowledge", { docId: doc.id })) as { doc: { title: string; visibility: string }; text: string; nextOffset: number | null };
    assert.equal(read.doc.title, "Acme renewal risk");
    assert.equal(read.doc.visibility, "shared");
    assert.match(read.text, /^Acme renews in January/);
    assert.equal(read.nextOffset, null);
    const byItem = (await runTool(mark, "read_knowledge", { itemId: doc.id })) as { doc: { title: string } };
    assert.equal(byItem.doc.title, "Acme renewal risk");
    const hidden = (await runTool(priya, "read_knowledge", { docId: (await createDoc(mark, { title: "Mark only" })).id })) as { error: string };
    assert.match(hidden.error, /private to someone else/);
  });

  it("shows where a change lands, who sees it and a diff on the card", async () => {
    const folder = await createFolder(mark, { name: "Partnerships", shared: true });
    const doc = await createDoc(mark, { title: "Q4 partner strategy", folderId: folder.id, content: "## Q4 plan\n- [ ] Share pricing\n\n## Risks\nLegal could slip." });
    const args = { action: "edit", docId: doc.id, find: "- [ ] Share pricing", replace: "- [x] Share pricing" };
    const names = await recordNames(mark, [args], ["save_doc"]);
    const card = describeAction("save_doc", args, names);
    assert.equal(card.title, "Edit Q4 partner strategy");
    assert.ok(card.lines.includes("Partnerships, shared with the workspace. Teammates and agents will see this change."));
    assert.ok(card.lines.includes("1 line added, 1 line removed."));
    assert.deepEqual(
      (card as { diff?: { kind: string; text: string }[] }).diff,
      [
        { kind: "same", text: "## Q4 plan" },
        { kind: "remove", text: "- [ ] Share pricing" },
        { kind: "add", text: "- [x] Share pricing" },
        { kind: "same", text: "" },
        { kind: "same", text: "## Risks" },
      ],
    );
    const broken = { action: "edit", docId: doc.id, find: "not there", replace: "x" };
    const brokenCard = describeAction("save_doc", broken, await recordNames(mark, [broken], ["save_doc"]));
    assert.ok(brokenCard.lines.some((line) => /This won't work yet: That text isn't in the doc/.test(line)));
    const created = { action: "create", title: "New plan", content: "Line one", folderId: folder.id };
    const createCard = describeAction("save_doc", created, await recordNames(mark, [created], ["save_doc"]));
    assert.equal(createCard.title, "New doc: New plan");
    assert.deepEqual(createCard.lines, ["In Partnerships.", "Shared with the workspace. Teammates and agents will see it.", "1 line added, 0 lines removed."]);
    const move = { action: "move", docId: doc.id, allowVisibilityChange: true };
    assert.deepEqual(describeAction("save_doc", move, await recordNames(mark, [move], ["save_doc"])).lines, [
      "Out of its folder.",
      "Partnerships, shared with the workspace. Teammates and agents will see this change.",
      "This changes who can see it.",
    ]);
    const daily = { action: "append_daily", content: "Call with Priya" };
    const dailyCard = describeAction("save_doc", daily, await recordNames(mark, [daily], ["save_doc"]));
    assert.equal(dailyCard.title, "Add to today's daily note");
    assert.equal((dailyCard as { diff?: { kind: string }[] }).diff?.[0].kind, "add");
  });

  it("asks before editing, then edits through the save path with versions", async () => {
    const doc = await createDoc(mark, { title: "Needs approval", content: "Old line", shared: true });
    const fake = gateway([
      { content: "I'll change it.", tool_calls: [{ id: "call_doc", name: "save_doc", args: { action: "edit", docId: doc.id, find: "Old line", replace: "New line" } }] },
      { content: "Changed." },
    ]);
    const first = collect();
    await sendMessage(mark, { message: "Change the line", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, first.emit, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    const pending = lastActions(first.events);
    assert.equal(pending[0].status, "pending");
    assert.equal(pending[0].diff?.length, 2);
    assert.equal((await getDoc(mark, doc.id)).content, "Old line");
    const conversationId = (first.events[0] as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
    const second = collect();
    await decideActions(mark, { conversationId, decisions: [{ id: "call_doc", approve: true }] }, second.emit, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(lastActions(second.events)[0].status, "done");
    assert.equal((await getDoc(mark, doc.id)).content, "New line");
    const versions = await listVersions(mark, doc.id);
    assert.deepEqual(versions.map((version) => [version.reason, version.by.editor]), [["edited", "assistant"], ["created", "person"]]);
  });
});

describe("assistant can edit without asking", () => {
  it("runs save_doc edits on a doc that allows it without a card, and carries on", async () => {
    const doc = await createDoc(mark, { title: "Open to the assistant", content: "Draft", shared: true });
    await setAssistantCanEdit(mark, doc.id, true);
    const fake = gateway([
      { content: "Adding it.", tool_calls: [{ id: "call_auto", name: "save_doc", args: { action: "append", docId: doc.id, content: "Added by the assistant" } }] },
      { content: "Added it to the doc." },
    ]);
    const run = collect();
    await sendMessage(mark, { message: "Add a line", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, run.emit, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    const actions = lastActions(run.events);
    assert.equal(actions[0].status, "done");
    assert.equal(actions[0].unattended, true);
    assert.ok(actions[0].lines.includes("Made without asking, because this doc lets the assistant edit it."));
    assert.equal((await getDoc(mark, doc.id)).content, "Draft\n\nAdded by the assistant");
    assert.equal(fake.requests.length, 2);
    const final = run.events.filter((event) => event.type === "message").at(-1) as Extract<AssistantEvent, { type: "message" }>;
    assert.equal(final.message.content, "Added it to the doc.");
    const versions = await listVersions(mark, doc.id);
    assert.deepEqual(versions.map((version) => version.by.editor), ["assistant", "person"]);
  });

  it("never lets the setting cover another doc, another action or another tool", async () => {
    const open = await createDoc(mark, { title: "Open doc", content: "Open", shared: true });
    const closed = await createDoc(mark, { title: "Closed doc", content: "Closed", shared: true });
    await setAssistantCanEdit(mark, open.id, true);
    const fake = gateway([
      {
        tool_calls: [
          { id: "call_other_doc", name: "save_doc", args: { action: "edit", docId: closed.id, find: "Closed", replace: "Changed" } },
          { id: "call_rename", name: "save_doc", args: { action: "rename", docId: open.id, title: "Renamed" } },
          { id: "call_share", name: "save_doc", args: { action: "unshare", docId: open.id } },
          { id: "call_task", name: "create_task", args: { title: "Sneaky task", sendToClickUp: false } },
          { id: "call_ok", name: "save_doc", args: { action: "edit", docId: open.id, find: "Open", replace: "Open and edited" } },
        ],
      },
    ]);
    const run = collect();
    await sendMessage(mark, { message: "Do lots", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, run.emit, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    const statuses = Object.fromEntries(lastActions(run.events).map((action) => [action.id, action.status]));
    assert.deepEqual(statuses, { call_other_doc: "pending", call_rename: "pending", call_share: "pending", call_task: "pending", call_ok: "done" });
    assert.equal((await getDoc(mark, closed.id)).content, "Closed");
    assert.equal((await getDoc(mark, open.id)).title, "Open doc");
    assert.equal((await getDoc(mark, open.id)).content, "Open and edited");

    assert.match(((await runTool(mark, "create_task", { title: "x" }, { unattended: true })) as { error: string }).error, /Only doc edits/);
    assert.match(((await runTool(mark, "forget", { memoryId: closed.id }, { unattended: true })) as { error: string }).error, /Only doc edits/);
    assert.match(((await runTool(mark, "save_doc", { action: "share", docId: open.id }, { unattended: true })) as { error: string }).error, /Only edits to a doc's text/);
    assert.match(((await runTool(mark, "save_doc", { action: "append", docId: closed.id, content: "x" }, { unattended: true })) as { error: string }).error, /isn't allowed to edit this doc without asking/);
    await setAssistantCanEdit(mark, open.id, false);
    assert.match(((await runTool(mark, "save_doc", { action: "append", docId: open.id, content: "x" }, { unattended: true })) as { error: string }).error, /isn't allowed/);
    assert.equal((await getDoc(mark, open.id)).content, "Open and edited");
  });

  it("checks the setting at run time, so turning it off stops the next edit", async () => {
    const doc = await createDoc(mark, { title: "Switched off", content: "Start", shared: true });
    await setAssistantCanEdit(mark, doc.id, true);
    await setAssistantCanEdit(mark, doc.id, false);
    const fake = gateway([{ tool_calls: [{ id: "call_off", name: "save_doc", args: { action: "append", docId: doc.id, content: "More" } }] }]);
    const run = collect();
    await sendMessage(mark, { message: "Add more", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, run.emit, { deadline: deadline(), fetchImpl: fake.fetchImpl });
    assert.equal(lastActions(run.events)[0].status, "pending");
    assert.equal((await getDoc(mark, doc.id)).content, "Start");
    const shared = await createDoc(mark, { title: "Priya's view", content: "x", shared: true });
    await setAssistantCanEdit(priya, shared.id, true);
    assert.equal((await getDoc(mark, shared.id)).assistantCanEdit, true);
  });
});
