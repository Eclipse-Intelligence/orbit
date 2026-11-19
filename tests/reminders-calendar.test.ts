import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { listSlots } from "@/lib/booking/book";
import { loadBusy, saveBookingPage, type BookingPageInput } from "@/lib/booking/pages";
import { DEFAULT_WEEKLY_HOURS } from "@/lib/booking/rules";
import { CrmError } from "@/lib/crm/errors";
import { buildPlan, readPlanContext, scheduleTasks } from "@/lib/crm/plan-schedule";
import { completeReminder, createReminder, listCalendarReminders, listDayReminders, PEOPLE_ONLY, type Reminder } from "@/lib/crm/reminders";
import { SCOPES } from "@/lib/crm/scopes";
import { wallInstant } from "@/lib/crm/task-time";
import { createTask } from "@/lib/crm/tasks";
import type { Task, UserActor } from "@/lib/crm/types";
import { addWorkingDays, dayKeyAt } from "@/lib/crm/working-days";
import { saveMailbox } from "@/lib/crm/inbox";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  dayReminderRows,
  isReminderTaskId,
  movedReminder,
  placeReminders,
  reminderBusy,
  reminderIdOf,
  reminderTaskId,
  settledTicks,
  showsDayReminders,
  withoutTicked,
} from "@/lib/reminder-calendar";
import { clashWith, taskBlocks } from "@/lib/task-blocks";
import { createAgent, createUser, queryAsUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

delete process.env.TYPESAFE_API_KEY;
delete process.env.LLM_API_KEY;

const MIGRATION = "20270221100000_reminder_booking_busy.sql";
const VIEWER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const WEEK = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"];
const TODAY = "2026-11-19";

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

let counter = 0;

function reminder(overrides: Partial<Reminder>): Reminder {
  counter += 1;
  const id = overrides.id ?? `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  return {
    id,
    title: "Bins out",
    dueOn: null,
    dueAt: null,
    time: null,
    blocksTime: false,
    durationMinutes: 15,
    repeat: null,
    repeatText: null,
    completedAt: null,
    repeatOf: null,
    movedTo: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

function timed(title: string, day: string, clock: string, extra: Partial<Reminder> = {}) {
  const [hour, minute] = clock.split(":").map(Number);
  return reminder({ title, dueOn: day, dueAt: new Date(wallInstant(day, hour, minute)).toISOString(), time: clock, ...extra });
}

function place(list: Reminder[], days = WEEK, today = TODAY) {
  return placeReminders(list, { days, today, viewerId: VIEWER, workspaceId: WORKSPACE });
}

function timedTask(title: string, dueAt: string, durationMinutes = 30): Task {
  return {
    id: "00000000-0000-4000-8000-0000000000aa",
    workspaceId: WORKSPACE,
    title,
    description: null,
    dueAt,
    dueDate: dueAt.slice(0, 10),
    dueHasTime: true,
    durationMinutes,
    scheduledBy: "person",
    remindMinutes: null,
    completedAt: null,
    priority: "normal",
    ownerId: VIEWER,
    ownerName: null,
    companyId: null,
    companyName: null,
    companyPhone: null,
    contactId: null,
    contactCompanyId: null,
    contactName: null,
    contactFirstName: null,
    contactLastName: null,
    contactJobTitle: null,
    contactPhone: null,
    contactEmail: null,
    opportunityId: null,
    opportunityName: null,
    createdByUserId: VIEWER,
    createdByAgentId: null,
    archivedAt: null,
    clickupTaskId: null,
    clickupListId: null,
    clickupUrl: null,
    clickupError: null,
    inOutlook: false,
    mailThreadKey: null,
    mailThread: null,
    seriesId: null,
    occursOn: null,
    repeat: null,
    docIds: [],
    docs: [],
    canLinkDocs: false,
    createdAt: dueAt,
    updatedAt: dueAt,
  };
}

describe("placing reminders on the calendar", () => {
  it("puts overdue reminders on today, never on their old day, and only when today is shown", () => {
    const late = reminder({ title: "Renew car tax", dueOn: "2026-11-17" });
    const lateTimed = timed("Call the garage", "2026-11-16", "10:00");
    const lateBlock = timed("Gym", "2026-11-18", "07:00", { blocksTime: true, durationMinutes: 60 });
    const placed = place([late, lateTimed, lateBlock]);
    assert.deepEqual(
      placed.chips.map((chip) => [chip.reminder.title, chip.day, chip.overdue]),
      [
        ["Call the garage", TODAY, true],
        ["Renew car tax", TODAY, true],
        ["Gym", TODAY, true],
      ],
    );
    assert.deepEqual(placed.markers, []);
    assert.deepEqual(placed.blocks, []);
    const nextWeek = place([late], ["2026-11-23", "2026-11-24"]);
    assert.deepEqual(nextWeek.chips, [], "overdue ones show on today only");
    const lastWeek = place([late], ["2026-11-16", "2026-11-17"]);
    assert.deepEqual(lastWeek.chips, [], "never on the day it was due");
  });

  it("puts date-only reminders in the all-day row, overdue first", () => {
    const placed = place([reminder({ title: "Bins out", dueOn: TODAY }), reminder({ title: "Renew car tax", dueOn: "2026-11-10" }), reminder({ title: "Pay rent", dueOn: "2026-11-21" })]);
    assert.deepEqual(
      placed.chips.map((chip) => [chip.reminder.title, chip.day, chip.overdue]),
      [
        ["Renew car tax", TODAY, true],
        ["Bins out", TODAY, false],
        ["Pay rent", "2026-11-21", false],
      ],
    );
  });

  it("draws a timed reminder as a marker at its London minute, and a Block time one as a block", () => {
    const marker = timed("Washing machine repair", "2026-11-20", "10:20");
    const block = timed("Dentist", "2026-11-21", "09:00", { blocksTime: true, durationMinutes: 45 });
    const placed = place([marker, block]);
    assert.deepEqual(placed.markers.map((item) => [item.reminder.title, item.day, item.minutes]), [["Washing machine repair", "2026-11-20", 620]]);
    assert.equal(placed.blocks.length, 1);
    const [shown] = placed.blocks;
    assert.equal(shown.title, "Dentist");
    assert.equal(shown.startsAt, new Date(wallInstant("2026-11-21", 9, 0)).toISOString());
    assert.equal(shown.endsAt, new Date(wallInstant("2026-11-21", 9, 45)).toISOString());
    assert.equal(shown.task.id, reminderTaskId(block.id));
    assert.equal(shown.task.dueHasTime, true);
    assert.equal(shown.reminder?.id, block.id);
    assert.ok(isReminderTaskId(shown.task.id));
    assert.equal(reminderIdOf(shown.task.id), block.id);
    assert.equal(reminderIdOf("task-id"), null);
    assert.deepEqual(place([marker, block], ["2026-11-19"]).markers, [], "outside the shown days nothing is drawn");
  });

  it("leaves done reminders and undated ones off the calendar", () => {
    const placed = place([reminder({ dueOn: TODAY, completedAt: "2026-11-19T08:00:00.000Z" }), reminder({ title: "Someday" })]);
    assert.deepEqual(placed, { chips: [], markers: [], blocks: [] });
  });

  it("keeps a London day across the clock change", () => {
    const late = timed("Late call", "2026-10-25", "23:30");
    const placed = place([late], ["2026-10-24", "2026-10-25", "2026-10-26"], "2026-10-24");
    assert.deepEqual(placed.markers.map((item) => [item.day, item.minutes]), [["2026-10-25", 1410]]);
  });

  it("moves a dragged block to its new time and day", () => {
    const block = timed("Dentist", "2026-11-21", "09:00", { blocksTime: true, durationMinutes: 45 });
    const at = new Date(wallInstant("2026-11-20", 14, 0)).toISOString();
    const moved = movedReminder(block, at, 60);
    assert.equal(moved.dueAt, at);
    assert.equal(moved.dueOn, "2026-11-20");
    assert.equal(moved.durationMinutes, 60);
    assert.deepEqual(place([moved]).blocks.map((item) => [item.startsAt, item.durationMinutes]), [[at, 60]]);
  });

  it("hides a ticked reminder until the server moves or completes it", () => {
    const repeating = reminder({ title: "Water plants", dueOn: TODAY });
    const held = { [repeating.id]: { snapshot: repeating, doneId: "done-copy" } };
    assert.deepEqual(withoutTicked([repeating], held), []);
    const movedOn = { ...repeating, dueOn: "2026-11-20" };
    assert.deepEqual(withoutTicked([movedOn], held), [movedOn]);
    assert.equal(settledTicks(held, [repeating]), held, "still waiting for the server");
    assert.deepEqual(settledTicks(held, [movedOn]), {}, "settled once the reminder moved");
    assert.deepEqual(settledTicks(held, []), {}, "settled once it left the list");
    const pending = { [repeating.id]: { snapshot: repeating, doneId: null } };
    assert.equal(settledTicks(pending, []), pending, "a tick in flight stays hidden");
  });
});

describe("busy time from reminders", () => {
  const marker = timed("Washing machine repair", "2026-11-20", "10:00");
  const block = timed("Dentist", "2026-11-20", "14:00", { blocksTime: true, durationMinutes: 60 });
  const done = timed("Old block", "2026-11-20", "16:00", { blocksTime: true, durationMinutes: 60, completedAt: "2026-11-19T09:00:00.000Z" });

  it("counts open Block time reminders and never markers or done ones", () => {
    const busy = reminderBusy([marker, block, done]);
    assert.deepEqual(busy, [
      { subject: "Dentist", startsAt: block.dueAt, endsAt: new Date(wallInstant("2026-11-20", 15, 0)).toISOString(), isAllDay: false, showAs: "busy" },
    ]);
  });

  it("flags a task block that clashes with a Block time reminder, and not one under a marker", () => {
    const busy = reminderBusy([marker, block]);
    const underMarker = taskBlocks([timedTask("Call Jane", marker.dueAt!)], { viewerId: VIEWER, now: Date.parse("2026-11-19T09:00:00Z"), meetings: busy });
    assert.equal(underMarker[0].clash, null);
    const underBlock = taskBlocks([timedTask("Call Jane", new Date(wallInstant("2026-11-20", 14, 30)).toISOString())], { viewerId: VIEWER, now: Date.parse("2026-11-19T09:00:00Z"), meetings: busy });
    assert.equal(underBlock[0].clash, "Dentist");
    assert.equal(clashWith(Date.parse(marker.dueAt!), Date.parse(marker.dueAt!) + 15 * 60_000, busy), null);
  });
});

describe("the daily note's Reminders group", () => {
  const owner = { kind: "daily", dailyDate: TODAY, owner: { id: VIEWER } };

  it("shows only on a daily note the viewer owns", () => {
    assert.equal(showsDayReminders(owner, VIEWER), true);
    assert.equal(showsDayReminders(owner, "someone-else"), false, "a shared daily note shows no reminders to others");
    assert.equal(showsDayReminders(owner, null), false);
    assert.equal(showsDayReminders({ ...owner, kind: "note" }, VIEWER), false);
    assert.equal(showsDayReminders({ ...owner, dailyDate: null }, VIEWER), false);
  });

  it("lists the day's reminders, overdue ones on today's note only, then those done that day crossed out", () => {
    const bins = reminder({ title: "Bins out", dueOn: TODAY });
    const washer = timed("Washing machine repair", TODAY, "10:00");
    const late = reminder({ title: "Renew car tax", dueOn: "2026-11-12" });
    const tomorrow = reminder({ title: "Pay rent", dueOn: "2026-11-20" });
    const doneToday = timed("Dentist", TODAY, "08:00", { completedAt: "2026-11-19T08:30:00.000Z" });
    const list = [washer, bins, late, tomorrow, doneToday];
    assert.deepEqual(
      dayReminderRows(list, {}, TODAY, TODAY).map((row) => [row.reminder.title, row.done, row.overdue]),
      [
        ["Renew car tax", false, true],
        ["Bins out", false, false],
        ["Washing machine repair", false, false],
        ["Dentist", true, false],
      ],
    );
    assert.deepEqual(
      dayReminderRows([reminder({ title: "Pay rent", dueOn: "2026-11-20" }), late], {}, "2026-11-20", TODAY).map((row) => row.reminder.title),
      ["Pay rent"],
      "a future note has no overdue ones",
    );
    assert.deepEqual(dayReminderRows([late, bins], {}, "2026-11-18", TODAY).map((row) => row.reminder.title), [], "nor does a past one");
  });

  it("keeps a ticked reminder crossed out in place and hides its done copy", () => {
    const water = reminder({ title: "Water plants", dueOn: TODAY });
    const copy = reminder({ title: "Water plants", dueOn: TODAY, completedAt: "2026-11-19T09:00:00.000Z", repeatOf: water.id });
    const movedOn = { ...water, dueOn: "2026-11-20" };
    const held = { [water.id]: { snapshot: water, doneId: copy.id } };
    const rows = dayReminderRows([movedOn, copy], held, TODAY, TODAY);
    assert.deepEqual(rows.map((row) => [row.key, row.done, row.held]), [[`ticked:${water.id}`, true, true]]);
    const plain = reminder({ title: "Bins out", dueOn: TODAY });
    const plainDone = { ...plain, completedAt: "2026-11-19T09:00:00.000Z" };
    assert.deepEqual(
      dayReminderRows([plainDone], { [plain.id]: { snapshot: plain, doneId: plain.id } }, TODAY, TODAY).map((row) => row.key),
      [`ticked:${plain.id}`],
    );
  });
});

describe("reminders for Calendar and the daily note, from the database", () => {
  let mark: UserActor;
  let sam: UserActor;
  let samHere: UserActor;
  const now = Date.parse("2027-01-15T12:00:00Z");
  const day = "2027-01-15";

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark-cal@orbit.test", "Mark Ridgeon");
    sam = await createUser("sam-cal@orbit.test", "Sam Teammate");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [mark.workspaceId, sam.userId]);
    samHere = { ...sam, workspaceId: mark.workspaceId, role: "admin" };
  });
  useServerlessPool();

  it("lists the viewer's open reminders in the range plus overdue ones, and nobody else's", async () => {
    const make = (actor: UserActor, title: string, input: Record<string, unknown>) => createReminder(actor, { title, ...input }, { now: now - 40 * 86_400_000 });
    await make(mark, "In range", { dueOn: "2027-01-18" });
    await make(mark, "Overdue", { dueOn: "2027-01-02" });
    await make(mark, "Later", { dueOn: "2027-02-20" });
    await make(mark, "No date", {});
    const done = (await make(mark, "Done", { dueOn: "2027-01-19" })).reminder;
    await completeReminder(mark, done.id, {}, { now });
    await make(sam, "Sam's", { dueOn: "2027-01-18" });
    const listed = await listCalendarReminders(mark, { from: "2027-01-18", to: "2027-01-24" }, { now });
    assert.deepEqual(listed.reminders.map((item) => item.title), ["Overdue", "In range"]);
    const asAdmin = await listCalendarReminders(samHere, { from: "2027-01-18", to: "2027-01-24" }, { now });
    assert.deepEqual(asAdmin.reminders.map((item) => item.title), ["Sam's"], "an admin in Mark's workspace sees only their own");
    const owner = await listCalendarReminders({ ...mark, role: "owner" }, { from: "2027-01-18", to: "2027-01-24" }, { now });
    assert.ok(!owner.reminders.some((item) => item.title === "Sam's"), "an owner never sees a member's");
  });

  it("refuses agent tokens, even with admin, and bad ranges", async () => {
    const admin = (await createAgent(mark.workspaceId, [...SCOPES], "Admin agent")).actor;
    await assert.rejects(listCalendarReminders(admin, { from: "2027-01-18", to: "2027-01-24" }), (error: unknown) => error instanceof CrmError && error.message === PEOPLE_ONLY);
    await assert.rejects(listDayReminders(admin, "2027-01-18"), (error: unknown) => error instanceof CrmError && error.message === PEOPLE_ONLY);
    await assert.rejects(listCalendarReminders(mark, { from: "2027-01-24", to: "2027-01-18" }), CrmError);
    await assert.rejects(listCalendarReminders(mark, { from: "2027-01-01", to: "2027-06-01" }), CrmError);
    await assert.rejects(listDayReminders(mark, "tomorrow"), CrmError);
  });

  it("lists a day's reminders with those done that day, and overdue ones only for today", async () => {
    const make = (actor: UserActor, title: string, input: Record<string, unknown>) => createReminder(actor, { title, ...input }, { now: now - 10 * 86_400_000 });
    await make(mark, "Today's", { dueOn: day });
    const doneToday = (await make(mark, "Done this morning", { dueOn: "2027-01-14" })).reminder;
    await getAdminPool().query("update crm.reminders set completed_at = '2027-01-15T09:00:00Z' where id = $1", [doneToday.id]);
    const doneEarlier = (await make(mark, "Done last week", { dueOn: day })).reminder;
    await getAdminPool().query("update crm.reminders set completed_at = '2027-01-08T09:00:00Z' where id = $1", [doneEarlier.id]);
    const lateNight = (await make(mark, "Done late in London", { dueOn: "2027-01-16" })).reminder;
    await getAdminPool().query("update crm.reminders set completed_at = '2027-01-15T23:30:00Z' where id = $1", [lateNight.id]);
    await make(sam, "Sam's today", { dueOn: day });
    const today = await listDayReminders(mark, day, { now });
    assert.deepEqual(today.reminders.map((item) => item.title).sort(), ["Done late in London", "Done this morning", "Overdue", "Today's"].sort());
    const tomorrow = await listDayReminders(mark, "2027-01-16", { now });
    assert.ok(!tomorrow.reminders.some((item) => item.title === "Overdue"));
    const samsOwn = await listDayReminders(samHere, day, { now });
    assert.deepEqual(samsOwn.reminders.map((item) => item.title), ["Sam's today"], "opening Mark's shared note, Sam's rail reads only Sam's");
    assert.deepEqual(await queryAsUser(sam.userId, "select title from crm.reminders where user_id = $1", [mark.userId]), []);
  });
});

describe("Plan and clash checks count Block time reminders", () => {
  let mark: UserActor;
  let sam: UserActor;
  const today = dayKeyAt(new Date());
  const target = addWorkingDays(today, 4);
  const at = (hour: number, minute = 0) => new Date(wallInstant(target, hour, minute)).toISOString();
  const local = (hour: number, minute = 0) => `${target}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark-plan-rem@orbit.test", "Mark Ridgeon");
    sam = await createUser("sam-plan-rem@orbit.test", "Sam Teammate");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [mark.workspaceId, sam.userId]);
  });

  it("plans around a Block time reminder, ignores markers and other people's reminders", async () => {
    const task = (await createTask(mark, { title: "Write the board pack", dueDate: target })).body.task;
    const first = (await buildPlan(mark, { ai: false })).placed.find((entry) => entry.taskId === task.id);
    assert.ok(first, "Plan places the task");
    const start = Date.parse(first.at);
    await createReminder(mark, { title: "Look at the boiler", dueAt: new Date(start).toISOString() });
    await createReminder({ ...sam, workspaceId: mark.workspaceId, role: "admin" }, { title: "Sam's block", dueAt: new Date(start).toISOString(), blocksTime: true, durationMinutes: 120 });
    const withMarker = (await buildPlan(mark, { ai: false })).placed.find((entry) => entry.taskId === task.id);
    assert.equal(withMarker?.at, first.at, "a marker and a teammate's block take no time");
    await createReminder(mark, { title: "Dentist", dueAt: new Date(start).toISOString(), blocksTime: true, durationMinutes: 60 });
    const context = await readPlanContext(mark, Date.now(), { store: false });
    assert.deepEqual(context.reminders.map((item) => item.title), ["Dentist"]);
    const moved = (await buildPlan(mark, { ai: false })).placed.find((entry) => entry.taskId === task.id);
    assert.ok(moved);
    const end = Date.parse(moved.at) + moved.durationMinutes * 60_000;
    assert.ok(end <= start || Date.parse(moved.at) >= start + 60 * 60_000, `Plan put the task at ${moved.at}, inside the Block time reminder`);
  });

  it("refuses an agent's block over a Block time reminder but not over a marker", async () => {
    await createReminder(mark, { title: "Physio", dueAt: at(11), blocksTime: true, durationMinutes: 60 });
    await createReminder(mark, { title: "Call mum", dueAt: at(15) });
    const task = (await createTask(mark, { title: "Ring Ashby Freight", dueDate: target })).body.task;
    await assert.rejects(
      scheduleTasks(mark, [{ taskId: task.id, at: local(11, 30) }], { mode: "agent", provenance: { operation: "schedule_tasks" } }),
      (error: unknown) => error instanceof CrmError && /clashes with Physio/.test(error.message),
    );
    const done = await scheduleTasks(mark, [{ taskId: task.id, at: local(15) }], { mode: "agent", provenance: { operation: "schedule_tasks" } });
    assert.equal(done[0].task.dueAt, at(15));
  });
});

describe("booking busy times from reminders", () => {
  let mark: UserActor;
  let sam: UserActor;
  const NOW = Date.UTC(2026, 9, 15, 9, 0);
  let ip = 0;
  const freshIp = () => `198.51.100.${(ip += 1)}`;
  const page = (overrides: BookingPageInput = {}): BookingPageInput => ({
    slug: "mark",
    enabled: true,
    title: null,
    intro: "Pick a time.",
    durationMinutes: 30,
    bufferMinutes: 0,
    minNoticeMinutes: 240,
    horizonDays: 21,
    weeklyHours: DEFAULT_WEEKLY_HOURS,
    videoUrl: "",
    ...overrides,
  });

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark-book-rem@orbit.test", "Mark Ridgeon");
    sam = await createUser("sam-book-rem@orbit.test", "Sam Teammate");
    await saveBookingPage(mark, page());
    await saveBookingPage(sam, page({ slug: "sam" }));
  });

  it("hides a slot behind a Block time reminder for someone with no Outlook connection, and tells the public nothing about it", async () => {
    const connections = await getAdminPool().query("select 1 from crm.mailbox_connections where user_id = $1", [mark.userId]);
    assert.equal(connections.rowCount, 0);
    const before = await listSlots("mark", { month: "2026-10", timeZone: "Europe/London" }, { ip: freshIp(), now: NOW });
    const monday = before.days["2026-10-19"];
    for (const slot of ["2026-10-19T09:00:00.000Z", "2026-10-19T12:00:00.000Z", "2026-10-19T13:00:00.000Z", "2026-10-19T14:00:00.000Z"]) assert.ok(monday.includes(slot), slot);

    await createReminder(mark, { title: "Secret dentist appointment", dueAt: "2026-10-19T13:00:00.000Z", blocksTime: true, durationMinutes: 30 }, { now: NOW });
    await createReminder(mark, { title: "Marker only", dueAt: "2026-10-19T14:00:00.000Z" }, { now: NOW });
    const ticked = (await createReminder(mark, { title: "Done block", dueAt: "2026-10-19T12:00:00.000Z", blocksTime: true, durationMinutes: 30 }, { now: NOW })).reminder;
    await completeReminder(mark, ticked.id, {}, { now: NOW });
    await createReminder(sam, { title: "Sam's block", dueAt: "2026-10-19T09:00:00.000Z", blocksTime: true, durationMinutes: 60 }, { now: NOW });

    const after = await listSlots("mark", { month: "2026-10", timeZone: "Europe/London" }, { ip: freshIp(), now: NOW });
    const next = after.days["2026-10-19"];
    assert.ok(!next.includes("2026-10-19T13:00:00.000Z"), "the Block time reminder is busy");
    assert.ok(next.includes("2026-10-19T14:00:00.000Z"), "a marker is not busy");
    assert.ok(next.includes("2026-10-19T12:00:00.000Z"), "a done reminder is not busy");
    assert.ok(next.includes("2026-10-19T09:00:00.000Z"), "a teammate's reminder never blocks Mark's page");
    assert.ok(!JSON.stringify(after).includes("dentist"), "the public response never carries the reminder");

    const sams = await listSlots("sam", { month: "2026-10", timeZone: "Europe/London" }, { ip: freshIp(), now: NOW });
    assert.ok(!sams.days["2026-10-19"].includes("2026-10-19T09:00:00.000Z"));
    assert.ok(sams.days["2026-10-19"].includes("2026-10-19T13:00:00.000Z"));

    const busy = await getAdminPool().query("select * from private.booking_busy($1, '2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z')", [mark.userId]);
    assert.deepEqual(busy.fields.map((field) => field.name), ["starts_at", "ends_at"]);
    assert.deepEqual(busy.rows.map((row) => [row.starts_at.toISOString(), row.ends_at.toISOString()]), [["2026-10-19T13:00:00.000Z", "2026-10-19T13:30:00.000Z"]]);
    assert.deepEqual(await loadBusy(mark.userId, Date.parse("2026-10-19T00:00:00Z"), Date.parse("2026-10-20T00:00:00Z"), NOW), [
      { start: Date.parse("2026-10-19T13:00:00Z"), end: Date.parse("2026-10-19T13:30:00Z") },
    ]);
  });

  it("returns nothing once the booking page is off", async () => {
    await saveBookingPage(mark, page({ enabled: false }));
    const busy = await getAdminPool().query("select * from private.booking_busy($1, '2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z')", [mark.userId]);
    assert.equal(busy.rowCount, 0);
    await saveBookingPage(mark, page());
  });

  it("redefines booking_busy so it runs twice, keeps every branch and keeps its grants", async () => {
    await reapplyMigrationsFrom(MIGRATION);
    await reapplyMigrationsFrom(MIGRATION);
    const admin = getAdminPool();
    await saveMailbox(mark, { email: "mark-book-rem@orbit.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const connectionId = (await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [mark.userId])).rows[0].id;
    const calendarId = (
      await admin.query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color)
         values ($1, $2, $3, 'cal-main', 'Main', '#4f9be8') returning id`,
        [mark.workspaceId, mark.userId, connectionId],
      )
    ).rows[0].id;
    await admin.query(
      `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, show_as)
       values ($1, $2, $3, $4, 'event-1', 'Board', '2026-10-19T08:00:00Z', '2026-10-19T09:00:00Z', 'busy')`,
      [mark.workspaceId, calendarId, connectionId, mark.userId],
    );
    await createTask(mark, { title: "Timed task", dueAt: "2026-10-19T15:00:00.000Z", durationMinutes: 30 });
    const busy = await admin.query<{ starts_at: Date }>("select starts_at from private.booking_busy($1, '2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z')", [mark.userId]);
    const starts = busy.rows.map((row) => row.starts_at.toISOString());
    assert.ok(starts.includes("2026-10-19T13:00:00.000Z"), "the reminder branch");
    assert.ok(starts.includes("2026-10-19T08:00:00.000Z"), "the calendar branch");
    assert.ok(starts.includes("2026-10-19T15:00:00.000Z"), "the task branch");
    const grants = await admin.query<{ role: string; allowed: boolean }>(
      `select role, has_function_privilege(role, 'private.booking_busy(uuid, timestamptz, timestamptz)', 'execute') as allowed
       from unnest(array['crm_app', 'authenticated', 'anon', 'crm_agent']) as role`,
    );
    assert.deepEqual(Object.fromEntries(grants.rows.map((row) => [row.role, row.allowed])), { crm_app: true, authenticated: false, anon: false, crm_agent: false });
    const definer = await admin.query<{ prosecdef: boolean; proconfig: string[] }>(
      "select prosecdef, proconfig from pg_proc where oid = 'private.booking_busy(uuid, timestamptz, timestamptz)'::regprocedure",
    );
    assert.equal(definer.rows[0].prosecdef, true);
    assert.deepEqual(definer.rows[0].proconfig, ['search_path=""']);
    await assert.rejects(queryAsUser(sam.userId, "select * from private.booking_busy($1, now(), now() + interval '1 day')", [mark.userId]));
  });
});
