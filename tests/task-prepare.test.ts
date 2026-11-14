import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pageContext } from "@/lib/assistant/page-context";
import { runTool } from "@/lib/assistant/tools";
import { outsideRead, webGateState } from "@/lib/assistant/web-gate";
import { createActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { createOpportunity, listPipeline } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { taskDetail, type TaskDetail } from "@/lib/crm/task-detail";
import { morningTargets, prepareAllowed, prepareMorningPass, prepareTask, prepareTaskRequest, prepareTasksDueToday, setTaskPrepareSettings, taskPrepareSettings } from "@/lib/crm/task-prepare";
import { taskContext } from "@/lib/crm/task-act";
import { basisFingerprint, isStale } from "@/lib/crm/task-preparation-store";
import { createWorkspace } from "@/lib/crm/workspaces";
import { briefRows, composeFromPreparation, preparable, preparationKind, type TaskPreparation } from "@/lib/crm/task-preparation";
import { addTaskParticipants, createTask, updateTask } from "@/lib/crm/tasks";
import type { Actor, AgentActor, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { startOfDay } from "@/lib/time";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase } from "./helpers";

type Box = { sourceId: string; inbox: string; sent: string };
type Prompt = { url: string; system: string; user: string };

const BRIEF = {
  who: "Head of Operations at Northwind Trading — signs off supplier contracts.",
  lastContact: "Call on 4 Nov about the renewal.",
  stage: "Proposal sent, 48000 GBP.",
  openPoints: ["Wants a three-year price.", "  "],
  talkingPoints: ["Three years with a break at 12 months."],
};
const DRAFT = { subject: "The Halden case study", body: "Hi Jane,\n\nHere is the case study — page 2 has the numbers.\n\nMark" };

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let anna: UserActor;
let agent: AgentActor;
let jane: string;
let renewal: string;
let northwind: string;
let counter = 0;
const savedKey = process.env.LLM_API_KEY;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function mailbox(actor: UserActor): Promise<Box> {
  const connection = await sql<{ id: string }>(
    `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
     values ($1, $2, 'microsoft', $3, 'connected', 'cipher') returning id`,
    [actor.workspaceId, actor.userId, actor.email],
  );
  const sourceId = (
    await sql<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, $4) returning id", [
      actor.workspaceId,
      actor.userId,
      connection[0].id,
      actor.email,
    ])
  )[0].id;
  const folder = async (role: string) =>
    (
      await sql<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, $4, $4, $5) returning id",
        [actor.workspaceId, actor.userId, sourceId, `${role}-${sourceId}`, role],
      )
    )[0].id;
  return { sourceId, inbox: await folder("inbox"), sent: await folder("sent") };
}

async function message(actor: UserActor, box: Box, values: { from: string; to: string[]; subject: string; body: string; at: string; sent?: boolean }) {
  counter += 1;
  await sql(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
       body_text, from_email, to_recipients, cc_recipients, sent_at, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11::jsonb, '[]'::jsonb, $12, $12)`,
    [
      actor.workspaceId,
      actor.userId,
      box.sourceId,
      values.sent ? box.sent : box.inbox,
      `prepare-${counter}`,
      `<prepare-${counter}@mail.test>`,
      `thread-${counter}`,
      values.subject,
      values.body,
      values.from,
      JSON.stringify(values.to.map((address) => ({ name: "", address }))),
      values.at,
    ],
  );
}

function model(reply: (system: string) => unknown, status = 200) {
  const prompts: Prompt[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    prompts.push({ url: String(input), system: body.messages[0].content, user: body.messages[1].content });
    if (status !== 200) return new Response("down", { status });
    return Response.json({ model: "test-model", choices: [{ message: { content: JSON.stringify(reply(body.messages[0].content)) }, finish_reason: "stop" }] });
  };
  return { fetchImpl, prompts };
}

const answer = (system: string) => (system.includes('"talkingPoints"') ? BRIEF : DRAFT);

function londonDay(offset = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(startOfDay(new Date(), "Europe/London", offset));
}

async function mcpCall(actor: Actor, name: string, args: Record<string, unknown>) {
  const server = createCrmMcpServer(actor, actor.type === "user" ? { personal: { tokenId: crypto.randomUUID(), canSend: false } } : {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "task-prepare", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    if (!names.includes(name)) return { names, error: true, text: "" };
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { names, error: Boolean(result.isError), text: result.content[0]?.text ?? "" };
  } finally {
    await client.close();
    await server.close();
  }
}

async function rejects(work: Promise<unknown>, code: string) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && error.code === code);
}

async function visibleRows(actor: Actor) {
  return withActor(actor, async (db) => (await db.query<{ task_id: string; user_id: string }>("select task_id, user_id from crm.task_preparations")).rows);
}

before(async () => {
  process.env.LLM_API_KEY = "test-llm-key";
  await resetDatabase();
  mark = await createUser("mark@prepare.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@prepare.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@prepare.test", "Priya Shah"), "member");
  anna = await join(await createUser("anna@prepare.test", "Anna Admin"), "admin");
  agent = (await createAgent(mark.workspaceId, scopesForRole("owner"), "Prepare agent")).actor;
  northwind = (await createCompany(mark, { name: "Northwind Trading", domain: "northwind-prepare.test" })).body.company.id;
  jane = (
    await createContact(mark, { companyId: northwind, firstName: "Jane", lastName: "Cooper", email: "jane@northwind-prepare.test", phone: "07700 900412", jobTitle: "Head of Operations" })
  ).body.contact.id;
  const stage = (await listPipeline(mark)).stages[0];
  renewal = (await createOpportunity(mark, { companyId: northwind, name: "Northwind renewal 2027", stageId: stage.id, value: 48000, currency: "GBP", primaryContactId: jane })).body.opportunity.id;
  await createActivity(mark, { type: "call", title: "Call with Jane", body: "Wants a three-year price with a break clause.", contactId: jane, occurredAt: "2026-11-04T10:00:00Z" });
  const markBox = await mailbox(mark);
  await message(mark, markBox, { from: "jane@northwind-prepare.test", to: ["mark@prepare.test"], subject: "Case study", body: "Can you send the Halden case study before Friday?", at: "2026-11-05T09:00:00Z" });
  const samBox = await mailbox(sam);
  await message(sam, samBox, { from: "jane@northwind-prepare.test", to: ["sam@prepare.test"], subject: "Private", body: "Sam's private pricing for the pilot.", at: "2026-11-06T09:00:00Z" });
});

after(async () => {
  if (savedKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = savedKey;
  await getPool().end();
  await getAdminPool().end();
});

describe("what can be prepared", () => {
  it("prepares calls and meetings as a brief and emails as a draft, only when something is linked", () => {
    assert.equal(preparationKind("Call Jane about the renewal"), "brief");
    assert.equal(preparationKind("Book a demo with Lucy Hart"), "brief");
    assert.equal(preparationKind("Email Raj the case study"), "draft");
    assert.equal(preparationKind("Tidy the pipeline"), null);
    const linked = { title: "Call Jane", contactId: jane, companyId: null, opportunityId: null };
    assert.equal(preparable(linked), true);
    assert.equal(preparable({ ...linked, contactId: null }), false);
    assert.equal(preparable({ ...linked, title: "Tidy the notes" }), false);
  });

  it("opens a draft in compose as a new email to the person, with no way to send it from here", () => {
    const opened = composeFromPreparation({ to: [{ address: "Jane@Northwind.test", name: "Jane Cooper" }], subject: "Hello", body: "Hi Jane" });
    assert.deepEqual(opened, { to: [{ address: "jane@northwind.test", name: "Jane Cooper" }], subject: "Hello", body: "Hi Jane" });
    assert.deepEqual(Object.keys(opened).sort(), ["body", "subject", "to"]);
  });

  it("lists a brief's rows in the order of the approved card and drops empty ones", () => {
    const rows = briefRows({ who: "Head of Operations.", lastContact: "", stage: null, openPoints: ["Price"], talkingPoints: [] });
    assert.deepEqual(rows.map((row) => row.label), ["Who", "Open from last call"]);
  });
});

describe("preparing on demand", () => {
  it("builds a call brief from the task, the shared records and the viewer's own mail, never inventing a format", async () => {
    const id = (await createTask(mark, { title: "Call Jane Cooper about the renewal", ownerId: mark.userId, contactId: jane, opportunityId: renewal, dueDate: londonDay() })).body.task.id;
    const { fetchImpl, prompts } = model(answer);
    const prepared = await prepareTask(mark, id, { fetchImpl });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].url, /\/chat\/completions$/);
    assert.match(prompts[0].system, /Never invent facts/);
    assert.match(prompts[0].user, /Wants a three-year price with a break clause\./);
    assert.match(prompts[0].user, /Can you send the Halden case study before Friday\?/);
    assert.match(prompts[0].user, /Northwind renewal 2027/);
    assert.doesNotMatch(prompts[0].user, /Sam's private pricing/);
    assert.equal(prepared.kind, "brief");
    assert.equal(prepared.draft, null);
    assert.equal(prepared.automatic, false);
    assert.equal(prepared.stale, false);
    assert.deepEqual(prepared.brief, {
      who: "Head of Operations at Northwind Trading, signs off supplier contracts.",
      lastContact: "Call on 4 Nov about the renewal.",
      stage: "Proposal sent, 48000 GBP.",
      openPoints: ["Wants a three-year price."],
      talkingPoints: ["Three years with a break at 12 months."],
    });
    const detail = await taskDetail(mark, id);
    assert.deepEqual(detail.preparation?.brief, prepared.brief);
    assert.equal(detail.preparation?.stale, false);
    assert.equal(detail.preparation?.builtFrom?.contact?.id, jane);
    assert.equal(detail.preparation?.builtFrom?.lastEmailAt, "2026-11-05T09:00:00.000Z");
  });

  it("writes an email draft to the person and sends nothing", async () => {
    const id = (await createTask(mark, { title: "Email Jane Cooper the case study", ownerId: mark.userId, contactId: jane })).body.task.id;
    const before = await sql<{ drafts: number; messages: number }>(
      "select (select count(*)::int from crm.mail_drafts) as drafts, (select count(*)::int from crm.mail_messages) as messages",
    );
    const { fetchImpl, prompts } = model(answer);
    const prepared = await prepareTask(mark, id, { fetchImpl });
    assert.equal(prompts.length, 1);
    assert.ok(prompts.every((prompt) => prompt.url.endsWith("/chat/completions")));
    assert.match(prompts[0].system, /sign-off with "Mark"/);
    assert.match(prompts[0].system, /Never invent prices, dates, availability, attachments or promises/);
    assert.equal(prepared.kind, "draft");
    assert.equal(prepared.brief, null);
    assert.deepEqual(prepared.draft, {
      to: [{ address: "jane@northwind-prepare.test", name: "Jane Cooper" }],
      subject: "The Halden case study",
      body: "Hi Jane,\n\nHere is the case study, page 2 has the numbers.\n\nMark",
    });
    const afterwards = await sql<{ drafts: number; messages: number }>(
      "select (select count(*)::int from crm.mail_drafts) as drafts, (select count(*)::int from crm.mail_messages) as messages",
    );
    assert.deepEqual(afterwards, before);
    assert.deepEqual(composeFromPreparation(prepared.draft!), { to: prepared.draft!.to, subject: "The Halden case study", body: prepared.draft!.body });
  });

  it("refuses a to do, an unlinked task, a done task, and works without calling the model when AI isn't set up", async () => {
    const { fetchImpl, prompts } = model(answer);
    const todo = (await createTask(mark, { title: "Tidy the pipeline", ownerId: mark.userId, contactId: jane })).body.task.id;
    await rejects(prepareTask(mark, todo, { fetchImpl }), "invalid_input");
    const unlinked = (await createTask(mark, { title: "Call the bank", ownerId: mark.userId, companyId: null, contactId: null, opportunityId: null })).body.task.id;
    await rejects(prepareTask(mark, unlinked, { fetchImpl }), "invalid_input");
    const done = (await createTask(mark, { title: "Call Jane Cooper again", ownerId: mark.userId, contactId: jane })).body.task.id;
    await updateTask(mark, done, { completed: true });
    await rejects(prepareTask(mark, done, { fetchImpl }), "invalid_input");
    await rejects(prepareTask(mark, crypto.randomUUID(), { fetchImpl }), "not_found");
    process.env.LLM_API_KEY = "";
    try {
      await rejects(prepareTask(mark, done, { fetchImpl }), "unavailable");
    } finally {
      process.env.LLM_API_KEY = "test-llm-key";
    }
    assert.equal(prompts.length, 0);
  });
});

describe("who sees a preparation", () => {
  let shared: string;

  before(async () => {
    shared = (await createTask(mark, { title: "Call Jane Cooper about onboarding", ownerId: sam.userId, contactId: jane })).body.task.id;
    await addTaskParticipants(mark, shared, [priya.userId]);
    await prepareTask(sam, shared, { fetchImpl: model(answer).fetchImpl });
  });

  it("shows it only to the person who prepared it: never the creator, a tagged person or an admin", async () => {
    assert.ok((await taskDetail(sam, shared)).preparation);
    for (const viewer of [mark, priya, anna]) {
      const detail = await taskDetail(viewer, shared);
      assert.equal(detail.task.id, shared);
      assert.equal(detail.preparation, null, viewer.email);
      assert.deepEqual(await visibleRows(viewer).then((rows) => rows.filter((row) => row.task_id === shared)), [], viewer.email);
    }
    await prepareTask(priya, shared, { fetchImpl: model(answer).fetchImpl });
    assert.equal((await taskDetail(priya, shared)).preparation?.kind, "brief");
    const own = await visibleRows(priya);
    assert.ok(own.every((row) => row.user_id === priya.userId));
    assert.equal((await sql("select 1 from crm.task_preparations where task_id = $1", [shared])).length, 2);
  });

  it("refuses writing or changing someone else's preparation", async () => {
    await assert.rejects(
      withActor(mark, (db) =>
        db.query(
          "insert into crm.task_preparations (task_id, user_id, workspace_id, kind, state, content, prepared_at) values ($1, $2, $3, 'brief', 'ready', '{}'::jsonb, now())",
          [shared, sam.userId, mark.workspaceId],
        ),
      ),
      /row-level security/,
    );
    const changed = await withActor(anna, (db) => db.query("update crm.task_preparations set content = '{}'::jsonb where task_id = $1", [shared]));
    assert.equal(changed.rowCount, 0);
    const removed = await withActor(mark, (db) => db.query("delete from crm.task_preparations where task_id = $1", [shared]));
    assert.equal(removed.rowCount, 0);
  });

  it("gives an agent token none, and refuses it the table", async () => {
    const detail = await taskDetail(agent, shared);
    assert.equal(detail.preparation, null);
    assert.equal(detail.mail, null);
    await assert.rejects(withActor(agent, (db) => db.query("select * from crm.task_preparations")), /permission denied/);
    const asAgent = await mcpCall(agent, "get_next_action", { id: shared });
    assert.equal(asAgent.error, false);
    assert.equal((JSON.parse(asAgent.text) as TaskDetail).preparation, null);
    assert.ok(!asAgent.names.includes("prepare_next_action"));
  });
});

describe("a preparation goes out of date", () => {
  it("is marked stale when the task or its records change, and fresh again once prepared", async () => {
    const id = (await createTask(mark, { title: "Call Jane Cooper about pricing", ownerId: mark.userId, contactId: jane })).body.task.id;
    await prepareTask(mark, id, { fetchImpl: model(answer).fetchImpl });
    assert.equal((await taskDetail(mark, id)).preparation?.stale, false);
    await updateTask(mark, id, { priority: "high" });
    assert.equal((await taskDetail(mark, id)).preparation?.stale, false);
    await updateTask(mark, id, { dueDate: londonDay(3) });
    assert.equal((await taskDetail(mark, id)).preparation?.stale, true);
    await prepareTask(mark, id, { fetchImpl: model(answer).fetchImpl });
    await sql("update crm.contacts set notes = 'Prefers calls after 4pm.' where id = $1", [jane]);
    assert.equal((await taskDetail(mark, id)).preparation?.stale, true);
    await prepareTask(mark, id, { fetchImpl: model(answer).fetchImpl });
    await sql("update crm.opportunities set probability = 70, expected_close_date = '2026-12-31' where id = $1", [renewal]);
    assert.equal((await taskDetail(mark, id)).preparation?.stale, true);
    await prepareTask(mark, id, { fetchImpl: model(answer).fetchImpl });
    assert.equal((await taskDetail(mark, id)).preparation?.stale, false);
    await createActivity(mark, { type: "meeting", title: "Lunch with Jane", contactId: jane, occurredAt: new Date(Date.now() - 60_000).toISOString() });
    const stale = (await taskDetail(mark, id)).preparation;
    assert.equal(stale?.stale, true);
    assert.ok(stale?.builtFrom?.lastActivity);
    await prepareTask(mark, id, { fetchImpl: model(answer).fetchImpl });
    assert.equal((await taskDetail(mark, id)).preparation?.stale, false);
    await updateTask(mark, id, { title: "Call Jane Cooper about the price rise" });
    assert.equal((await taskDetail(mark, id)).preparation?.stale, true);
  });
});

describe("the assistant and MCP read the viewer's own preparation", () => {
  it("puts it in the tagged task block, list_tasks and get_next_action, marked as outside content", async () => {
    const id = (await createTask(mark, { title: "Call Jane Cooper about the board", ownerId: mark.userId, contactId: jane })).body.task.id;
    const quiet = await pageContext(mark, null, { taggedTaskIds: [id] });
    assert.doesNotMatch(quiet, /The user's own preparation/);
    await prepareTask(mark, id, { fetchImpl: model(answer).fetchImpl });
    const block = await pageContext(mark, null, { taggedTaskIds: [id] });
    assert.match(block, /\nThe user's own preparation for it, a call brief \(prepared [^)]*up to date, only the user sees it\): who "Head of Operations at Northwind Trading, signs off supplier contracts\."/);
    assert.match(block, /open from the last call: "Wants a three-year price\."/);
    assert.equal(webGateState([{ role: "user", content: "Hi", page_context: block }]).outside, true);
    assert.doesNotMatch(await pageContext(sam, null, { taggedTaskIds: [id] }).catch(() => ""), /The user's own preparation/);

    const listed = (await runTool(mark, "list_tasks", { taskId: id })) as TaskDetail;
    assert.equal(listed.preparation?.kind, "brief");
    assert.equal(outsideRead("list_tasks", JSON.stringify(listed)), true);

    const personal = await mcpCall(mark, "get_next_action", { id });
    assert.equal(personal.error, false);
    assert.equal((JSON.parse(personal.text) as TaskDetail).preparation?.brief?.who, BRIEF.who.replace(" — ", ", "));
  });

  it("lets a personal token prepare a task over MCP, and sends nothing", async () => {
    const id = (await createTask(mark, { title: "Email Jane Cooper the onboarding plan", ownerId: mark.userId, contactId: jane })).body.task.id;
    const { fetchImpl, prompts } = model(answer);
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await mcpCall(mark, "prepare_next_action", { id });
      assert.ok(result.names.includes("prepare_next_action"));
      assert.equal(result.error, false, result.text);
      const body = JSON.parse(result.text) as { preparation: TaskPreparation };
      assert.equal(body.preparation.kind, "draft");
      assert.equal(body.preparation.draft?.to[0]?.address, "jane@northwind-prepare.test");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(prompts.length, 1);
    assert.equal((await taskDetail(mark, id)).preparation?.kind, "draft");
  });
});

describe("preparing each morning", () => {
  let olivia: UserActor;
  let theo: UserActor;
  let person: string;
  const at = (hour: number, minutes = 0) => new Date(startOfDay(new Date(), "Europe/London").getTime() + hour * 3_600_000 + minutes * 60_000);
  const soon = () => Date.now() + 120_000;

  async function task(owner: UserActor, title: string, day: string, contactId: string | null = person) {
    return (await createTask(olivia, { title, ownerId: owner.userId, contactId, dueDate: day, ...(contactId ? {} : { companyId: null, opportunityId: null }) })).body.task.id;
  }

  before(async () => {
    olivia = await createUser("olivia@morning.test", "Olivia Morning");
    const created = await createUser("theo@morning.test", "Theo Teammate");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [olivia.workspaceId, created.userId]);
    theo = { ...created, workspaceId: olivia.workspaceId, workspaceName: olivia.workspaceName, role: "member", scopes: scopesForRole("member") };
    person = (await createContact(olivia, { firstName: "Raj", lastName: "Mehta", email: "raj@kestrel-morning.test" })).body.contact.id;
  });

  it("prepares only the owner's call, meeting and email tasks due today, once", async () => {
    const call = await task(olivia, "Call Raj Mehta about the pilot", londonDay());
    const email = await task(olivia, "Email Raj Mehta the case study", londonDay());
    const tomorrow = await task(olivia, "Call Raj Mehta about invoices", londonDay(1));
    const theirs = await task(theo, "Call Raj Mehta for Theo", londonDay());
    const todo = await task(olivia, "Tidy the Raj Mehta notes", londonDay());
    const unlinked = await task(olivia, "Call the bank", londonDay(), null);
    const { fetchImpl, prompts } = model(answer);
    const report = await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl, now: at(10) });
    assert.deepEqual(report, { prepared: 2, fresh: 0, failed: 0 });
    assert.equal(prompts.length, 2);
    const rows = await sql<{ task_id: string; kind: string; automatic: boolean; user_id: string }>(
      "select task_id, kind, automatic, user_id from crm.task_preparations where task_id = any($1::uuid[]) order by kind",
      [[call, email, tomorrow, theirs, todo, unlinked]],
    );
    assert.deepEqual(rows, [
      { task_id: call, kind: "brief", automatic: true, user_id: olivia.userId },
      { task_id: email, kind: "draft", automatic: true, user_id: olivia.userId },
    ]);
    assert.equal((await taskDetail(theo, theirs)).preparation, null);

    const again = model(answer);
    assert.deepEqual(await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl: again.fetchImpl, now: at(10, 5) }), { prepared: 0, fresh: 0, failed: 0 });
    assert.equal(again.prompts.length, 0);
  });

  it("checks a preparation from an earlier day, keeps it when nothing changed and redoes it when it went stale", async () => {
    const kept = await task(olivia, "Call Raj Mehta about the renewal", londonDay());
    const changed = await task(olivia, "Call Raj Mehta about the contract", londonDay());
    const early = model(answer);
    await prepareTask(olivia, kept, { fetchImpl: early.fetchImpl });
    await prepareTask(olivia, changed, { fetchImpl: early.fetchImpl });
    await sql("update crm.task_preparations set checked_at = now() - interval '2 days' where task_id = any($1::uuid[])", [[kept, changed]]);
    await updateTask(olivia, changed, { title: "Call Raj Mehta about the new contract" });
    const { fetchImpl, prompts } = model(answer);
    const report = await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl, now: at(10, 10) });
    assert.deepEqual(report, { prepared: 1, fresh: 1, failed: 0 });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].user, /new contract/);
    assert.equal((await taskDetail(olivia, changed)).preparation?.stale, false);
  });

  it("does nothing before the morning, with the setting off, without AI, or without time left", async () => {
    await task(olivia, "Call Raj Mehta about the deck", londonDay());
    const { fetchImpl, prompts } = model(answer);
    const none = { prepared: 0, fresh: 0, failed: 0 };
    assert.deepEqual(await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl, now: at(5) }), none);
    assert.deepEqual(await prepareTasksDueToday(olivia, { deadline: Date.now() + 10_000, fetchImpl, now: at(10) }), none);
    assert.deepEqual((await setTaskPrepareSettings(olivia, { prepareEachMorning: false })).prepareEachMorning, false);
    assert.deepEqual(await taskPrepareSettings(olivia), { prepareEachMorning: false });
    assert.deepEqual(await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl, now: at(10) }), none);
    await setTaskPrepareSettings(olivia, { prepareEachMorning: true });
    process.env.LLM_API_KEY = "";
    try {
      assert.deepEqual(await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl, now: at(10) }), none);
    } finally {
      process.env.LLM_API_KEY = "test-llm-key";
    }
    await rejects(setTaskPrepareSettings(olivia, { prepareEachMorning: "yes" }), "invalid_input");
    assert.equal(prompts.length, 0);
    assert.deepEqual(await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl, now: at(10) }), { prepared: 1, fresh: 0, failed: 0 });
  });

  it("stops after a failure, waits before trying again, and gives up after three tries in a day", async () => {
    const id = await task(olivia, "Call Raj Mehta about the outage", londonDay());
    const failing = model(answer, 500);
    assert.deepEqual(await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl: failing.fetchImpl, now: at(11) }), { prepared: 0, fresh: 0, failed: 1 });
    const failed = await sql<{ state: string; failures: number }>("select state, failures from crm.task_preparations where task_id = $1", [id]);
    assert.deepEqual(failed, [{ state: "failed", failures: 1 }]);
    assert.equal((await taskDetail(olivia, id)).preparation, null);
    const quiet = model(answer, 500);
    assert.deepEqual(await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl: quiet.fetchImpl, now: at(11, 5) }), { prepared: 0, fresh: 0, failed: 0 });
    assert.equal(quiet.prompts.length, 0);
    assert.equal((await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl: failing.fetchImpl, now: at(11, 31) })).failed, 1);
    assert.equal((await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl: failing.fetchImpl, now: at(12, 2) })).failed, 1);
    assert.deepEqual(await sql("select failures from crm.task_preparations where task_id = $1", [id]), [{ failures: 3 }]);
    const done = model(answer);
    assert.equal((await prepareTasksDueToday(olivia, { deadline: soon(), fetchImpl: done.fetchImpl, now: at(13) })).failed, 0);
    assert.equal(done.prompts.length, 0);
  });
});

describe("a preparation follows its task", () => {
  it("moves with the task to another workspace, dropping people who aren't in it, and the morning run still works there", async () => {
    const created = await createWorkspace(mark, { name: "Prepare second" });
    const second: UserActor = { ...mark, workspaceId: created.id, workspaceName: "Prepare second" };
    const elsewhere = (await createContact(second, { firstName: "Lucy", lastName: "Hart", email: "lucy@brightwell-prepare.test" })).body.contact.id;
    const id = (await createTask(mark, { title: "Call Jane Cooper about the move", ownerId: mark.userId, contactId: jane, dueDate: londonDay() })).body.task.id;
    await addTaskParticipants(mark, id, [sam.userId]);
    await prepareTask(mark, id, { fetchImpl: model(answer).fetchImpl });
    await prepareTask(sam, id, { fetchImpl: model(answer).fetchImpl });
    await sql("update crm.tasks set workspace_id = $2, contact_id = $3, company_id = null, opportunity_id = null where id = $1", [id, second.workspaceId, elsewhere]);
    assert.deepEqual(await sql("select user_id, workspace_id from crm.task_preparations where task_id = $1", [id]), [{ user_id: mark.userId, workspace_id: second.workspaceId }]);
    await sql("update crm.task_preparations set checked_at = now() - interval '2 days' where task_id = $1", [id]);
    const at10 = new Date(startOfDay(new Date(), "Europe/London").getTime() + 10 * 3_600_000);
    const { fetchImpl, prompts } = model(answer);
    const report = await prepareTasksDueToday(mark, { deadline: Date.now() + 120_000, fetchImpl, now: at10, actors: [mark, second] });
    assert.equal(report.failed, 0);
    assert.ok(report.prepared >= 1);
    assert.ok(prompts.some((prompt) => prompt.user.includes("Lucy Hart")));
    assert.equal((await taskDetail(second, id)).preparation?.stale, false);
  });

  it("drops the old assignee's preparation when the task is reassigned, and keeps everyone else's", async () => {
    const id = (await createTask(mark, { title: "Call Jane Cooper about the handover", ownerId: sam.userId, contactId: jane })).body.task.id;
    await prepareTask(sam, id, { fetchImpl: model(answer).fetchImpl });
    await prepareTask(mark, id, { fetchImpl: model(answer).fetchImpl });
    await updateTask(mark, id, { ownerId: priya.userId });
    assert.deepEqual(await sql("select user_id from crm.task_preparations where task_id = $1", [id]), [{ user_id: mark.userId }]);
    assert.equal((await taskDetail(priya, id)).preparation, null);
  });
});

describe("guards around preparing", () => {
  it("refuses a second Prepare of the same task while one started in the last minute", async () => {
    const id = (await createTask(mark, { title: "Call Jane Cooper about the guard", ownerId: mark.userId, contactId: jane })).body.task.id;
    await sql(
      "insert into crm.task_preparations (task_id, user_id, workspace_id, kind, state, started_at, checked_at) values ($1, $2, $3, 'brief', 'pending', now(), '-infinity')",
      [id, mark.userId, mark.workspaceId],
    );
    const { fetchImpl, prompts } = model(answer);
    await rejects(prepareTask(mark, id, { fetchImpl }), "conflict");
    assert.equal(prompts.length, 0);
    await sql("update crm.task_preparations set started_at = now() - interval '61 seconds' where task_id = $1", [id]);
    assert.equal((await prepareTask(mark, id, { fetchImpl })).kind, "brief");
    assert.deepEqual(await sql("select state, started_at from crm.task_preparations where task_id = $1", [id]), [{ state: "ready", started_at: null }]);
    const failing = model(answer, 500);
    await assert.rejects(prepareTask(mark, id, { fetchImpl: failing.fetchImpl }));
    assert.deepEqual(await sql("select state, started_at from crm.task_preparations where task_id = $1", [id]), [{ state: "ready", started_at: null }]);
  });

  it("says nothing about email when there is no address to look up, and says so when the mailbox has none", async () => {
    const quiet = (await createContact(mark, { firstName: "Noel", lastName: "Noemail", phone: "07700 900999" })).body.contact.id;
    const silent = (await createContact(mark, { firstName: "Esme", lastName: "Unwritten", email: "esme@unwritten-prepare.test" })).body.contact.id;
    const first = (await createTask(mark, { title: "Call Noel Noemail", ownerId: mark.userId, contactId: quiet })).body.task.id;
    const second = (await createTask(mark, { title: "Call Esme Unwritten", ownerId: mark.userId, contactId: silent })).body.task.id;
    const { fetchImpl, prompts } = model(answer);
    await prepareTask(mark, first, { fetchImpl });
    await prepareTask(mark, second, { fetchImpl });
    assert.doesNotMatch(prompts[0].user, /emails with them/);
    assert.match(prompts[1].user, /Mark has no emails with them in their mailbox\./);
  });

  it("keeps a preparation fresh when the email lookup timed out", () => {
    const basis = {
      title: "Call Jane",
      description: null,
      dueDate: null,
      contact: null,
      company: null,
      opportunity: null,
      lastActivity: null,
      lastEmailAt: "2026-11-05T09:00:00.000Z",
      threadLatest: null,
    };
    const stored = { fingerprint: basisFingerprint(basis), basis };
    assert.equal(isStale(stored, { basis: { ...basis, lastEmailAt: null }, emailKnown: false }), false);
    assert.equal(isStale(stored, { basis: { ...basis, lastEmailAt: null }, emailKnown: true }), true);
  });

  it("returns the viewer's own preparation with the task's context, so opening a row reads the task once", async () => {
    const id = (await createTask(mark, { title: "Call Jane Cooper about context", ownerId: mark.userId, contactId: jane })).body.task.id;
    assert.equal((await taskContext(mark, id)).preparation, null);
    await prepareTask(mark, id, { fetchImpl: model(answer).fetchImpl });
    const context = await taskContext(mark, id);
    assert.equal(context.preparation?.kind, "brief");
    assert.equal(context.preparation?.stale, false);
    assert.equal((await taskContext(sam, id).catch(() => null))?.preparation ?? null, null);
  });

  it("prepares a meeting as a meeting brief, end to end", async () => {
    const id = (await createTask(mark, { title: "Book a demo with Jane Cooper", ownerId: mark.userId, contactId: jane })).body.task.id;
    const { fetchImpl, prompts } = model(answer);
    const prepared = await prepareTask(mark, id, { fetchImpl });
    assert.equal(prepared.kind, "brief");
    assert.match(prompts[0].system, /about to meet someone/);
    assert.deepEqual(briefRows(prepared.brief!, true).map((row) => row.label), ["Who", "Last contact", "Stage", "Open from last meeting", "Talking points"]);
    assert.match(await pageContext(mark, null, { taggedTaskIds: [id] }), /The user's own preparation for it, a meeting brief/);
  });
});

describe("the prepare route and MCP limits", () => {
  it("answers 401, 404, 429, 502 and 200", async () => {
    const id = (await createTask(mark, { title: "Call Jane Cooper about the route", ownerId: mark.userId, contactId: jane })).body.task.id;
    assert.equal((await prepareTaskRequest(null, { taskId: id })).status, 401);
    assert.equal((await prepareTaskRequest(mark, { taskId: "nope" })).status, 404);
    assert.equal((await prepareTaskRequest(mark, { taskId: crypto.randomUUID() })).status, 404);
    const failing = await prepareTaskRequest(mark, { taskId: id }, { fetchImpl: model(answer, 500).fetchImpl });
    assert.equal(failing.status, 502);
    assert.match(String(failing.body.error), /Try again/);
    const done = await prepareTaskRequest(mark, { taskId: id }, { fetchImpl: model(answer).fetchImpl });
    assert.equal(done.status, 200);
    assert.equal(done.body.preparation?.kind, "brief");
    const busy = await createUser("busy@prepare.test", "Bea Busy");
    const own = (await createTask(busy, { title: "Call the bank about fees", ownerId: busy.userId, companyId: null, contactId: null, opportunityId: null })).body.task.id;
    for (let index = 0; index < 30; index += 1) await prepareAllowed(busy);
    assert.equal((await prepareTaskRequest(busy, { taskId: own })).status, 429);
    const limited = await mcpCall(busy, "prepare_next_action", { id: own });
    assert.equal(limited.error, true);
    assert.match(limited.text, /^rate_limited:/);
  });
});

describe("the morning pass covers everyone", () => {
  it("includes people with no mailbox or calendar and more than 50 other tasks due today", async () => {
    const solo = await createUser("solo@morning.test", "Sol Solo");
    const person = (await createContact(solo, { firstName: "Tara", lastName: "Tasks", email: "tara@morning-solo.test" })).body.contact.id;
    for (let index = 0; index < 55; index += 1) {
      await createTask(solo, { title: `Tidy note ${index} for Tara Tasks`, ownerId: solo.userId, contactId: person, dueDate: londonDay() });
    }
    const call = (await createTask(solo, { title: "Call Tara Tasks about the plan", ownerId: solo.userId, contactId: person, dueAt: `${londonDay()}T23:30` })).body.task.id;
    const targets = (await morningTargets()).filter((target) => target.actor.userId === solo.userId);
    assert.equal(targets.length, 1);
    assert.deepEqual(targets[0].actors.map((actor) => actor.workspaceId), [solo.workspaceId]);
    const at10 = new Date(startOfDay(new Date(), "Europe/London").getTime() + 10 * 3_600_000);
    const { fetchImpl, prompts } = model(answer);
    const report = await prepareMorningPass({ deadline: Date.now() + 120_000, fetchImpl, now: at10, targets });
    assert.deepEqual(report, { prepared: 1, fresh: 0, failed: 0 });
    assert.equal(prompts.length, 1);
    assert.equal((await taskDetail(solo, call)).preparation?.automatic, true);
  });
});
