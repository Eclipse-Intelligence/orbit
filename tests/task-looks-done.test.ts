import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { archiveActivity, createActivity, createEmailActivityOnce, updateActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { recordAudit } from "@/lib/crm/mutate";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import { completeTaskWithOutcome } from "@/lib/crm/task-act";
import { closeTaskFromOffer, dismissTaskDoneOffer, drainTaskDoneQueue, taskDoneNotes, taskDoneOffers } from "@/lib/crm/task-done";
import { addTaskParticipantsInDb, archiveTask, completeTask, createTask, reopenTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool, query } from "@/lib/db/pool";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

type Answer = { id: string; satisfied: boolean; note?: string; nextTask?: string; dueOn?: string };
type Request = {
  today: string;
  activity: { kind: string; title: string | null; text: string; with: string | null };
  tasks: { id: string; title: string; notes: string | null }[];
  "Open tasks on the same records": string[];
};

const admin = () => getAdminPool();
const savedKey = process.env.LLM_API_KEY;
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

function gateway(decide: (request: Request) => Answer[] | "fail" = (request) => request.tasks.map((task) => ({ id: task.id, satisfied: true, note: "Did it." }))) {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
    const request = JSON.parse(body.messages[1].content) as Request;
    requests.push(request);
    const answers = decide(request);
    if (answers === "fail") return new Response("down", { status: 400 });
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ tasks: answers }) }, finish_reason: "stop" }] });
  };
  return { fetchImpl, requests };
}

function topics(request: Request) {
  const text = request.activity.text.toLowerCase();
  return request.tasks.map((task) => {
    const wanted = ["pricing", "pilot"].filter((word) => task.title.toLowerCase().includes(word));
    return { id: task.id, satisfied: wanted.every((word) => text.includes(word)), note: "Covered what it asks." };
  });
}

describe("looks done offers", () => {
  let mark: UserActor;
  let sam: UserActor;
  let ada: UserActor;
  let priya: UserActor;
  let ridgeon: UserActor;
  let counter = 0;

  before(async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    await resetDatabase();
    mark = await createUser("mark@looksdone.test", "Mark Ridgeon");
    const member = async (email: string, name: string, role: "member" | "admin") => {
      const person = await createUser(email, name);
      await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, person.userId, role]);
      return { ...person, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) } as UserActor;
    };
    sam = await member("sam@looksdone.test", "Sam Colleague", "member");
    ada = await member("ada@looksdone.test", "Ada Admin", "admin");
    priya = await member("priya@looksdone.test", "Priya Tagged", "member");
    const created = await createWorkspace(mark, { name: "Mark Ridgeon" });
    ridgeon = { ...mark, workspaceId: created.id, workspaceName: "Mark Ridgeon" };
  });

  after(async () => {
    if (savedKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = savedKey;
    await getPool().end();
    await getAdminPool().end();
  });

  useServerlessPool();

  beforeEach(async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    await admin().query("delete from crm.task_done_queue");
  });

  afterEach(async () => {
    process.env.LLM_API_KEY = "test-llm-key";
  });

  async function scene(actor = mark) {
    counter += 1;
    const domain = `scene${counter}-looksdone.test`;
    const company = (await createCompany(actor, { name: `Scene ${counter}`, domain })).body.company.id;
    const jane = (await createContact(actor, { companyId: company, firstName: "Jane", lastName: `Scene${counter}`, email: `jane@${domain}` })).body.contact.id;
    const tom = (await createContact(actor, { companyId: company, firstName: "Tom", lastName: `Scene${counter}`, email: `tom@${domain}` })).body.contact.id;
    return { company, jane, tom };
  }

  async function task(actor: UserActor, title: string, links: { contactId?: string; companyId?: string }, options: { ownerId?: string; ageHours?: number; notes?: string } = {}) {
    const created = (await createTask(actor, { title, description: options.notes, ownerId: options.ownerId, ...links })).body.task;
    await admin().query("update crm.tasks set created_at = now() - make_interval(hours => $2) where id = $1", [created.id, options.ageHours ?? 48]);
    return created.id;
  }

  async function log(
    type: "call" | "email" | "meeting" | "note",
    links: { contactId?: string; companyId?: string },
    options: { body?: string; metadata?: Record<string, unknown>; occurredAt?: string; actor?: UserActor; title?: string } = {},
  ) {
    const result = await createActivity(options.actor ?? mark, {
      type,
      title: options.title ?? `A ${type}`,
      body: options.body ?? "We went through it.",
      occurredAt: options.occurredAt ?? hourAgo(),
      metadata: options.metadata,
      ...links,
    });
    return result.body.activity.id;
  }

  async function drain(fake = gateway()) {
    const totals = await drainTaskDoneQueue({ deadline: Date.now() + 90_000, fetchImpl: fake.fetchImpl });
    return { ...totals, requests: fake.requests };
  }

  async function offersFor(taskId: string) {
    return (await admin().query<{ id: string; state: string; activity_id: string; kind: string; note: string | null; next_title: string | null; next_due: string | null; decided_by: string | null }>(
      "select id, state, activity_id, kind, note, next_title, next_due::text, decided_by from crm.task_done_offers where task_id = $1 order by created_at",
      [taskId],
    )).rows;
  }

  async function openOffers(taskId: string) {
    return (await offersFor(taskId)).filter((offer) => offer.state === "offered");
  }

  async function queued() {
    return (await admin().query<{ activity_id: string; reason: string }>("select activity_id, reason from crm.task_done_queue order by queued_at")).rows;
  }

  describe("topic matching", () => {
    it("offers when the activity covers every topic and not when it misses one", async () => {
      const { jane } = await scene();
      const both = await task(mark, "Call Jane about pricing and the pilot", { contactId: jane }, { notes: "She wants a number." });
      await log("call", { contactId: jane }, { body: "Walked through pricing, then agreed the pilot starts in January." });
      const done = await drain(gateway(topics));
      assert.equal(done.offered, 1);
      const [offer] = await openOffers(both);
      assert.equal(offer.kind, "call");
      assert.equal(offer.note, "Covered what it asks.");
      assert.equal(done.requests.length, 1);
      assert.equal(done.requests[0].tasks[0].notes, "She wants a number.");

      const partial = await task(mark, "Call Tom about pricing and the pilot", { contactId: (await scene()).jane });
      const other = (await admin().query<{ contact_id: string }>("select contact_id from crm.tasks where id = $1", [partial])).rows[0].contact_id;
      await log("call", { contactId: other }, { body: "We only talked about pricing." });
      const missed = await drain(gateway(topics));
      assert.equal(missed.offered, 0);
      assert.equal((await offersFor(partial)).length, 0);
    });

    it("offers a task that names no topic after any call with that person", async () => {
      const { jane } = await scene();
      const wednesday = await task(mark, "Call Jane Wednesday", { contactId: jane });
      await log("call", { contactId: jane }, { body: "A quick catch up." });
      const done = await drain();
      assert.equal(done.offered, 1);
      assert.equal((await openOffers(wednesday)).length, 1);
    });

    it("stores the suggested next step, drops a past day and ignores ids it was not asked about", async () => {
      const { jane, tom } = await scene();
      const taskId = await task(mark, "Send Jane the proposal", { contactId: jane });
      await task(mark, "Open one on the company", { contactId: tom });
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await log("email", { contactId: jane }, { body: "Proposal attached.", metadata: { direction: "outbound" } });
      const fake = gateway((request) => [
        { id: request.tasks[0].id, satisfied: true, note: "Sent it.", nextTask: "Chase Jane for a decision", dueOn: yesterday },
        { id: randomUUID(), satisfied: true, note: "Not asked." },
      ]);
      const done = await drain(fake);
      assert.equal(done.offered, 1);
      const [offer] = await openOffers(taskId);
      assert.equal(offer.next_title, "Chase Jane for a decision");
      assert.equal(offer.next_due, null);
      assert.ok(fake.requests[0]["Open tasks on the same records"].some((line) => line.includes("Open one on the company")));
      assert.match(JSON.stringify(fake.requests[0]), /Chase|Send Jane the proposal/);
    });

    it("keeps a future next step day", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Send Jane the order form", { contactId: jane });
      await log("email", { contactId: jane }, { metadata: { direction: "outbound" } });
      const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      await drain(gateway((request) => [{ id: request.tasks[0].id, satisfied: true, note: "Sent.", nextTask: "Chase the signature", dueOn: nextWeek }]));
      assert.equal((await openOffers(taskId))[0].next_due, nextWeek);
    });

    it("puts a call summary in what the model reads", async () => {
      const { jane } = await scene();
      await task(mark, "Call Jane about pricing", { contactId: jane });
      const activityId = await log("call", { contactId: jane }, { body: "Teams call." });
      await admin().query(
        `insert into crm.call_insights (workspace_id, activity_id, contact_id, source, transcript, summary, status)
         values ($1, $2, $3, 'teams', 'transcript', 'They settled pricing.', 'ready')`,
        [mark.workspaceId, activityId, jane],
      );
      const done = await drain(gateway(topics));
      assert.match(done.requests[0].activity.text, /They settled pricing\./);
      assert.equal(done.offered, 1);
    });
  });

  describe("which records match", () => {
    it("matches a task with a contact on that contact only, and a task without one on the company", async () => {
      const { company, jane, tom } = await scene();
      const forJane = await task(mark, "Call Jane", { contactId: jane, companyId: company });
      const forCompany = await task(mark, "Check in with the team", { companyId: company });
      await log("call", { contactId: tom });
      await drain();
      assert.equal((await offersFor(forJane)).length, 0);
      assert.equal((await openOffers(forCompany)).length, 1);

      await log("call", { contactId: jane }, { occurredAt: new Date(Date.now() - 1_800_000).toISOString() });
      await drain();
      assert.equal((await openOffers(forJane)).length, 1);
    });

    it("matches a company activity to company tasks and not to a contact's task", async () => {
      const { company, jane } = await scene();
      const forJane = await task(mark, "Call Jane", { contactId: jane });
      const forCompany = await task(mark, "Ring the switchboard", { companyId: company });
      await log("call", { companyId: company });
      await drain();
      assert.equal((await offersFor(forJane)).length, 0);
      assert.equal((await openOffers(forCompany)).length, 1);
    });

    it("never reaches across a workspace", async () => {
      const { jane } = await scene();
      const mine = await task(mark, "Call Jane", { contactId: jane });
      const there = await scene(ridgeon);
      const theirs = await task(ridgeon, "Call Jane", { contactId: there.jane });
      await log("call", { contactId: there.jane }, { actor: ridgeon });
      const done = await drain();
      assert.equal((await offersFor(mine)).length, 0);
      assert.equal((await openOffers(theirs)).length, 1);
      assert.ok(done.requests.every((request) => request.tasks.every((entry) => entry.id !== mine)));
    });

    it("hides an offer whose activity is in another workspace", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      const there = await scene(ridgeon);
      const foreign = await log("call", { contactId: there.jane }, { actor: ridgeon });
      await admin().query("insert into crm.task_done_offers (task_id, activity_id, kind) values ($1, $2, 'call')", [taskId, foreign]);
      assert.deepEqual(await taskDoneOffers(mark, [taskId]), []);
    });
  });

  describe("which activities count", () => {
    it("ignores an activity older than the task and one in the future", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane }, { ageHours: 2 });
      await log("call", { contactId: jane }, { occurredAt: new Date(Date.now() - 5 * 3_600_000).toISOString() });
      const future = await log("call", { contactId: jane }, { occurredAt: new Date(Date.now() + 86_400_000).toISOString() });
      const done = await drain();
      assert.equal(done.requests.length, 0);
      assert.equal((await offersFor(taskId)).length, 0);
      assert.equal(
        (await query("select * from private.task_done_activity($1)", [future])).rowCount,
        0,
      );
    });

    it("ignores Orbit's own invites, bookings, missed calls and inbound mail", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Meet Jane", { contactId: jane });
      await log("meeting", { contactId: jane }, { metadata: { source: "orbit", kind: "invite" } });
      await log("meeting", { contactId: jane }, { metadata: { source: "booking" } });
      await log("call", { contactId: jane }, { metadata: { durationSeconds: 0 } });
      await log("email", { contactId: jane }, { metadata: { campaignMessageId: randomUUID(), direction: "inbound" } });
      await log("email", { contactId: jane }, { metadata: { direction: "inbound" } });
      await log("email", { contactId: jane }, { metadata: { source: "microsoft", providerMessageId: "x" } });
      await log("note", { contactId: jane });
      const done = await drain();
      assert.equal(done.requests.length, 0);
      assert.equal((await offersFor(taskId)).length, 0);
    });

    it("counts outbound mail, hand logged and API emails, and meetings from Teams and Granola", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Follow up with Jane", { contactId: jane });
      await log("email", { contactId: jane }, { metadata: { direction: "outbound", source: "microsoft" } });
      await log("email", { contactId: jane }, { metadata: { source: "manual" } });
      await log("email", { contactId: jane }, { metadata: { participants: ["jane@example.test"] } });
      await log("meeting", { contactId: jane }, { metadata: { source: "granola" } });
      const done = await drain(gateway(() => []));
      assert.equal(done.requests.length, 4);
      assert.equal((await offersFor(taskId)).length, 0);
    });

    it("counts a reply a person typed on a campaign thread and a call that connected", async () => {
      const { jane, tom } = await scene();
      const reply = await task(mark, "Reply to Jane about the pilot", { contactId: jane });
      const call = await task(mark, "Call Tom", { contactId: tom });
      await log("email", { contactId: jane }, { metadata: { campaignMessageId: randomUUID(), direction: "outbound" } });
      await log("call", { contactId: tom }, { metadata: { durationSeconds: 240 } });
      await drain();
      assert.equal((await openOffers(reply)).length, 1);
      assert.equal((await openOffers(call)).length, 1);
    });

    it("matches mail that synced late", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Send Jane the deck", { contactId: jane });
      await withActor(mark, (db) =>
        createEmailActivityOnce(
          db,
          mark,
          { type: "email", title: "The deck", body: "Deck attached.", contactId: jane, occurredAt: new Date(Date.now() - 6 * 3_600_000).toISOString(), metadata: { source: "microsoft", direction: "outbound", internetMessageId: "<late@looksdone.test>" } },
          { internetMessageId: "<late@looksdone.test>" },
          { operation: "sync_inbox", source: "microsoft", catchUp: true },
        ),
      );
      assert.equal((await queued()).length, 1);
      await drain();
      assert.equal((await openOffers(taskId)).length, 1);
    });

    it("matches an email once it is relinked to the task's contact", async () => {
      const { company, jane, tom } = await scene();
      const taskId = await task(mark, "Send Jane the contract", { contactId: jane });
      const activity = await log("email", { contactId: tom, companyId: company }, { metadata: { direction: "outbound", source: "manual" } });
      await drain();
      assert.equal((await offersFor(taskId)).length, 0);
      await updateActivity(mark, activity, { contactId: jane }, { operation: "relink_mail", source: "web" });
      assert.deepEqual((await queued()).map((row) => row.reason), ["moved"]);
      await drain();
      assert.equal((await openOffers(taskId)).length, 1);
    });

    it("takes an offer back when its activity moves to another person, and offers it again to the right task", async () => {
      const { company, jane, tom } = await scene();
      const janes = await task(mark, "Call Jane", { contactId: jane });
      const toms = await task(mark, "Call Tom", { contactId: tom });
      const activity = await log("call", { contactId: jane, companyId: company });
      await drain();
      assert.equal((await openOffers(janes)).length, 1);
      assert.equal((await openOffers(toms)).length, 0);
      await updateActivity(mark, activity, { contactId: tom }, { operation: "relink", source: "web" });
      assert.deepEqual((await queued()).map((row) => row.reason), ["moved"]);
      await drain();
      assert.deepEqual(await taskDoneOffers(mark, [janes]), []);
      assert.equal((await openOffers(janes)).length, 0);
      assert.equal((await openOffers(toms)).length, 1);
      await updateActivity(mark, activity, { contactId: jane }, { operation: "relink", source: "web" });
      await drain();
      assert.equal((await openOffers(janes)).length, 1);
      assert.equal((await openOffers(toms)).length, 0);
    });

    it("takes an offer back when its activity changes type, and offers it again when it still fits", async () => {
      const { jane } = await scene();
      const calling = await task(mark, "Call Jane", { contactId: jane });
      const activity = await log("call", { contactId: jane });
      await drain();
      assert.equal((await openOffers(calling)).length, 1);
      await updateActivity(mark, activity, { type: "note" }, { operation: "retype", source: "web" });
      await drain();
      assert.equal((await openOffers(calling)).length, 0);
      await updateActivity(mark, activity, { type: "meeting" }, { operation: "retype", source: "web" });
      await drain();
      const open = await openOffers(calling);
      assert.equal(open.length, 1);
      assert.equal(open[0].kind, "meeting");
    });

    it("brings back the older offer a moved activity had replaced", async () => {
      const { company, jane, tom } = await scene();
      const janes = await task(mark, "Call Jane", { contactId: jane });
      const older = await log("call", { contactId: jane, companyId: company }, { occurredAt: new Date(Date.now() - 7_200_000).toISOString() });
      await drain();
      const newer = await log("call", { contactId: jane, companyId: company }, { occurredAt: new Date(Date.now() - 3_600_000).toISOString() });
      await drain();
      assert.deepEqual((await offersFor(janes)).map((row) => [row.activity_id, row.state]), [[older, "dismissed"], [newer, "offered"]]);
      await updateActivity(mark, newer, { contactId: tom }, { operation: "relink", source: "web" });
      await drain();
      assert.deepEqual((await offersFor(janes)).map((row) => [row.activity_id, row.state]), [[older, "offered"]]);
    });

    it("does not bring back the older offer when its activity was archived", async () => {
      const { company, jane, tom } = await scene();
      const janes = await task(mark, "Call Jane", { contactId: jane });
      const older = await log("call", { contactId: jane, companyId: company }, { occurredAt: new Date(Date.now() - 7_200_000).toISOString() });
      await drain();
      const newer = await log("call", { contactId: jane, companyId: company }, { occurredAt: new Date(Date.now() - 3_600_000).toISOString() });
      await drain();
      await archiveActivity(mark, older, { operation: "archive", source: "web" });
      await updateActivity(mark, newer, { contactId: tom }, { operation: "relink", source: "web" });
      await drain();
      assert.equal((await openOffers(janes)).length, 0);
    });

    it("does not bring back the older offer when its activity no longer counts", async () => {
      const { company, jane, tom } = await scene();
      const janes = await task(mark, "Call Jane", { contactId: jane });
      const older = await log("call", { contactId: jane, companyId: company }, { occurredAt: new Date(Date.now() - 7_200_000).toISOString() });
      await drain();
      const newer = await log("call", { contactId: jane, companyId: company }, { occurredAt: new Date(Date.now() - 3_600_000).toISOString() });
      await drain();
      await updateActivity(mark, older, { type: "note" }, { operation: "retype", source: "web" });
      await admin().query("delete from crm.task_done_queue");
      await updateActivity(mark, newer, { contactId: tom }, { operation: "relink", source: "web" });
      await drain();
      assert.equal((await openOffers(janes)).length, 0);
    });

    it("stores no offer for a task that is no longer linked to the activity", async () => {
      const { company, jane, tom } = await scene();
      const toms = await task(mark, "Call Tom", { contactId: tom });
      const activity = await log("call", { contactId: jane, companyId: company });
      await admin().query("delete from crm.task_done_queue");
      const stored = await query<{ offer: boolean }>("select private.offer_task_done($1, $2, null, null, null) as offer", [toms, activity]);
      assert.equal(stored.rows[0].offer, false);
      assert.equal((await offersFor(toms)).length, 0);
    });

    it("keeps a 3 argument retry for code deployed before the migration", async () => {
      const { jane } = await scene();
      await log("call", { contactId: jane });
      const claimed = (await query<{ id: string; claim_token: string }>("select * from private.claim_task_done_queue(1)")).rows[0];
      await query("select private.retry_task_done_queue($1, $2, 60)", [claimed.id, claimed.claim_token]);
      const row = (await admin().query<{ claimed_at: Date | null; asked: string[]; wait: number }>("select claimed_at, asked, extract(epoch from next_attempt_at - now())::int as wait from crm.task_done_queue where id = $1", [claimed.id])).rows[0];
      assert.equal(row.claimed_at, null);
      assert.deepEqual(row.asked, []);
      assert.ok(row.wait > 0);
    });

    it("queues a call again when its summary is ready", async () => {
      const { jane } = await scene();
      const activity = await log("call", { contactId: jane });
      await admin().query("delete from crm.task_done_queue");
      await withActor(mark, (db) => recordAudit(db, mark, "call_summary.ready", "call_insight", randomUUID(), { operation: "summarise_call", source: "teams" }, { activityId: activity }));
      assert.deepEqual(await queued(), [{ activity_id: activity, reason: "summary" }]);
    });

    it("does not queue notes or changes that cannot alter a match", async () => {
      const { jane } = await scene();
      const activity = await log("call", { contactId: jane });
      await log("note", { contactId: jane });
      await admin().query("delete from crm.task_done_queue");
      await updateActivity(mark, activity, { title: "Renamed call" }, { operation: "edit", source: "web" });
      assert.deepEqual(await queued(), []);
    });
  });

  describe("one open offer per task", () => {
    it("keeps one open offer when an email goes to two contacts", async () => {
      const { company, jane, tom } = await scene();
      const taskId = await task(mark, "Send the team the agenda", { companyId: company });
      await log("email", { contactId: jane }, { metadata: { direction: "outbound" }, occurredAt: new Date(Date.now() - 7_200_000).toISOString() });
      await log("email", { contactId: tom }, { metadata: { direction: "outbound" }, occurredAt: new Date(Date.now() - 7_100_000).toISOString() });
      await Promise.all([drain(), drain()]);
      const offers = await offersFor(taskId);
      assert.equal(offers.filter((offer) => offer.state === "offered").length, 1);
      assert.ok(offers.length <= 2);
    });

    it("keeps one open offer when runs overlap on the same task", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      const first = await log("call", { contactId: jane }, { occurredAt: new Date(Date.now() - 7_200_000).toISOString() });
      const second = await log("call", { contactId: jane }, { occurredAt: new Date(Date.now() - 3_600_000).toISOString() });
      const results = await Promise.all([
        query<{ offer: boolean }>("select private.offer_task_done($1, $2, 'First', null, null) as offer", [taskId, first]),
        query<{ offer: boolean }>("select private.offer_task_done($1, $2, 'Second', null, null) as offer", [taskId, second]),
      ]);
      assert.ok(results.some((result) => result.rows[0].offer));
      const open = await openOffers(taskId);
      assert.equal(open.length, 1);
      assert.equal(open[0].activity_id, second);
      const again = await query<{ offer: boolean }>("select private.offer_task_done($1, $2, 'Again', null, null) as offer", [taskId, first]);
      assert.equal(again.rows[0].offer, false);
    });

    it("lets a newer activity replace the open offer and not an older one", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      const older = await log("call", { contactId: jane }, { occurredAt: new Date(Date.now() - 7_200_000).toISOString() });
      await drain();
      const newer = await log("call", { contactId: jane }, { occurredAt: new Date(Date.now() - 3_600_000).toISOString() });
      await drain();
      const offers = await offersFor(taskId);
      assert.deepEqual(offers.map((offer) => [offer.activity_id, offer.state]), [[older, "dismissed"], [newer, "offered"]]);
      assert.equal(offers[0].decided_by, null);
    });
  });

  describe("dismissing", () => {
    it("never offers a dismissed activity again, and a later activity can offer", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      const first = await log("call", { contactId: jane }, { occurredAt: new Date(Date.now() - 7_200_000).toISOString() });
      await drain();
      const [offer] = await openOffers(taskId);
      const dismissed = await dismissTaskDoneOffer(mark, offer.id);
      assert.deepEqual(dismissed, { id: offer.id, changed: true });
      assert.deepEqual(await taskDoneOffers(mark, [taskId]), []);

      await updateActivity(mark, first, { body: "Edited after the fact." }, { operation: "edit", source: "web" });
      const again = await drain();
      assert.equal(again.requests.length, 0);
      assert.deepEqual((await offersFor(taskId)).map((row) => row.state), ["dismissed"]);

      const later = await log("call", { contactId: jane });
      await drain();
      const open = await openOffers(taskId);
      assert.equal(open.length, 1);
      assert.equal(open[0].activity_id, later);
      const stored = (await offersFor(taskId))[0];
      assert.equal(stored.decided_by, mark.userId);
    });

    it("is quiet when the offer is already dismissed and refuses unknown ones and agents", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      await log("call", { contactId: jane });
      await drain();
      const [offer] = await openOffers(taskId);
      await dismissTaskDoneOffer(mark, offer.id);
      assert.deepEqual(await dismissTaskDoneOffer(mark, offer.id), { id: offer.id, changed: false });
      await assert.rejects(dismissTaskDoneOffer(mark, randomUUID()), (error: unknown) => error instanceof CrmError && error.status === 404);
      await assert.rejects(dismissTaskDoneOffer(mark, "nope"), (error: unknown) => error instanceof CrmError && error.status === 404);
      const { actor } = await createAgent(mark.workspaceId, SCOPES.filter((scope) => scope !== "admin"), "Looks done agent");
      await assert.rejects(dismissTaskDoneOffer(actor, offer.id), (error: unknown) => error instanceof CrmError && error.status === 403);
    });
  });

  describe("privacy", () => {
    it("never sends a teammate's task to the model alongside another person's", async () => {
      const { company, jane } = await scene();
      const mine = await task(mark, "Mark's private call to Jane", { contactId: jane, companyId: company });
      const theirs = await task(sam, "Sam's private call to Jane", { contactId: jane, companyId: company });
      await log("call", { contactId: jane });
      const done = await drain();
      assert.equal(done.requests.length, 2);
      for (const request of done.requests) {
        const text = JSON.stringify(request);
        const markSeen = text.includes("Mark's private");
        const samSeen = text.includes("Sam's private");
        assert.notEqual(markSeen, samSeen);
      }
      assert.equal((await openOffers(mine)).length, 1);
      assert.equal((await openOffers(theirs)).length, 1);
      assert.deepEqual((await taskDoneOffers(mark, [mine, theirs])).map((offer) => offer.taskId), [mine]);
      assert.deepEqual((await taskDoneOffers(sam, [mine, theirs])).map((offer) => offer.taskId), [theirs]);
    });

    it("lets a tagged person read the offer and not decide it, and shows nothing to admins or others", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      await withActor(mark, (db) => addTaskParticipantsInDb(db, mark, taskId, [priya.userId]));
      await log("call", { contactId: jane });
      await drain();
      const [offer] = await openOffers(taskId);
      assert.equal((await taskDoneOffers(priya, [taskId])).length, 1);
      await assert.rejects(dismissTaskDoneOffer(priya, offer.id), (error: unknown) => error instanceof CrmError && error.status === 403);
      const direct = await queryAsUser<{ id: string }>(priya.userId, "update crm.task_done_offers set state = 'dismissed', decided_at = now(), decided_by = $2 where id = $1 returning id", [offer.id, priya.userId]);
      assert.equal(direct.length, 0);
      assert.equal((await openOffers(taskId)).length, 1);
      assert.deepEqual(await taskDoneOffers(ada, [taskId]), []);
      assert.deepEqual(await taskDoneOffers(sam, [taskId]), []);
      assert.equal((await queryAsUser(ada.userId, "select 1 from crm.task_done_offers where id = $1", [offer.id])).length, 0);
    });

    it("lets the creator of a task handed to someone else read and dismiss its offer", async () => {
      const { jane } = await scene();
      const taskId = await task(sam, "Call Jane", { contactId: jane }, { ownerId: mark.userId });
      await log("call", { contactId: jane });
      await drain();
      assert.equal((await taskDoneOffers(sam, [taskId])).length, 1);
      assert.equal((await taskDoneOffers(mark, [taskId])).length, 1);
      const [offer] = await openOffers(taskId);
      assert.equal((await dismissTaskDoneOffer(sam, offer.id)).changed, true);
    });

    it("refuses direct changes beyond the decision columns", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      await log("call", { contactId: jane });
      await drain();
      const [offer] = await openOffers(taskId);
      await assert.rejects(queryAsUser(mark.userId, "update crm.task_done_offers set note = 'Rewritten' where id = $1", [offer.id]), (error: unknown) => (error as { code?: string }).code === "42501");
      await assert.rejects(queryAsUser(mark.userId, "insert into crm.task_done_offers (task_id, activity_id, kind) values ($1, $2, 'call')", [taskId, offer.activity_id]), (error: unknown) => (error as { code?: string }).code === "42501");
      await assert.rejects(queryAsUser(mark.userId, "insert into crm.task_done_queue (activity_id, reason, attempts) values ($1, 'created', 0)", [offer.activity_id]), (error: unknown) => (error as { code?: string }).code === "42501");
      await assert.rejects(queryAsUser(mark.userId, "select * from crm.task_done_queue"), (error: unknown) => (error as { code?: string }).code === "42501");
      const asOther = await queryAsUser<{ id: string }>(mark.userId, "update crm.task_done_offers set state = 'dismissed', decided_at = now(), decided_by = $2 where id = $1 returning id", [offer.id, sam.userId]).catch(() => "refused");
      assert.equal(asOther, "refused");
    });
  });

  describe("reads", () => {
    it("shows an offer only while the task is open and unarchived and the activity is not archived", async () => {
      const { jane, tom } = await scene();
      const open = await task(mark, "Call Jane", { contactId: jane });
      const closed = await task(mark, "Call Tom", { contactId: tom });
      const archived = await task(mark, "Call Tom again", { contactId: tom });
      const janeCall = await log("call", { contactId: jane });
      await log("call", { contactId: tom });
      await drain();
      assert.equal((await taskDoneOffers(mark, [open, closed, archived])).length, 3);

      await completeTask(mark, closed);
      await archiveTask(mark, archived);
      assert.deepEqual((await taskDoneOffers(mark, [open, closed, archived])).map((offer) => offer.taskId), [open]);

      await archiveActivity(mark, janeCall, { operation: "archive", source: "web" });
      assert.deepEqual(await taskDoneOffers(mark, [open]), []);
      assert.equal((await openOffers(open)).length, 1);
    });

    it("returns the offer's details and ignores unusable ids", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      const activity = await log("call", { contactId: jane }, { title: "Pricing call" });
      await drain(gateway((request) => [{ id: request.tasks[0].id, satisfied: true, note: "Priced it.", nextTask: "Send the quote" }]));
      const [offer] = await taskDoneOffers(mark, [taskId, "nope", taskId]);
      assert.equal(offer.taskId, taskId);
      assert.equal(offer.activityId, activity);
      assert.equal(offer.kind, "call");
      assert.equal(offer.note, "Priced it.");
      assert.equal(offer.nextTitle, "Send the quote");
      assert.equal(offer.activityTitle, "Pricing call");
      assert.deepEqual(await taskDoneOffers(mark, []), []);
      assert.deepEqual(await taskDoneOffers(mark, ["nope"]), []);
    });
  });

  describe("the queue", () => {
    it("makes no offers and queues nothing with no model configured", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      delete process.env.LLM_API_KEY;
      await log("call", { contactId: jane });
      assert.deepEqual(await queued(), []);
      await admin().query("insert into crm.task_done_queue (activity_id, reason) select id, 'created' from crm.activities where contact_id = $1", [jane]);
      const fake = gateway();
      const done = await drain(fake);
      assert.deepEqual([done.processed, done.offered, done.requests.length], [0, 0, 0]);
      assert.equal((await queued()).length, 1);
      assert.equal((await offersFor(taskId)).length, 0);
    });

    it("retries after a model failure with a delay, then gives the offer", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      await log("call", { contactId: jane });
      const failed = await drain(gateway(() => "fail"));
      assert.equal(failed.retried, 1);
      const row = (await admin().query<{ attempts: number; claimed_at: Date | null; wait: number }>("select attempts, claimed_at, extract(epoch from next_attempt_at - now())::int as wait from crm.task_done_queue")).rows[0];
      assert.equal(row.attempts, 1);
      assert.equal(row.claimed_at, null);
      assert.ok(row.wait > 0);
      assert.equal((await drain()).processed, 0);
      await admin().query("update crm.task_done_queue set next_attempt_at = now()");
      const done = await drain();
      assert.equal(done.offered, 1);
      assert.equal((await queued()).length, 0);
      assert.equal((await openOffers(taskId)).length, 1);
    });

    it("takes back a row whose worker went away and drops one that keeps failing", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      await log("call", { contactId: jane });
      await admin().query("update crm.task_done_queue set claimed_at = now() - interval '10 minutes', claim_token = gen_random_uuid(), attempts = 1");
      assert.equal((await drain()).offered, 1);
      assert.equal((await openOffers(taskId)).length, 1);

      await admin().query("delete from crm.task_done_queue");
      const stuck = await log("call", { contactId: jane }, { occurredAt: new Date(Date.now() - 1_000).toISOString() });
      await admin().query("delete from crm.task_done_queue");
      await admin().query("insert into crm.task_done_queue (activity_id, reason, attempts, claimed_at, claim_token) values ($1, 'created', 5, now() - interval '10 minutes', gen_random_uuid())", [stuck]);
      const done = await drain();
      assert.equal(done.processed, 0);
      assert.deepEqual(await queued(), []);

      await admin().query("insert into crm.task_done_queue (activity_id, reason, attempts) values ($1, 'created', 4)", [stuck]);
      assert.equal((await drain(gateway(() => "fail"))).retried, 1);
      assert.deepEqual(await queued(), []);
    });

    it("does not let a finished run delete a row someone else claimed", async () => {
      const { jane } = await scene();
      await log("call", { contactId: jane });
      const claimed = (await query<{ id: string; claim_token: string }>("select * from private.claim_task_done_queue(1)")).rows[0];
      await query("select private.finish_task_done_queue($1, $2)", [claimed.id, randomUUID()]);
      assert.equal((await queued()).length, 1);
      await query("select private.finish_task_done_queue($1, $2)", [claimed.id, claimed.claim_token]);
      assert.equal((await queued()).length, 0);
    });

    it("stops before a model call with too little time and finishes on the rerun without losing an attempt", async () => {
      const { company, jane } = await scene();
      const first = await task(mark, "Call Jane", { contactId: jane, companyId: company });
      const second = await task(sam, "Sam calls Jane", { contactId: jane, companyId: company });
      await log("call", { contactId: jane });
      const slow = gateway();
      const inner = slow.fetchImpl;
      slow.fetchImpl = async (input, init) => {
        const response = await inner(input, init);
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        return response;
      };
      const short = await drainTaskDoneQueue({ deadline: Date.now() + 12_000, fetchImpl: slow.fetchImpl });
      assert.equal(short.offered, 1);
      assert.equal(slow.requests.length, 1);
      const row = (await admin().query<{ attempts: number; claimed_at: Date | null }>("select attempts, claimed_at from crm.task_done_queue")).rows;
      assert.deepEqual(row.map((entry) => [entry.attempts, entry.claimed_at]), [[0, null]]);
      const done = await drain();
      assert.equal(done.requests.length, 1);
      assert.equal((await queued()).length, 0);
      assert.equal((await openOffers(first)).length + (await openOffers(second)).length, 2);
    });

    it("remembers who it already asked, so a rerun asks only the rest", async () => {
      const { company, jane } = await scene();
      await task(mark, "Call Jane", { contactId: jane, companyId: company });
      await task(sam, "Sam calls Jane", { contactId: jane, companyId: company });
      await log("call", { contactId: jane });
      let asked = 0;
      const slow = gateway((request) => request.tasks.map((entry) => ({ id: entry.id, satisfied: asked > 1, note: "Did it." })));
      const inner = slow.fetchImpl;
      slow.fetchImpl = async (input, init) => {
        asked += 1;
        const response = await inner(input, init);
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        return response;
      };
      const short = await drainTaskDoneQueue({ deadline: Date.now() + 12_000, fetchImpl: slow.fetchImpl });
      assert.equal(short.offered, 0);
      assert.equal(slow.requests.length, 1);
      const row = (await admin().query<{ attempts: number; asked: string[] }>("select attempts, asked from crm.task_done_queue")).rows[0];
      assert.equal(row.attempts, 0);
      assert.equal(row.asked.length, 1);
      const rest = gateway();
      const done = await drain(rest);
      assert.equal(rest.requests.length, 1);
      assert.notEqual(rest.requests[0].tasks[0].id, slow.requests[0].tasks[0].id);
      assert.equal(done.offered, 1);
      assert.equal((await queued()).length, 0);
    });

    it("keeps the assignees it already asked when the model fails partway, so the retry asks only the rest", async () => {
      const { company, jane } = await scene();
      await task(mark, "Call Jane", { contactId: jane, companyId: company });
      await task(sam, "Sam calls Jane", { contactId: jane, companyId: company });
      await log("call", { contactId: jane });
      let first: string | null = null;
      const failing = gateway((request) => {
        first ??= request.tasks[0].id;
        return request.tasks[0].id === first ? request.tasks.map((item) => ({ id: item.id, satisfied: true, note: "Did it." })) : "fail";
      });
      const openCount = async () => Number((await admin().query<{ count: string }>("select count(*) from crm.task_done_offers where state = 'offered'")).rows[0].count);
      const was = await openCount();
      const failed = await drain(failing);
      assert.equal(failed.retried, 1);
      assert.equal((await openCount()) - was, 1);
      const row = (await admin().query<{ asked: string[] }>("select asked from crm.task_done_queue")).rows[0];
      assert.equal(row.asked.length, 1);
      await admin().query("update crm.task_done_queue set next_attempt_at = now()");
      const rest = gateway();
      const done = await drain(rest);
      assert.equal(rest.requests.length, 1);
      assert.notEqual(rest.requests[0].tasks[0].id, first);
      assert.equal(done.offered, 1);
      assert.equal((await queued()).length, 0);
    });

    it("keeps the assignees it already asked when storing an offer fails", async () => {
      const { company, jane } = await scene();
      await task(mark, "Call Jane", { contactId: jane, companyId: company });
      await task(sam, "Sam calls Jane", { contactId: jane, companyId: company });
      const activity = await log("call", { contactId: jane });
      await admin().query(`create or replace function public.fail_second_offer() returns trigger language plpgsql as $$
        begin
          if (select count(*) from crm.task_done_offers where state = 'offered' and activity_id = new.activity_id) >= 1 then
            raise exception 'second offer fails';
          end if;
          return new;
        end; $$`);
      await admin().query("create trigger fail_second_offer before insert on crm.task_done_offers for each row execute function public.fail_second_offer()");
      try {
        const failed = await drain();
        assert.equal(failed.retried, 1);
      } finally {
        await admin().query("drop trigger fail_second_offer on crm.task_done_offers");
        await admin().query("drop function public.fail_second_offer()");
      }
      const row = (await admin().query<{ asked: string[] }>("select asked from crm.task_done_queue where activity_id = $1", [activity])).rows[0];
      assert.equal(row.asked.length, 1);
    });

    it("skips the model when nothing on the records is open", async () => {
      const { jane } = await scene();
      await log("call", { contactId: jane });
      const done = await drain();
      assert.equal(done.requests.length, 0);
      assert.equal(done.processed, 1);
    });
  });

  describe("closing from an offer", () => {
    async function offered(actor = mark, title = "Call Jane about pricing") {
      const { jane } = await scene(actor);
      const taskId = await task(actor, title, { contactId: jane });
      const activityId = await log("call", { contactId: jane }, { actor, body: "Agreed the price." });
      await drain(gateway((request) => request.tasks.map((item) => ({ id: item.id, satisfied: true, note: "Agreed the price." }))));
      return { jane, taskId, activityId };
    }

    const closing = (activityId: string, extra: Record<string, unknown> = {}) => ({
      outcomeId: randomUUID(),
      note: "Agreed the price.",
      kind: "call" as const,
      next: null,
      activityId,
      ...extra,
    });

    const activityCount = async (contactId: string) =>
      Number((await admin().query<{ count: string }>("select count(*) from crm.activities where contact_id = $1", [contactId])).rows[0].count);

    it("closes the task and the offer without a new activity, and keeps the note", async () => {
      const { jane, taskId, activityId } = await offered();
      const before = await activityCount(jane);
      const input = closing(activityId, { next: { title: "Send Jane the pilot terms", dueAt: null } });
      const saved = await completeTaskWithOutcome(mark, taskId, input);
      assert.equal(saved.replayed, false);
      assert.equal(saved.activityId, activityId);
      assert.ok(saved.task.completedAt);
      assert.ok(saved.next);
      assert.equal(await activityCount(jane), before);
      const outcome = (await admin().query<{ activity_id: string; note: string | null }>("select activity_id, note from crm.task_outcomes where id = $1", [input.outcomeId])).rows[0];
      assert.equal(outcome.activity_id, activityId);
      assert.equal(outcome.note, "Agreed the price.");
      const [offer] = await offersFor(taskId);
      assert.equal(offer.state, "closed");
      assert.equal(offer.decided_by, mark.userId);
      assert.deepEqual(await taskDoneOffers(mark, [taskId]), []);
    });

    it("replays the same outcome without changing anything", async () => {
      const { jane, taskId, activityId } = await offered();
      const input = closing(activityId);
      await completeTaskWithOutcome(mark, taskId, input);
      const before = await activityCount(jane);
      const again = await completeTaskWithOutcome(mark, taskId, input);
      assert.equal(again.replayed, true);
      assert.equal(again.activityId, activityId);
      assert.equal(await activityCount(jane), before);
      assert.equal((await offersFor(taskId)).length, 1);
      assert.equal(Number((await admin().query<{ count: string }>("select count(*) from crm.task_outcomes where task_id = $1", [taskId])).rows[0].count), 1);
    });

    it("keeps the link when no note or next task was typed", async () => {
      const { taskId, activityId } = await offered();
      await completeTaskWithOutcome(mark, taskId, closing(activityId, { note: "" }));
      const outcome = (await admin().query<{ activity_id: string; note: string | null }>("select activity_id, note from crm.task_outcomes where task_id = $1", [taskId])).rows[0];
      assert.equal(outcome.activity_id, activityId);
      assert.equal(outcome.note, null);
    });

    it("refuses a tagged person and leaves the offer open", async () => {
      const { taskId, activityId } = await offered();
      await withActor(mark, (db) => addTaskParticipantsInDb(db, mark, taskId, [priya.userId]));
      await assert.rejects(completeTaskWithOutcome(priya, taskId, closing(activityId)), (error: unknown) => error instanceof CrmError && error.status === 403);
      assert.equal((await openOffers(taskId)).length, 1);
      const open = (await admin().query<{ completed_at: Date | null }>("select completed_at from crm.tasks where id = $1", [taskId])).rows[0];
      assert.equal(open.completed_at, null);
    });

    it("refuses an activity that has no offer on the task and completes nothing", async () => {
      const first = await offered(mark, "Call Jane about the pilot");
      const second = await offered(mark, "Call Jane about the contract");
      for (const wrong of [second.activityId, randomUUID()]) {
        await assert.rejects(completeTaskWithOutcome(mark, first.taskId, closing(wrong)), (error: unknown) => error instanceof CrmError && error.status === 409);
      }
      await assert.rejects(completeTaskWithOutcome(mark, first.taskId, closing("not-an-id")), (error: unknown) => error instanceof CrmError && error.status === 400);
      const open = (await admin().query<{ completed_at: Date | null }>("select completed_at from crm.tasks where id = $1", [first.taskId])).rows[0];
      assert.equal(open.completed_at, null);
      assert.equal((await openOffers(first.taskId)).length, 1);
      assert.equal((await admin().query("select 1 from crm.task_outcomes where task_id = $1", [first.taskId])).rowCount, 0);
    });

    it("refuses an offer that was dismissed, already closed or whose activity was archived", async () => {
      const dismissed = await offered();
      const [dismissedOffer] = await openOffers(dismissed.taskId);
      await dismissTaskDoneOffer(mark, dismissedOffer.id);
      await assert.rejects(completeTaskWithOutcome(mark, dismissed.taskId, closing(dismissed.activityId)), (error: unknown) => error instanceof CrmError && error.status === 409);

      const closed = await offered();
      await completeTaskWithOutcome(mark, closed.taskId, closing(closed.activityId));
      await reopenTask(mark, closed.taskId);
      await assert.rejects(completeTaskWithOutcome(mark, closed.taskId, closing(closed.activityId)), (error: unknown) => error instanceof CrmError && error.status === 409);

      const archived = await offered();
      await archiveActivity(mark, archived.activityId, { operation: "archive", source: "web" });
      await assert.rejects(completeTaskWithOutcome(mark, archived.taskId, closing(archived.activityId)), (error: unknown) => error instanceof CrmError && error.status === 409);
    });

    it("reopens on Undo and leaves the offer closed", async () => {
      const { taskId, activityId } = await offered();
      await completeTaskWithOutcome(mark, taskId, closing(activityId));
      assert.deepEqual((await taskDoneNotes(mark, [taskId])).closedAfter[taskId]?.kind, "call");
      await reopenTask(mark, taskId);
      const open = (await admin().query<{ completed_at: Date | null }>("select completed_at from crm.tasks where id = $1", [taskId])).rows[0];
      assert.equal(open.completed_at, null);
      assert.equal((await offersFor(taskId))[0].state, "closed");
      const notes = await taskDoneNotes(mark, [taskId]);
      assert.deepEqual(notes.offers, {});
      assert.deepEqual(notes.closedAfter, {});
    });

    it("reads the reason on a closed task, with a link to the activity, for people who can see the task", async () => {
      const { jane, taskId, activityId } = await offered();
      await withActor(mark, (db) => addTaskParticipantsInDb(db, mark, taskId, [priya.userId]));
      await completeTaskWithOutcome(mark, taskId, closing(activityId));
      const mine = (await taskDoneNotes(mark, [taskId])).closedAfter[taskId];
      assert.equal(mine.kind, "call");
      assert.equal(mine.href, `/contacts/${jane}#activity-${activityId}`);
      assert.ok(mine.at);
      assert.equal((await taskDoneNotes(priya, [taskId])).closedAfter[taskId]?.kind, "call");
      assert.deepEqual((await taskDoneNotes(sam, [taskId])).closedAfter, {});
    });

    it("gives the open offer with a link to the activity", async () => {
      const { jane, taskId, activityId } = await offered();
      const notes = await taskDoneNotes(mark, [taskId]);
      assert.equal(notes.offers[taskId].href, `/contacts/${jane}#activity-${activityId}`);
    });

    it("closes an offer on a task that was already completed, and shows no reason after a plain Done once reopened", async () => {
      const { taskId, activityId } = await offered();
      await completeTask(mark, taskId);
      const saved = await completeTaskWithOutcome(mark, taskId, closing(activityId));
      assert.equal(saved.replayed, false);
      assert.equal((await offersFor(taskId))[0].state, "closed");
      assert.equal((await taskDoneNotes(mark, [taskId])).closedAfter[taskId]?.kind, "call");
      await reopenTask(mark, taskId);
      await completeTaskWithOutcome(mark, taskId, { outcomeId: randomUUID(), note: "", kind: null, next: null });
      assert.deepEqual((await taskDoneNotes(mark, [taskId])).closedAfter, {});
    });

    it("names the kind in the message when the offer is gone", async () => {
      const { taskId, activityId } = await offered();
      const [offer] = await openOffers(taskId);
      await dismissTaskDoneOffer(mark, offer.id);
      await assert.rejects(
        completeTaskWithOutcome(mark, taskId, closing(activityId)),
        (error: unknown) => error instanceof CrmError && error.message === "Couldn't link it to the call. Save again to log your note instead.",
      );
    });

    it("gives the API and assistant callers the same refusal whether the offer went before or during the close", async () => {
      const gone = (error: unknown) =>
        error instanceof CrmError && error.status === 409 && error.message === "That task has no open Looks done offer for that activity." && error.details?.field === "activityId";
      const before = await offered();
      const [early] = await openOffers(before.taskId);
      await dismissTaskDoneOffer(mark, early.id);
      await assert.rejects(closeTaskFromOffer(mark, before.taskId, { activityId: before.activityId }), gone);

      const during = await offered();
      const [late] = await openOffers(during.taskId);
      const holder = await getAdminPool().connect();
      try {
        await holder.query("begin");
        await holder.query("update crm.task_done_offers set state = 'dismissed', decided_at = now() where id = $1", [late.id]);
        const closing = closeTaskFromOffer(mark, during.taskId, { activityId: during.activityId });
        const outcome = assert.rejects(closing, gone);
        await new Promise((resolve) => setTimeout(resolve, 800));
        await holder.query("commit");
        await outcome;
      } finally {
        holder.release();
      }
      const open = (await admin().query<{ completed_at: Date | null }>("select completed_at from crm.tasks where id = $1", [during.taskId])).rows[0];
      assert.equal(open.completed_at, null);
    });

    it("shows no reason for a task done the usual way", async () => {
      const { jane } = await scene();
      const taskId = await task(mark, "Call Jane", { contactId: jane });
      await completeTaskWithOutcome(mark, taskId, { outcomeId: randomUUID(), note: "Spoke to her.", kind: "call", next: null });
      assert.deepEqual((await taskDoneNotes(mark, [taskId])).closedAfter, {});
    });
  });
});
