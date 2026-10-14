import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  clearClickUpCache,
  clickupClient,
  signClickUpWebhook,
  verifyClickUpSignature,
  type ClickUpTask,
} from "@/lib/clickup";
import {
  createTaskWithClickUp,
  enableClickUpWebhook,
  fromClickUpDue,
  getClickUpPicker,
  getClickUpSettings,
  handleClickUpWebhook,
  processClickUpEvent,
  pushClickUpTask,
  saveClickUpSettings,
  syncClickUp,
  toClickUpDue,
} from "@/lib/crm/clickup";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { syncTargets } from "@/lib/crm/scheduler";
import { completeTask, getTask, updateTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

const TOKEN = "pk_101_TESTTOKEN";
const SITE = "https://orbit.example.com";
const TEAM = "90121919133";

type Status = { status: string; type: string; orderindex: number };

type FakeList = {
  id: string;
  name: string;
  spaceId: string;
  folderId: string | null;
  statuses: Status[];
  fields: { id: string; name: string; type: string }[];
};

type Fake = {
  lists: Map<string, FakeList>;
  tasks: Map<string, ClickUpTask>;
  webhooks: Map<string, { id: string; endpoint: string; secret: string; space_id: number | null; list_id: number | null }>;
  requests: { method: string; path: string; body: unknown }[];
  failCreate: number;
  rateLimited: number;
  next: number;
};

const RELATIONSHIP_STATUSES: Status[] = [
  { status: "to do", type: "open", orderindex: 0 },
  { status: "waiting", type: "custom", orderindex: 1 },
  { status: "done", type: "closed", orderindex: 2 },
];

const ZEUS_STATUSES: Status[] = [
  { status: "closed", type: "closed", orderindex: 4 },
  { status: "backlog", type: "open", orderindex: 0 },
  { status: "in progress", type: "custom", orderindex: 1 },
  { status: "complete", type: "done", orderindex: 2 },
];

function makeFake(): Fake {
  const lists = new Map<string, FakeList>();
  lists.set("901223313517", {
    id: "901223313517",
    name: "Relationships",
    spaceId: "90128661245",
    folderId: null,
    statuses: RELATIONSHIP_STATUSES,
    fields: [{ id: "742d5d9b-4160-4647-8b24-b005923c51b6", name: "Orbit", type: "short_text" }],
  });
  lists.set("901219828897", {
    id: "901219828897",
    name: "Zeus",
    spaceId: "90128511222",
    folderId: null,
    statuses: ZEUS_STATUSES,
    fields: [{ id: "crm-field", name: "crm", type: "url" }],
  });
  lists.set("901219833963", {
    id: "901219833963",
    name: "Todoist",
    spaceId: "90128492395",
    folderId: "inbox-folder",
    statuses: RELATIONSHIP_STATUSES,
    fields: [],
  });
  return {
    lists,
    tasks: new Map(),
    webhooks: new Map(),
    requests: [],
    failCreate: 0,
    rateLimited: 0,
    next: 1,
  };
}

const SPACES = [
  { id: "90128661245", name: "Eclipse" },
  { id: "90128511222", name: "Zeus" },
  { id: "90128492395", name: "Triage" },
];

function statusOf(list: FakeList, name: string) {
  const found = list.statuses.find((status) => status.status === name);
  return found ? { status: found.status, type: found.type } : { status: list.statuses[0].status, type: list.statuses[0].type };
}

function clickup(fake: Fake) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    assert.equal(url.origin, "https://api.clickup.com");
    assert.equal(new Headers(init?.headers).get("authorization"), TOKEN);
    const path = url.pathname.replace(/^\/api\/v2/, "");
    fake.requests.push({ method, path: `${path}${url.search}`, body });
    if (fake.rateLimited > 0) {
      fake.rateLimited -= 1;
      return Response.json(
        { err: "Rate limit reached", ECODE: "APP_002" },
        { status: 429, headers: { "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 2) } },
      );
    }
    if (path === "/user") return Response.json({ user: { id: 101, username: "Mark Ridgeon", email: "mark@orbit.test" } });
    if (path === "/team") return Response.json({ teams: [{ id: TEAM, name: "Mark's Workspace" }] });
    let match = /^\/team\/(\d+)\/space$/.exec(path);
    if (match) return Response.json({ spaces: SPACES });
    match = /^\/space\/(\d+)\/folder$/.exec(path);
    if (match) {
      const spaceId = match[1];
      const folders = spaceId === "90128492395" ? [{ id: "inbox-folder", name: "Inbox", hidden: false, lists: [] }] : [];
      return Response.json({ folders });
    }
    match = /^\/space\/(\d+)\/list$/.exec(path);
    if (match) {
      const spaceId = match[1];
      return Response.json({
        lists: [...fake.lists.values()]
          .filter((list) => list.spaceId === spaceId && !list.folderId)
          .map((list) => ({ id: list.id, name: list.name })),
      });
    }
    match = /^\/folder\/([^/]+)\/list$/.exec(path);
    if (match) {
      const folderId = match[1];
      return Response.json({
        lists: [...fake.lists.values()]
          .filter((list) => list.folderId === folderId)
          .map((list) => ({ id: list.id, name: list.name })),
      });
    }
    match = /^\/list\/(\d+)$/.exec(path);
    if (match) {
      const list = fake.lists.get(match[1]);
      if (!list) return Response.json({ err: "List not found", ECODE: "ITEM_013" }, { status: 404 });
      return Response.json({ id: list.id, name: list.name, statuses: list.statuses, space: { id: list.spaceId } });
    }
    match = /^\/list\/(\d+)\/field$/.exec(path);
    if (match) return Response.json({ fields: fake.lists.get(match[1])?.fields ?? [] });
    match = /^\/list\/(\d+)\/task$/.exec(path);
    if (match && method === "POST") {
      if (fake.failCreate > 0) {
        fake.failCreate -= 1;
        return Response.json({ err: "Internal error", ECODE: "ITEM_500" }, { status: 500 });
      }
      const list = fake.lists.get(match[1])!;
      const id = `cu${fake.next++}`;
      const task: ClickUpTask = {
        id,
        name: body.name,
        description: body.description ?? "",
        text_content: body.description ?? "",
        status: statusOf(list, body.status ?? list.statuses[0].status),
        date_updated: String(Date.now()),
        due_date: body.due_date === undefined || body.due_date === null ? null : String(body.due_date),
        url: `https://app.clickup.com/t/${id}`,
        list: { id: list.id },
        custom_fields: list.fields.map((field) => ({ ...field })),
      };
      fake.tasks.set(id, task);
      return Response.json(task);
    }
    match = /^\/task\/([^/]+)\/field\/([^/]+)$/.exec(path);
    if (match && method === "POST") {
      const task = fake.tasks.get(match[1]);
      const field = task?.custom_fields?.find((item) => item.id === match![2]);
      if (!task || !field) return Response.json({ err: "Field not found" }, { status: 400 });
      field.value = body.value;
      return Response.json({});
    }
    match = /^\/task\/([^/]+)$/.exec(path);
    if (match) {
      const task = fake.tasks.get(match[1]);
      if (!task) return Response.json({ err: "Task not found, deleted", ECODE: "ITEM_013" }, { status: 404 });
      if (method === "PUT") {
        const list = fake.lists.get(task.list!.id)!;
        if (body.name !== undefined) task.name = body.name;
        if (body.due_date !== undefined) task.due_date = body.due_date === null ? null : String(body.due_date);
        if (body.status !== undefined) task.status = statusOf(list, body.status);
        task.date_updated = String(Date.now());
      }
      return Response.json(task);
    }
    match = /^\/team\/(\d+)\/task$/.exec(path);
    if (match) {
      const ids = url.searchParams.getAll("list_ids[]");
      const since = Number(url.searchParams.get("date_updated_gt") ?? 0);
      const page = Number(url.searchParams.get("page") ?? 0);
      assert.equal(url.searchParams.get("include_closed"), "true");
      const all = [...fake.tasks.values()].filter(
        (task) => ids.includes(task.list!.id) && Number(task.date_updated) > since,
      );
      const slice = all.slice(page * 2, page * 2 + 2);
      return Response.json({ tasks: slice, last_page: page * 2 + 2 >= all.length });
    }
    match = /^\/team\/(\d+)\/webhook$/.exec(path);
    if (match && method === "POST") {
      const id = `wh-${fake.next++}`;
      const hook = {
        id,
        endpoint: body.endpoint,
        secret: `secret-${id}`,
        space_id: body.space_id ?? null,
        list_id: body.list_id ?? null,
      };
      fake.webhooks.set(id, hook);
      return Response.json({ id, webhook: { ...hook, events: body.events, health: { status: "active", fail_count: 0 } } });
    }
    if (match) return Response.json({ webhooks: [...fake.webhooks.values()] });
    match = /^\/webhook\/([^/]+)$/.exec(path);
    if (match && method === "DELETE") {
      fake.webhooks.delete(match[1]);
      return Response.json({});
    }
    return Response.json({ err: `Unexpected ${method} ${path}` }, { status: 500 });
  };
  return fetchImpl;
}

function remoteTask(fake: Fake, input: Partial<ClickUpTask> & { id: string; listId: string; orbit?: string }) {
  const list = fake.lists.get(input.listId)!;
  const task: ClickUpTask = {
    name: "Remote task",
    description: "",
    text_content: "",
    status: statusOf(list, list.statuses[0].status),
    date_updated: String(Date.now()),
    due_date: null,
    url: `https://app.clickup.com/t/${input.id}`,
    list: { id: list.id },
    custom_fields: list.fields.map((field) =>
      input.orbit !== undefined ? { ...field, value: input.orbit } : { ...field },
    ),
    ...input,
  };
  fake.tasks.set(input.id, task);
  return task;
}

async function taskRow(id: string) {
  const result = await getAdminPool().query<{
    clickup_task_id: string | null;
    clickup_list_id: string | null;
    clickup_url: string | null;
    clickup_error: string | null;
    clickup_sync: Record<string, unknown>;
    archived_at: Date | null;
    updated_at: Date;
  }>(
    `select clickup_task_id, clickup_list_id, clickup_url, clickup_error, clickup_sync, archived_at, updated_at
     from crm.tasks where id = $1`,
    [id],
  );
  return result.rows[0];
}

async function importedTask(workspaceId: string, clickupTaskId: string) {
  const result = await getAdminPool().query<{
    id: string;
    title: string;
    due_at: Date | null;
    completed_at: Date | null;
    archived_at: Date | null;
    contact_id: string | null;
    company_id: string | null;
  }>(
    `select id, title, due_at, completed_at, archived_at, contact_id, company_id
     from crm.tasks where workspace_id = $1 and clickup_task_id = $2`,
    [workspaceId, clickupTaskId],
  );
  return result.rows[0] ?? null;
}

function puts(fake: Fake, taskId: string) {
  return fake.requests.filter((item) => item.method === "PUT" && item.path === `/task/${taskId}`);
}

before(async () => {
  await resetDatabase();
});

beforeEach(() => {
  clearClickUpCache();
  process.env.CLICKUP_API_TOKEN = TOKEN;
  process.env.SITE_URL = SITE;
  delete process.env.CLICKUP_API_BASE_URL;
});

after(async () => {
  delete process.env.CLICKUP_API_TOKEN;
  delete process.env.SITE_URL;
  await getPool().end();
});

describe("clickup client", () => {
  it("converts London due dates both ways", () => {
    assert.deepEqual(toClickUpDue("2026-11-03T14:30:00.000Z"), { due_date: Date.UTC(2026, 10, 3, 14, 30), due_date_time: true });
    assert.deepEqual(toClickUpDue(new Date(Date.UTC(2026, 5, 30, 23, 0)).toISOString()), {
      due_date: Date.UTC(2026, 5, 30, 23, 0),
      due_date_time: false,
    });
    assert.deepEqual(toClickUpDue(null), { due_date: null, due_date_time: false });
    assert.equal(
      fromClickUpDue({ due_date: String(Date.UTC(2026, 6, 1, 3, 0)) }),
      new Date(Date.UTC(2026, 5, 30, 23, 0)).toISOString(),
    );
    assert.equal(
      fromClickUpDue({ due_date: String(Date.UTC(2026, 6, 1, 13, 15)) }),
      new Date(Date.UTC(2026, 6, 1, 13, 15)).toISOString(),
    );
    assert.equal(
      fromClickUpDue({ due_date: String(Date.UTC(2026, 6, 1, 13, 15)), due_date_time: false }),
      new Date(Date.UTC(2026, 5, 30, 23, 0)).toISOString(),
    );
    assert.equal(fromClickUpDue({ due_date: null }), null);
  });

  it("verifies hex HMAC signatures in constant time", () => {
    const body = JSON.stringify({ event: "taskUpdated", task_id: "abc" });
    const signature = signClickUpWebhook("s3cret", body);
    assert.equal(verifyClickUpSignature("s3cret", body, signature), true);
    assert.equal(verifyClickUpSignature("s3cret", body, signature.toUpperCase()), true);
    assert.equal(verifyClickUpSignature("other", body, signature), false);
    assert.equal(verifyClickUpSignature("s3cret", `${body} `, signature), false);
    assert.equal(verifyClickUpSignature("s3cret", body, "abc"), false);
    assert.equal(verifyClickUpSignature("s3cret", body, null), false);
  });

  it("waits for the rate limit reset and gives up near the deadline", async () => {
    const fake = makeFake();
    fake.rateLimited = 1;
    const sleeps: number[] = [];
    const api = clickupClient({
      token: TOKEN,
      fetchImpl: clickup(fake),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const user = await api.getUser();
    assert.equal(user.id, 101);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 1_000 && sleeps[0] <= 15_000);
    fake.rateLimited = 1;
    const short = clickupClient({
      token: TOKEN,
      fetchImpl: clickup(fake),
      sleep: async () => assert.fail("should not sleep past the deadline"),
      deadline: Date.now() + 2_500,
    });
    await assert.rejects(short.getUser(), /rate limiting/);
  });
});

describe("clickup sync", () => {
  let owner: UserActor;
  let acmeId: string;
  let globexId: string;
  let janeId: string;
  let bobId: string;
  const fake = makeFake();
  const fetchImpl = clickup(fake);
  const RELATIONSHIPS = "901223313517";
  const ZEUS = "901219828897";
  const TODOIST = "901219833963";

  before(async () => {
    owner = await createUser("mark@orbit.test", "Mark Ridgeon");
    acmeId = (await createCompany(owner, { name: "Acme", domain: "acme.com" })).body.company.id;
    globexId = (await createCompany(owner, { name: "Globex", domain: "globex.com" })).body.company.id;
    janeId = (
      await createContact(owner, { companyId: acmeId, firstName: "Jane", lastName: "Doe", email: "jane@acme.com" })
    ).body.contact.id;
    bobId = (
      await createContact(owner, { companyId: globexId, firstName: "Bob", lastName: "Stone", email: "bob@globex.com" })
    ).body.contact.id;
  });

  it("validates settings against the token's workspace and lists", async () => {
    assert.equal(await getClickUpPicker(owner), null);
    const view = await getClickUpSettings(owner, { fetchImpl });
    assert.equal(view.configured, true);
    assert.equal(view.teamId, TEAM);
    assert.deepEqual(view.user, { username: "Mark Ridgeon", email: "mark@orbit.test" });
    assert.deepEqual(
      view.lists.map((list) => [list.id, list.spaceName, list.folderName]),
      [
        [RELATIONSHIPS, "Eclipse", null],
        [ZEUS, "Zeus", null],
        [TODOIST, "Triage", "Inbox"],
      ],
    );
    await assert.rejects(
      saveClickUpSettings(owner, { teamId: "123", defaultListId: null, watchedListIds: [] }, { fetchImpl }),
      /workspace this token can see/,
    );
    await assert.rejects(
      saveClickUpSettings(owner, { teamId: TEAM, defaultListId: null, watchedListIds: [RELATIONSHIPS, "999"] }, { fetchImpl }),
      /Choose lists from the selected ClickUp workspace/,
    );
    await assert.rejects(
      saveClickUpSettings(owner, { teamId: TEAM, defaultListId: "999", watchedListIds: [] }, { fetchImpl }),
      /default list/,
    );
    const member = { ...owner, role: "member" as const, scopes: owner.scopes.filter((scope) => scope !== "admin") };
    await assert.rejects(
      saveClickUpSettings(member, { teamId: TEAM, defaultListId: RELATIONSHIPS, watchedListIds: [] }, { fetchImpl }),
    );
    await assert.rejects(
      createTaskWithClickUp(owner, { title: "Too early", contactId: janeId }, RELATIONSHIPS, { fetchImpl }),
      /Choose a ClickUp workspace/,
    );
    const saved = await saveClickUpSettings(
      owner,
      { teamId: TEAM, defaultListId: RELATIONSHIPS, watchedListIds: [RELATIONSHIPS, ZEUS, ZEUS] },
      { fetchImpl },
    );
    assert.deepEqual(saved.watchedListIds, [RELATIONSHIPS, ZEUS]);
    const picker = await getClickUpPicker(owner);
    assert.equal(picker?.listId, RELATIONSHIPS);
    assert.equal(picker?.lists.length, 3);
    await assert.rejects(
      createTaskWithClickUp(owner, { title: "Wrong list", contactId: janeId }, "999", { fetchImpl }),
      /Choose a ClickUp list/,
    );
  });

  it("creates the ClickUp task when an Orbit task is added", async () => {
    const created = await createTaskWithClickUp(
      owner,
      { title: "Send the proposal", description: "Pricing v2", contactId: janeId, dueAt: "2026-11-03T14:30" },
      RELATIONSHIPS,
      { fetchImpl },
    );
    assert.equal(created.clickupError, null);
    const row = await taskRow(created.task.id);
    assert.ok(row.clickup_task_id);
    assert.equal(row.clickup_list_id, RELATIONSHIPS);
    assert.equal(row.clickup_url, `https://app.clickup.com/t/${row.clickup_task_id}`);
    const post = fake.requests.find((item) => item.method === "POST" && item.path === `/list/${RELATIONSHIPS}/task`);
    const body = post?.body as Record<string, unknown>;
    assert.equal(body.name, "Send the proposal");
    assert.equal(body.due_date, Date.UTC(2026, 10, 3, 14, 30));
    assert.equal(body.due_date_time, true);
    assert.deepEqual(body.assignees, [101]);
    assert.match(String(body.description), /^Pricing v2\n\nContact: Jane Doe\nCompany: Acme\nOrbit: https:\/\/orbit\.example\.com\/contacts\//);
    assert.ok(String(body.description).includes(`${SITE}/contacts/${janeId}`));
    const remote = fake.tasks.get(row.clickup_task_id!)!;
    assert.equal(remote.custom_fields?.[0].value, `${SITE}/contacts/${janeId}`);

    const summer = await createTaskWithClickUp(
      owner,
      { title: "Check in with Globex", companyId: globexId, dueAt: "2026-07-01" },
      ZEUS,
      { fetchImpl },
    );
    const summerRow = await taskRow(summer.task.id);
    const zeusPost = fake.requests.filter((item) => item.method === "POST" && item.path === `/list/${ZEUS}/task`).at(-1);
    assert.equal((zeusPost?.body as Record<string, unknown>).due_date, Date.UTC(2026, 5, 30, 23, 0));
    assert.equal((zeusPost?.body as Record<string, unknown>).due_date_time, false);
    assert.match(String((zeusPost?.body as Record<string, unknown>).description), /Company: Globex\nOrbit: https:\/\/orbit\.example\.com\/companies\//);
    assert.equal(fake.tasks.get(summerRow.clickup_task_id!)?.custom_fields?.[0].value, `${SITE}/companies/${globexId}`);
    assert.equal((await getClickUpPicker(owner))?.listId, ZEUS);

    const local = await createTaskWithClickUp(owner, { title: "Orbit only", companyId: acmeId }, null, { fetchImpl });
    assert.equal((await taskRow(local.task.id)).clickup_list_id, null);
  });

  it("maps completion and reopening to the list's statuses", async () => {
    const created = await createTaskWithClickUp(owner, { title: "Close the loop", contactId: bobId }, RELATIONSHIPS, { fetchImpl });
    const id = created.task.id;
    const remoteId = (await taskRow(id)).clickup_task_id!;
    await completeTask(owner, id);
    assert.equal(await pushClickUpTask(owner, id, { fetchImpl }), "pushed");
    assert.deepEqual(puts(fake, remoteId).at(-1)?.body, { status: "done" });
    assert.equal(fake.tasks.get(remoteId)?.status?.type, "closed");
    await updateTask(owner, id, { completed: false });
    await pushClickUpTask(owner, id, { fetchImpl });
    assert.deepEqual(puts(fake, remoteId).at(-1)?.body, { status: "to do" });
    assert.equal(await pushClickUpTask(owner, id, { fetchImpl }), "unchanged");

    const zeus = await createTaskWithClickUp(owner, { title: "Zeus follow-up", companyId: globexId }, ZEUS, { fetchImpl });
    const zeusRemote = (await taskRow(zeus.task.id)).clickup_task_id!;
    await completeTask(owner, zeus.task.id);
    await pushClickUpTask(owner, zeus.task.id, { fetchImpl });
    assert.deepEqual(puts(fake, zeusRemote).at(-1)?.body, { status: "complete" });
    await updateTask(owner, zeus.task.id, { completed: false, title: "Zeus follow-up call", dueAt: null });
    await pushClickUpTask(owner, zeus.task.id, { fetchImpl });
    assert.deepEqual(puts(fake, zeusRemote).at(-1)?.body, {
      name: "Zeus follow-up call",
      status: "backlog",
    });
  });

  it("links watched ClickUp tasks to contacts and companies when polling", async () => {
    const twoDaysAgo = String(Date.now() - 2 * 24 * 60 * 60 * 1000);
    remoteTask(fake, { id: "byemail", listId: RELATIONSHIPS, name: "Intro call", orbit: "Jane@Acme.com", due_date: String(Date.UTC(2026, 6, 1, 3, 0)) });
    remoteTask(fake, { id: "bydomain", listId: ZEUS, name: "Renewal", orbit: "https://www.globex.com/" });
    remoteTask(fake, { id: "byurl", listId: RELATIONSHIPS, name: "Board pack", orbit: `${SITE}/companies/${acmeId}` });
    remoteTask(fake, {
      id: "bydescurl",
      listId: ZEUS,
      name: "Send deck",
      text_content: `Context: https://orbit.example.com/contacts/${bobId} please`,
    });
    remoteTask(fake, {
      id: "bydescemail",
      listId: RELATIONSHIPS,
      name: "Reply to Bob",
      markdown_description: "From mark@orbit.test: email **bob@globex.com** back",
      status: { status: "done", type: "closed" },
    });
    remoteTask(fake, { id: "nolink", listId: RELATIONSHIPS, name: "Buy milk", text_content: "nobody@nowhere.example" });
    remoteTask(fake, { id: "unwatched", listId: TODOIST, name: "Todoist item", text_content: "jane@acme.com" });
    remoteTask(fake, { id: "stale", listId: RELATIONSHIPS, name: "Old", orbit: "jane@acme.com", date_updated: String(Date.now() - 30 * 24 * 60 * 60 * 1000) });
    const result = await syncClickUp({ actor: owner, force: true, fetchImpl });
    assert.equal(result.error, undefined);
    assert.equal(result.imported, 5);
    assert.equal(result.complete, true);
    const email = await importedTask(owner.workspaceId, "byemail");
    assert.equal(email?.title, "Intro call");
    assert.equal(email?.contact_id, janeId);
    assert.equal(email?.company_id, acmeId);
    assert.equal(email?.due_at?.toISOString(), new Date(Date.UTC(2026, 5, 30, 23, 0)).toISOString());
    assert.equal((await importedTask(owner.workspaceId, "bydomain"))?.company_id, globexId);
    const byUrl = await importedTask(owner.workspaceId, "byurl");
    assert.equal(byUrl?.company_id, acmeId);
    assert.equal(byUrl?.contact_id, null);
    assert.equal((await importedTask(owner.workspaceId, "bydescurl"))?.contact_id, bobId);
    const byDescEmail = await importedTask(owner.workspaceId, "bydescemail");
    assert.equal(byDescEmail?.contact_id, bobId);
    assert.ok(byDescEmail?.completed_at);
    assert.equal(await importedTask(owner.workspaceId, "nolink"), null);
    assert.equal(await importedTask(owner.workspaceId, "unwatched"), null);
    assert.equal(await importedTask(owner.workspaceId, "stale"), null);
    const pages = fake.requests.filter((item) => item.path.startsWith(`/team/${TEAM}/task`));
    assert.ok(pages.length >= 3);
    assert.ok(Number(new URL(`https://x${pages[0].path}`).searchParams.get("date_updated_gt")) < Number(twoDaysAgo));
    const task = await getTask(owner, email!.id);
    assert.equal(task.clickupUrl, "https://app.clickup.com/t/byemail");

    const again = await syncClickUp({ actor: owner, force: true, fetchImpl });
    assert.equal(again.imported, 0);
    assert.equal(again.updated, 0);
  });

  it("applies ClickUp edits, keeps newer Orbit edits, and ignores its own echoes", async () => {
    const before = await importedTask(owner.workspaceId, "byemail");
    const remote = fake.tasks.get("byemail")!;
    remote.name = "Intro call (moved)";
    remote.due_date = String(Date.UTC(2026, 6, 8, 9, 30));
    remote.date_updated = String(Date.now() + 1_000);
    const synced = await syncClickUp({ actor: owner, force: true, fetchImpl });
    assert.equal(synced.updated, 1);
    const after = await importedTask(owner.workspaceId, "byemail");
    assert.equal(after?.title, "Intro call (moved)");
    assert.equal(after?.due_at?.toISOString(), new Date(Date.UTC(2026, 6, 8, 9, 30)).toISOString());
    assert.equal(before?.id, after?.id);
    assert.equal(puts(fake, "byemail").length, 0);

    await updateTask(owner, after!.id, { title: "Intro call with Jane" });
    assert.equal(await pushClickUpTask(owner, after!.id, { fetchImpl }), "pushed");
    assert.equal(remote.name, "Intro call with Jane");
    const audits = await getAdminPool().query("select count(*)::int as total from crm.audit_events where entity_id = $1", [after!.id]);
    const echoed = await syncClickUp({ actor: owner, force: true, fetchImpl });
    assert.equal(echoed.updated, 0);
    assert.equal(echoed.pushed, 0);
    const auditsAfter = await getAdminPool().query("select count(*)::int as total from crm.audit_events where entity_id = $1", [after!.id]);
    assert.equal(auditsAfter.rows[0].total, audits.rows[0].total);
    assert.equal(puts(fake, "byemail").length, 1);

    const requestsBefore = fake.requests.length;
    const pushedAt = Number((await taskRow(after!.id)).clickup_sync.pushedAt);
    const echo = await processClickUpEvent(owner, { event: "taskUpdated", taskId: "byemail", newestAt: pushedAt + 500 }, { fetchImpl });
    assert.equal(echo, "echo");
    assert.equal(fake.requests.length, requestsBefore);

    remote.name = "Older ClickUp rename";
    remote.date_updated = String(Date.now() - 60_000);
    await updateTask(owner, after!.id, { title: "Newest Orbit title" });
    const raced = await syncClickUp({ actor: owner, force: true, fetchImpl });
    assert.equal(raced.updated, 0);
    assert.equal(raced.pushed, 1);
    assert.equal((await importedTask(owner.workspaceId, "byemail"))?.title, "Newest Orbit title");
    assert.equal(remote.name, "Newest Orbit title");
  });

  it("archives the Orbit task when the ClickUp task is deleted", async () => {
    const linked = await importedTask(owner.workspaceId, "bydomain");
    fake.tasks.delete("bydomain");
    const outcome = await processClickUpEvent(owner, { event: "taskDeleted", taskId: "bydomain", newestAt: null }, { fetchImpl });
    assert.equal(outcome, "archived");
    assert.ok((await importedTask(owner.workspaceId, "bydomain"))?.archived_at);
    assert.equal(await processClickUpEvent(owner, { event: "taskDeleted", taskId: "never-linked", newestAt: null }, { fetchImpl }), "ignored");
    const audit = await getAdminPool().query<{ event_type: string; source: string }>(
      "select event_type, source from crm.audit_events where entity_id = $1 order by created_at desc limit 1",
      [linked!.id],
    );
    assert.deepEqual(audit.rows[0], { event_type: "task.archived", source: "clickup" });

    const verify = await importedTask(owner.workspaceId, "byurl");
    fake.tasks.delete("byurl");
    await getAdminPool().query("update crm.tasks set clickup_synced_at = now() - interval '7 hours' where id = $1", [verify!.id]);
    const result = await syncClickUp({ actor: owner, force: true, fetchImpl });
    assert.equal(result.archived, 1);
    assert.ok((await importedTask(owner.workspaceId, "byurl"))?.archived_at);

    const archivedOrbit = await createTaskWithClickUp(owner, { title: "Archive me", contactId: janeId }, RELATIONSHIPS, { fetchImpl });
    const remoteId = (await taskRow(archivedOrbit.task.id)).clickup_task_id!;
    await getAdminPool().query("update crm.tasks set archived_at = now() where id = $1", [archivedOrbit.task.id]);
    await syncClickUp({ actor: owner, force: true, fetchImpl });
    assert.ok(fake.tasks.has(remoteId));
  });

  it("records a failed push without blocking the Orbit task and retries it", async () => {
    fake.failCreate = 1;
    const created = await createTaskWithClickUp(owner, { title: "Flaky push", contactId: janeId }, RELATIONSHIPS, { fetchImpl });
    assert.match(created.clickupError ?? "", /ClickUp returned 500/);
    const failed = await taskRow(created.task.id);
    assert.equal(failed.clickup_task_id, null);
    assert.equal(failed.clickup_list_id, RELATIONSHIPS);
    assert.match(failed.clickup_error ?? "", /500/);
    assert.equal((await getTask(owner, created.task.id)).clickupError, failed.clickup_error);
    const retried = await syncClickUp({ actor: owner, force: true, fetchImpl });
    assert.equal(retried.pushed, 1);
    const fixed = await taskRow(created.task.id);
    assert.ok(fixed.clickup_task_id);
    assert.equal(fixed.clickup_error, null);
    const poll = await syncClickUp({ actor: owner, force: true, fetchImpl });
    assert.equal(poll.imported, 0);
    const copies = await getAdminPool().query("select count(*)::int as total from crm.tasks where title = 'Flaky push'");
    assert.equal(copies.rows[0].total, 1);
  });

  it("verifies webhook signatures before any work and ignores replays", async () => {
    delete process.env.SITE_URL;
    await assert.rejects(enableClickUpWebhook(owner, "http://localhost:4173", { fetchImpl }), /SITE_URL/);
    process.env.SITE_URL = SITE;
    const enabled = await enableClickUpWebhook(owner, "http://localhost:4173", { fetchImpl });
    assert.equal(enabled.enabled, true);
    const hook = [...fake.webhooks.values()][0];
    assert.equal(hook.endpoint, `${SITE}/api/clickup/webhook`);
    assert.equal(hook.space_id, null);
    assert.equal(hook.list_id, null);
    const stored = await getAdminPool().query<{ webhook_secret: string; webhook_scope: string }>(
      "select webhook_secret, webhook_scope from crm.integration_state where workspace_id = $1 and source = 'clickup'",
      [owner.workspaceId],
    );
    assert.notEqual(stored.rows[0].webhook_secret, hook.secret);
    assert.equal(stored.rows[0].webhook_scope, "team");

    await saveClickUpSettings(owner, { teamId: TEAM, defaultListId: RELATIONSHIPS, watchedListIds: [RELATIONSHIPS] }, { fetchImpl });
    const scoped = [...fake.webhooks.values()];
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].list_id, Number(RELATIONSHIPS));
    await saveClickUpSettings(owner, { teamId: TEAM, defaultListId: RELATIONSHIPS, watchedListIds: [RELATIONSHIPS, ZEUS] }, { fetchImpl });
    const secret = [...fake.webhooks.values()][0].secret;

    remoteTask(fake, { id: "hooked", listId: RELATIONSHIPS, name: "From webhook", orbit: "bob@globex.com" });
    const body = JSON.stringify({
      event: "taskCreated",
      task_id: "hooked",
      webhook_id: [...fake.webhooks.values()][0].id,
      history_items: [{ id: "h1", date: String(Date.now()), field: "task_creation" }],
    });
    const scheduled: (() => Promise<unknown>)[] = [];
    const schedule = (task: () => Promise<unknown>) => {
      scheduled.push(task);
    };
    const send = (signature: string | null, payload = body) =>
      handleClickUpWebhook(
        new Request(`${SITE}/api/clickup/webhook`, {
          method: "POST",
          headers: signature ? { "x-signature": signature } : {},
          body: payload,
        }),
        { fetchImpl, schedule },
      );
    const upstream = fake.requests.length;
    assert.equal((await send(null)).status, 401);
    assert.equal((await send("f".repeat(64))).status, 401);
    assert.equal((await send(signClickUpWebhook("wrong", body))).status, 401);
    assert.equal((await send(signClickUpWebhook(secret, `${body} `))).status, 401);
    assert.equal(fake.requests.length, upstream);
    assert.equal(scheduled.length, 0);
    const good = await send(signClickUpWebhook(secret, body));
    assert.equal(good.status, 200);
    assert.equal(scheduled.length, 1);
    assert.equal(await scheduled[0](), "imported");
    assert.equal((await importedTask(owner.workspaceId, "hooked"))?.contact_id, bobId);
    const replay = await send(signClickUpWebhook(secret, body));
    assert.deepEqual(await replay.json(), { ok: true, duplicate: true });
    assert.equal(scheduled.length, 1);
    const stale = JSON.stringify({
      event: "taskUpdated",
      task_id: "hooked",
      history_items: [{ id: "h-old", date: String(Date.now() - 3 * 24 * 60 * 60 * 1000) }],
    });
    const old = await send(signClickUpWebhook(secret, stale), stale);
    assert.deepEqual(await old.json(), { ok: true, ignored: true });
    assert.equal(scheduled.length, 1);
    const broken = "{not json";
    assert.equal((await send(signClickUpWebhook(secret, broken), broken)).status, 400);

    delete process.env.CLICKUP_API_TOKEN;
    assert.equal((await send(signClickUpWebhook(secret, body))).status, 404);
  });

  it("adds a clickup step for the workspace in scheduled sync", async () => {
    const { targets } = await syncTargets({ fetchImpl });
    const mine = targets.find((target) => target.actor.workspaceId === owner.workspaceId);
    assert.equal(mine?.clickup?.userId, owner.userId);
  });
});
