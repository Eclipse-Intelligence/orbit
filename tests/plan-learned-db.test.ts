import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { saveMailbox } from "@/lib/crm/inbox";
import { buildPlan, scheduleTasks } from "@/lib/crm/plan-schedule";
import { getLearnedTimes, learnedSpreadInDb, resetLearnedTimes } from "@/lib/crm/schedule-preferences";
import { scopesForRole } from "@/lib/crm/scopes";
import { wallInstant } from "@/lib/crm/task-time";
import { completeTask, createTask, placeTask, updateTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { addWorkingDays, dayKeyAt } from "@/lib/crm/working-days";
import { createWorkspace, workspaceActors } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

delete process.env.TYPESAFE_API_KEY;
delete process.env.LLM_API_KEY;

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

const DAY_MS = 86_400_000;
const today = dayKeyAt(new Date());
const workday = (after: number) => addWorkingDays(today, after);
const at = (day: string, hour: number, minute = 0) => new Date(wallInstant(day, hour, minute)).toISOString();
const local = (day: string, hour: number, minute = 0) => `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
const web = (operation: string) => ({ provenance: { operation, source: "web" } });

describe("Learned times", () => {
  let mark: UserActor;
  let personal: UserActor;
  let sam: UserActor;
  let calendarId: string;
  let connectionId: string;

  before(async () => {
    await resetDatabase();
    mark = { ...(await createUser("mark@learned.test", "Mark Ridgeon")), workspaceName: "Eclipse" };
    const created = await createWorkspace(mark, { name: "Mark Ridgeon" });
    personal = { ...mark, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    sam = { ...(await createUser("sam@learned.test", "Sam Okafor")), workspaceName: "Sam's" };
    await saveMailbox(mark, { email: "mark@learned.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const admin = getAdminPool();
    connectionId = (await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [mark.userId])).rows[0].id;
    calendarId = (
      await admin.query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm)
         values ($1, $2, $3, 'cal-learned', 'Calendar', '#4f9be8', true, true, true) returning id`,
        [mark.workspaceId, mark.userId, connectionId],
      )
    ).rows[0].id;
  });

  async function spread(now = Date.now()) {
    const actors = await workspaceActors(mark);
    return withActor(mark, (db) => learnedSpreadInDb(db, mark, actors, now, { fresh: true }));
  }

  async function newCall(actor: UserActor, title: string, day = workday(2)) {
    return (await createTask(actor, { title, dueDate: day })).body.task;
  }

  async function event(subject: string, startsAt: string, options: { contactIds?: string[]; organizer?: string | null; response?: string | null } = {}) {
    await getAdminPool().query(
      `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, show_as, contact_ids, organizer, response_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'busy', $9, $10, $11)`,
      [
        mark.workspaceId,
        calendarId,
        connectionId,
        mark.userId,
        `${subject}-${startsAt}`,
        subject,
        startsAt,
        new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
        options.contactIds ?? [],
        options.organizer === null ? null : JSON.stringify({ name: "Organiser", email: options.organizer ?? "mark@learned.test" }),
        options.response ?? null,
      ],
    );
  }

  it("keeps preferences personal, with RLS forced and no agent access", async () => {
    await getLearnedTimes(mark);
    assert.equal((await queryAsUser(mark.userId, "select user_id from crm.schedule_preferences where user_id = $1", [mark.userId])).length, 1);
    assert.deepEqual(await queryAsUser(sam.userId, "select user_id from crm.schedule_preferences where user_id = $1", [mark.userId]), []);
    await assert.rejects(queryAsUser(sam.userId, "insert into crm.schedule_preferences (user_id) values ($1)", [mark.userId]));
    assert.deepEqual(await queryAsUser(sam.userId, "update crm.schedule_preferences set reset_at = now() where user_id = $1 returning user_id", [mark.userId]), []);
    const forced = await getAdminPool().query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'crm.schedule_preferences'::regclass",
    );
    assert.deepEqual(forced.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    const grants = await getAdminPool().query<{ grantee: string; privilege_type: string }>(
      "select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'crm' and table_name = 'schedule_preferences' and grantee in ('anon', 'authenticated', 'crm_agent') order by grantee, privilege_type",
    );
    assert.deepEqual(grants.rows, [
      { grantee: "authenticated", privilege_type: "INSERT" },
      { grantee: "authenticated", privilege_type: "SELECT" },
      { grantee: "authenticated", privilege_type: "UPDATE" },
    ]);
  });

  it("counts times placed by hand on the web in every workspace, and never Plan, agents, sync or the assistant", async () => {
    const day = workday(2);
    const dragged = await newCall(mark, "Call Jane Cooper");
    await placeTask(mark, dragged.id, { at: at(day, 15), durationMinutes: 15 }, web("drag_task"));
    await placeTask(mark, dragged.id, { at: at(day, 15, 30), durationMinutes: 15 }, web("drag_task"));
    const typed = await newCall(mark, "Ring Daniel Shaw");
    await updateTask(mark, typed.id, { dueAt: at(day, 15) }, web("update_task"));
    await createTask(mark, { title: "Call Emma Lowe", dueAt: at(day, 15) }, web("create_task"));
    const elsewhere = await newCall(personal, "Call the accountant");
    await placeTask(personal, elsewhere.id, { at: at(day, 15), durationMinutes: 15 }, web("drag_task"));
    const email = (await createTask(mark, { title: "Email Raj the numbers", dueDate: day })).body.task;
    await updateTask(mark, email.id, { dueAt: at(day, 14) }, web("update_task"));
    await updateTask(mark, email.id, { dueDate: day }, web("update_task"));

    const planned = await newCall(mark, "Call Lucy Hart", day);
    await scheduleTasks(mark, [{ taskId: planned.id, at: at(day, 11) }], { mode: "plan", provenance: { operation: "plan_tasks", source: "web" } });
    const assisted = await newCall(mark, "Call Ben Archer", day);
    await scheduleTasks(mark, [{ taskId: assisted.id, at: at(day, 11, 30) }], { mode: "agent", provenance: { operation: "schedule_tasks", source: "assistant" } });
    const chatted = await newCall(mark, "Call Amira Khan", day);
    await updateTask(mark, chatted.id, { dueAt: at(day, 9) }, { provenance: { operation: "update_task", source: "assistant" } });
    const synced = await newCall(mark, "Call Hannah Price", day);
    await updateTask(mark, synced.id, { dueAt: at(day, 9) }, { provenance: { operation: "calendar_sync", source: "microsoft" } });
    const { actor: agent } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"]);
    const byAgent = await newCall(mark, "Call Olivia Grant", day);
    await updateTask(agent, byAgent.id, { dueAt: at(day, 9) }, web("update_task"));
    const viaMcp = await newCall(mark, "Call Noah Patel", day);
    const server = createCrmMcpServer(mark);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "learned-check", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const result = await client.callTool({ name: "update_next_action", arguments: { id: viaMcp.id, dueAt: local(day, 9), provenanceSource: "web" } });
      assert.equal(result.isError, undefined);
    } finally {
      await client.close();
      await server.close();
    }
    const source = await getAdminPool().query<{ source: string | null }>(
      "select source from crm.audit_events where entity_id = $1 and operation = 'update_task'",
      [viaMcp.id],
    );
    assert.deepEqual(source.rows, [{ source: null }], "an agent can't claim the web as its source");

    const learned = await spread();
    assert.equal(learned.call.placed, 4, "the drag, the typed time and the created call here, and the drag in the other workspace");
    assert.equal(learned.call.slots.reduce((total, value) => total + value, 0), 16);
    const slot = (iso: string) => {
      const date = new Date(iso);
      const wall = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const part = (type: string) => wall.find((item) => item.type === type)!.value;
      return days.indexOf(part("weekday")) * 48 + Number(part("hour")) * 2 + (Number(part("minute")) >= 30 ? 1 : 0);
    };
    assert.equal(learned.call.slots[slot(at(day, 15, 30))], 4, "only the last drag of a task counts");
    assert.equal(learned.call.slots[slot(at(day, 15))], 12);
    assert.equal(learned.email.placed, 1, "a time given by hand still counts after the time is removed");
    assert.equal(learned.email.slots[slot(at(day, 14))], 4);
  });

  it("counts meetings booked with contacts and tasks ticked off, more lightly", async () => {
    const contact = (await createContact(mark, { firstName: "Daniel", lastName: "Hughes", email: "daniel@kestrel.test" })).body.contact;
    const yesterday = at(addWorkingDays(today, -1), 10);
    await event("Kestrel intro", yesterday, { contactIds: [contact.id] });
    await event("Kestrel booked in Orbit", at(addWorkingDays(today, -2), 10), { contactIds: [contact.id], organizer: null });
    await event("Their meeting", yesterday, { contactIds: [contact.id], organizer: "daniel@kestrel.test" });
    await event("Team standup", yesterday);
    await event("Declined", yesterday, { contactIds: [contact.id], response: "declined" });
    await event("Long ago", new Date(Date.now() - 100 * DAY_MS).toISOString(), { contactIds: [contact.id] });
    await event("Not yet", new Date(Date.now() + 200 * DAY_MS).toISOString(), { contactIds: [contact.id] });
    const ticked = (await createTask(mark, { title: "Tidy the Brightwell notes", dueDate: workday(1) })).body.task;
    await completeTask(mark, ticked.id, web("complete_task"));
    const assistantDone = (await createTask(mark, { title: "Tidy the Halden notes", dueDate: workday(1) })).body.task;
    await completeTask(mark, assistantDone.id, { provenance: { operation: "complete_task", source: "assistant" } });
    const learned = await spread();
    assert.equal(learned.call.booked, 2, "meetings Mark organised with contacts, in the past 90 days");
    assert.equal(learned.other.ticked, 1, "only ticks on the web");
    assert.equal(learned.other.slots.reduce((total, value) => total + value, 0), 1, "a tick weighs least");
  });

  it("looks back 90 days across workspaces, and Reset starts from scratch", async () => {
    const later = await spread(Date.now() + 91 * DAY_MS);
    assert.deepEqual([later.call.placed, later.call.booked, later.email.placed, later.other.ticked], [0, 0, 0, 0], "nothing older than 90 days counts");
    const views = await getLearnedTimes(mark);
    assert.equal(views.kinds.find((view) => view.kind === "call")?.caption, "Not enough yet (6 of about 10). Late morning until then.");
    await resetLearnedTimes(mark);
    const reset = await spread();
    assert.deepEqual([reset.call.placed, reset.call.booked, reset.email.placed, reset.other.ticked], [0, 0, 0, 0]);
    const fresh = (await getLearnedTimes(personal)).kinds.find((view) => view.kind === "call");
    assert.equal(fresh?.caption, "Not enough yet (0 of about 10). Late morning until then.", "Reset is the same in every workspace");
    assert.ok((await getLearnedTimes(mark)).resetAt);
  });

  it("plans calls at the learned time once there are about ten, and says so", async () => {
    const day = workday(3);
    const placeCalls = async (count: number) => {
      for (let index = 0; index < count; index += 1) {
        const call = await newCall(index % 2 ? personal : mark, `Call client ${index} ${Math.random().toString(36).slice(2, 6)}`, workday(4));
        await placeTask(index % 2 ? personal : mark, call.id, { at: at(workday(4), 15), durationMinutes: 15 }, web("drag_task"));
      }
    };
    await placeCalls(9);
    const target = await newCall(mark, "Call Jane Cooper again", day);
    let now = Date.now();
    const early = await buildPlan(mark, { ai: false, now });
    assert.equal(early.placed.find((entry) => entry.taskId === target.id)?.at, at(day, 10, 30), "late morning until learned");
    assert.match(early.reason ?? "", /Calls late morning/);
    const cached = await getAdminPool().query<{ learned_at: Date }>("select learned_at from crm.schedule_preferences where user_id = $1", [mark.userId]);
    assert.ok(cached.rows[0]?.learned_at, "Plan caches what it learned");
    await placeCalls(1);
    const stale = await buildPlan(mark, { ai: false, now });
    assert.equal(stale.placed.find((entry) => entry.taskId === target.id)?.at, at(day, 10, 30), "a preview rerun reads the cache");
    now += 11 * 60_000;
    const learned = await buildPlan(mark, { ai: false, now });
    assert.equal(learned.placed.find((entry) => entry.taskId === target.id)?.at, at(day, 14, 30), "the learned afternoon, across both workspaces");
    assert.match(learned.reason ?? "", /^Calls in the afternoon, as you usually do\./);
  });
});
