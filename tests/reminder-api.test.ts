import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { POST as restComplete } from "@/app/api/v1/reminders/[id]/complete/route";
import { POST as restReopen } from "@/app/api/v1/reminders/[id]/reopen/route";
import { DELETE as restDelete, GET as restGet, PATCH as restPatch } from "@/app/api/v1/reminders/[id]/route";
import { GET as restList, POST as restCreate } from "@/app/api/v1/reminders/route";
import { describeAction, isWriteCall, recordNames, runTool, TOOL_DOMAINS, toolDomain } from "@/lib/assistant/tools";
import { systemPrompt } from "@/lib/assistant/prompt";
import { createPersonalToken } from "@/lib/auth/personal";
import { PEOPLE_ONLY, type Reminder } from "@/lib/crm/reminders";
import { SCOPES } from "@/lib/crm/scopes";
import type { Actor, UserActor } from "@/lib/crm/types";
import { getAdminPool } from "@/lib/db/pool";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase, useServerlessPool } from "./helpers";

type ErrorBody = { error: { code: string; message: string; details: { field?: string } | null } };
type Body = { reminder: Reminder; reminders: Reminder[]; doneId: string | null; changed: boolean; deleted: boolean } & ErrorBody;

const REMINDER_TOOLS = ["list_reminders", "create_reminder", "update_reminder", "complete_reminder", "reopen_reminder", "delete_reminder"];

let mark: UserActor;
let sam: UserActor;
let personal = "";
let samToken = "";
let agentToken = "";
let adminToken = "";

function request(token: string, path: string, method: string, body?: unknown) {
  return new Request(`http://crm.test/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as Body };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const rest = {
  list: async (token: string, query = "") => json(await restList(request(token, `/reminders${query}`, "GET"))),
  create: async (token: string, body: unknown) => json(await restCreate(request(token, "/reminders", "POST", body))),
  get: async (token: string, id: string) => json(await restGet(request(token, `/reminders/${id}`, "GET"), params(id))),
  patch: async (token: string, id: string, body: unknown) => json(await restPatch(request(token, `/reminders/${id}`, "PATCH", body), params(id))),
  remove: async (token: string, id: string) => json(await restDelete(request(token, `/reminders/${id}`, "DELETE"), params(id))),
  complete: async (token: string, id: string, body: unknown = {}) => json(await restComplete(request(token, `/reminders/${id}/complete`, "POST", body), params(id))),
  reopen: async (token: string, id: string) => json(await restReopen(request(token, `/reminders/${id}/reopen`, "POST"), params(id))),
};

async function withMcp<T>(actor: Actor, work: (client: Client) => Promise<T>) {
  const server = createCrmMcpServer(actor, actor.type === "user" ? { personal: { tokenId: "00000000-0000-4000-8000-000000000006", canSend: false } } : {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "reminders", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    return await work(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function mcpCall(actor: Actor, name: string, args: Record<string, unknown>) {
  return withMcp(actor, async (client) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = result.content[0]?.text ?? "";
    return { error: Boolean(result.isError), text, body: result.isError ? null : (JSON.parse(text) as Body) };
  });
}

describe("reminders over REST, MCP and the assistant", () => {
  before(async () => {
    await resetDatabase();
    mark = await createUser("mark-reminder-api@orbit.test", "Mark Ridgeon");
    sam = await createUser("sam-reminder-api@orbit.test", "Sam Teammate");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [mark.workspaceId, sam.userId]);
    sam = { ...sam, workspaceId: mark.workspaceId, role: "admin" };
    personal = (await createPersonalToken(mark, "Claude")).token;
    samToken = (await createPersonalToken(sam, "Claude")).token;
    agentToken = (await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Agent")).token;
    adminToken = (await createAgent(mark.workspaceId, [...SCOPES], "Admin agent")).token;
  });

  after(async () => {
    await getAdminPool().end();
  });

  useServerlessPool();

  describe("REST", () => {
    it("adds, reads, changes, ticks, undoes and deletes with a personal token", async () => {
      const created = await rest.create(personal, { title: "Bins out", dueOn: "2038-01-07", repeat: { every: "week" } });
      assert.equal(created.status, 201);
      const id = created.body.reminder.id;
      assert.equal(created.body.reminder.dueOn, "2038-01-07");
      assert.deepEqual(created.body.reminder.repeat, { every: "week", days: ["th"], ends: null });
      assert.equal((await rest.get(personal, id)).body.reminder.title, "Bins out");
      const listed = await rest.list(personal, "?from=2038-01-01&to=2038-01-31");
      assert.deepEqual(listed.body.reminders.map((item) => item.id), [id]);
      const renamed = await rest.patch(personal, id, { title: "Bins and recycling", dueAt: "2038-01-07T19:00", blocksTime: true, durationMinutes: 10 });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.reminder.time, "19:00");
      assert.equal(renamed.body.reminder.blocksTime, true);
      const missingDay = await rest.complete(personal, id);
      assert.equal(missingDay.status, 400);
      assert.equal(missingDay.body.error.details?.field, "dueOn");
      const ticked = await rest.complete(personal, id, { dueOn: "2038-01-07" });
      assert.equal(ticked.body.changed, true);
      assert.equal(ticked.body.reminder.dueOn, "2038-01-14");
      assert.equal(ticked.body.reminder.dueAt, "2038-01-14T19:00:00.000Z");
      const retried = await rest.complete(personal, id, { dueOn: "2038-01-07" });
      assert.equal(retried.body.changed, false);
      assert.equal(retried.body.reminder.dueOn, "2038-01-14");
      const undone = await rest.reopen(personal, ticked.body.doneId!);
      assert.equal(undone.body.reminder.dueOn, "2038-01-07");
      const unknown = await rest.patch(personal, id, { notes: "Green bin" });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.body.error.details?.field, "notes");
      const extra = await rest.complete(personal, id, { dueOn: "2038-01-07", occursOn: "2038-01-07" });
      assert.equal(extra.status, 400);
      const bad = await rest.patch(personal, id, { blocksTime: true, dueAt: null });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.message, "Pick a time to block time.");
      assert.deepEqual((await rest.remove(personal, id)).body, { id, deleted: true });
      assert.equal((await rest.get(personal, id)).status, 404);
      assert.deepEqual((await rest.remove(personal, id)).body, { id, deleted: false });
    });

    it("ends an until repeat on its last day, and adds a retried create once", async () => {
      const until = await rest.create(personal, { title: "Physio", dueOn: "2036-01-07", repeat: { every: "day", ends: { on: "2036-01-08" } } });
      assert.equal(until.status, 201);
      const id = until.body.reminder.id;
      assert.equal((await rest.complete(personal, id, { dueOn: "2036-01-07" })).body.reminder.dueOn, "2036-01-08");
      const last = await rest.complete(personal, id, { dueOn: "2036-01-08" });
      assert.equal(last.body.doneId, id);
      assert.ok(last.body.reminder.completedAt);
      const keyed = (token: string) =>
        new Request("http://crm.test/api/v1/reminders", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "reminder-retry-1" },
          body: JSON.stringify({ title: "Once only" }),
        });
      const one = await json(await restCreate(keyed(personal)));
      const two = await json(await restCreate(keyed(personal)));
      assert.equal(one.body.reminder.id, two.body.reminder.id);
      const theirs = await json(await restCreate(keyed(samToken)));
      assert.notEqual(theirs.body.reminder.id, one.body.reminder.id, "another person's key is their own");
      const count = await getAdminPool().query("select count(*)::int as count from crm.reminders where title = 'Once only' and user_id = $1", [mark.userId]);
      assert.equal(count.rows[0].count, 1);
    });

    it("refuses agent tokens, admin ones included, on every route", async () => {
      const own = (await rest.create(personal, { title: "Private" })).body.reminder;
      for (const token of [agentToken, adminToken]) {
        const results = [
          await rest.list(token),
          await rest.create(token, { title: "Nope" }),
          await rest.create(token, "not an object"),
          await rest.get(token, own.id),
          await rest.patch(token, own.id, { title: "Nope" }),
          await rest.complete(token, own.id, { dueOn: "2038-01-07" }),
          await rest.reopen(token, own.id),
          await rest.remove(token, own.id),
        ];
        for (const result of results) {
          assert.equal(result.status, 403);
          assert.equal(result.body.error.message, PEOPLE_ONLY);
        }
      }
      assert.equal((await rest.get(personal, own.id)).body.reminder.title, "Private");
    });

    it("keeps another person's reminders out of reach, even an admin's", async () => {
      const own = (await rest.create(personal, { title: "Mark only" })).body.reminder;
      assert.equal((await rest.list(samToken)).body.reminders.some((item) => item.id === own.id), false);
      assert.equal((await rest.get(samToken, own.id)).status, 404);
      assert.equal((await rest.patch(samToken, own.id, { title: "Taken" })).status, 404);
      assert.equal((await rest.complete(samToken, own.id)).status, 404);
      assert.equal((await rest.reopen(samToken, own.id)).status, 404);
      assert.equal((await rest.remove(samToken, own.id)).body.deleted, false);
      assert.equal((await rest.get(personal, own.id)).body.reminder.title, "Mark only");
    });
  });

  describe("MCP", () => {
    it("offers the reminder tools to personal tokens only", async () => {
      const own = await withMcp(mark, async (client) => (await client.listTools()).tools.map((tool) => tool.name));
      for (const name of REMINDER_TOOLS) assert.ok(own.includes(name), name);
      const agent = (await createAgent(mark.workspaceId, [...SCOPES], "MCP agent")).actor;
      const agentTools = await withMcp(agent, async (client) => (await client.listTools()).tools.map((tool) => tool.name));
      assert.deepEqual(agentTools.filter((name) => name.includes("reminder")), []);
    });

    it("behaves like REST for the same input", async () => {
      const made = await mcpCall(mark, "create_reminder", { title: "Water plants", dueOn: "2038-02-01", repeat: { every: "day", ends: { after: 2 } } });
      assert.equal(made.error, false, made.text);
      const id = made.body!.reminder.id;
      const viaRest = await rest.create(personal, { title: "Water plants", dueOn: "2038-02-01", repeat: { every: "day", ends: { after: 2 } } });
      const pick = (item: Reminder) => [item.title, item.dueOn, item.dueAt, item.repeatText, JSON.stringify(item.repeat)];
      assert.deepEqual(pick(made.body!.reminder), pick(viaRest.body.reminder));
      const refused = await mcpCall(mark, "complete_reminder", { id });
      assert.equal(refused.error, true);
      assert.match(refused.text, /Send dueOn/);
      const first = await mcpCall(mark, "complete_reminder", { id, dueOn: "2038-02-01" });
      assert.equal(first.body!.reminder.dueOn, "2038-02-02");
      const last = await mcpCall(mark, "complete_reminder", { id, dueOn: "2038-02-02" });
      assert.ok(last.body!.reminder.completedAt, "after 2 times it is done");
      const changed = await mcpCall(mark, "update_reminder", { id, title: "Changed" });
      assert.match(changed.text, /Reopen it first/);
      const reopened = await mcpCall(mark, "reopen_reminder", { id });
      assert.equal(reopened.body!.reminder.completedAt, null);
      const listed = await mcpCall(mark, "list_reminders", { id });
      assert.equal(listed.body!.reminder.id, id);
      const gone = await mcpCall(mark, "delete_reminder", { id });
      assert.equal(gone.body!.deleted, true);
      const hidden = await mcpCall(sam, "list_reminders", { id: viaRest.body.reminder.id });
      assert.match(hidden.text, /Reminder not found/);
    });
  });

  describe("every route", () => {
    it("refuses the same bad input with the same message on REST, MCP and the assistant", async () => {
      const target = (await rest.create(personal, { title: "Parity", dueOn: "2038-01-07", repeat: { every: "day" } })).body.reminder;
      const bad = [
        { title: "Both ends", dueOn: "2038-01-07", repeat: { every: "week", ends: { after: 2, on: "2038-02-01" } } },
        { title: "Colour", dueOn: "2038-01-07", repeat: { every: "week", colour: "red" } },
        { title: "Ends key", dueOn: "2038-01-07", repeat: { every: "week", ends: { times: 2 } } },
        { title: "Bad day", dueOn: "31/02/2038" },
      ];
      for (const input of bad) {
        const viaRest = await rest.create(personal, input);
        assert.equal(viaRest.status, 400, JSON.stringify(input));
        const viaMcp = await mcpCall(mark, "create_reminder", input);
        assert.equal(viaMcp.text, `invalid_input: ${viaRest.body.error.message}`, JSON.stringify(input));
        const viaAssistant = (await runTool(mark, "reminders", { action: "create", ...input })) as { error: string };
        assert.equal(viaAssistant.error, viaRest.body.error.message, JSON.stringify(input));
      }
      const listRest = await rest.list(personal, "?from=31/02/2038");
      assert.equal(listRest.status, 400);
      assert.equal((await mcpCall(mark, "list_reminders", { from: "31/02/2038" })).text, `invalid_input: ${listRest.body.error.message}`);
      assert.equal(((await runTool(mark, "reminders", { action: "list", from: "31/02/2038" })) as { error: string }).error, listRest.body.error.message);
      const tickRest = await rest.complete(personal, target.id, { dueOn: "tomorrow" });
      assert.equal(tickRest.status, 400);
      assert.equal((await mcpCall(mark, "complete_reminder", { id: target.id, dueOn: "tomorrow" })).text, `invalid_input: ${tickRest.body.error.message}`);
      assert.equal(((await runTool(mark, "reminders", { action: "complete", id: target.id, dueOn: "tomorrow" })) as { error: string }).error, tickRest.body.error.message);
      assert.equal((await rest.get(personal, target.id)).body.reminder.dueOn, "2038-01-07");
    });
  });

  describe("assistant", () => {
    it("keeps reminders in their own area, reads without a card and writes through one", async () => {
      assert.deepEqual(TOOL_DOMAINS.reminders.tools, ["reminders"]);
      assert.equal(toolDomain("create_reminder"), "reminders");
      assert.equal(isWriteCall("reminders", { action: "list" }), false);
      assert.equal(isWriteCall("list_reminders", {}), false);
      for (const action of ["create", "update", "complete", "reopen", "delete"]) assert.equal(isWriteCall("reminders", { action }), true, action);
      assert.equal(isWriteCall("create_reminder", { title: "Bins" }), true);
      const prompt = systemPrompt(mark);
      assert.match(prompt, /"Remind me\.\.\." with no person, company, opportunity or piece of work in it/);
      assert.match(prompt, /- reminders: /);
    });

    it("creates, ticks and undoes through the tool with clear cards", async () => {
      const create = { action: "create", title: "Renew car tax", dueAt: "2038-03-01T09:30", repeat: { every: "year" } };
      assert.deepEqual(describeAction("reminders", create), { title: "Add reminder: Renew car tax", lines: ["Mon 1 Mar at 09:30", "Repeats: Every year on 1 Mar."] });
      const made = (await runTool(mark, "reminders", create)) as { reminder: Reminder };
      assert.equal(made.reminder.time, "09:30");
      const complete = { action: "complete", id: made.reminder.id, dueOn: "2038-03-01" };
      assert.deepEqual(describeAction("reminders", complete, await recordNames(mark, [complete], ["reminders"])), { title: "Tick off: Renew car tax", lines: ["For Mon 1 Mar"] });
      const ticked = (await runTool(mark, "complete_reminder", { id: made.reminder.id, dueOn: "2038-03-01" })) as { reminder: Reminder; doneId: string };
      assert.equal(ticked.reminder.dueOn, "2039-03-01");
      const undone = (await runTool(mark, "reopen_reminder", { id: ticked.doneId })) as { reminder: Reminder };
      assert.equal(undone.reminder.dueOn, "2038-03-01");
      const cleared = (await runTool(mark, "reminders", { action: "update", id: made.reminder.id, dueAt: null })) as { reminder: Reminder };
      assert.equal(cleared.reminder.dueAt, null, "null drops the time");
      assert.equal(cleared.reminder.dueOn, "2038-03-01");
      const listed = (await runTool(mark, "reminders", { action: "list" })) as { reminders: Reminder[] };
      assert.ok(listed.reminders.some((item) => item.id === made.reminder.id));
      const theirs = (await runTool(sam, "reminders", { action: "list" })) as { reminders: Reminder[] };
      assert.equal(theirs.reminders.some((item) => item.id === made.reminder.id), false);
      const stolen = (await runTool(sam, "reminders", { action: "delete", id: made.reminder.id })) as { deleted: boolean };
      assert.equal(stolen.deleted, false);
      const remove = { action: "delete", id: made.reminder.id };
      assert.equal(describeAction("reminders", remove, await recordNames(mark, [remove], ["reminders"])).title, "Delete reminder: Renew car tax");
      assert.equal(describeAction("reminders", remove, await recordNames(sam, [remove], ["reminders"])).title, "Delete reminder: a reminder", "another person's title never reaches the card");
    });
  });
});
