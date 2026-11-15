import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { mergeCompanies, mergeContacts } from "@/lib/crm/merge";
import { scopesForRole } from "@/lib/crm/scopes";
import {
  createRepeatingTask,
  createTaskFromApi,
  deleteSeries,
  DONE_ALREADY,
  END_TOO_FAR,
  NEW_DAY_ALL,
  readRepeat,
  readRepeatHistory,
  rollDueSeries,
  setTaskRepeat,
  skipOccurrence,
  THEIR_SERIES_FULL,
  updateOccurrence,
  updateTaskFromApi,
} from "@/lib/crm/task-series";
import { addTaskParticipants, archiveTask, completeTask, createTask, getTask, reopenTask, updateTask } from "@/lib/crm/tasks";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { undoAuditEvent, undoTaskEvents } from "@/lib/crm/undo";
import { removeMember } from "@/lib/crm/team";
import { createWorkspace } from "@/lib/crm/workspaces";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { describeRepeat, repeatInputOf, ruleWords, checkEnds, type RepeatEnds, type RepeatRule } from "@/lib/task-repeat";
import { createAgent, createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let companyId: string;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

type SeriesRow = { id: string; current_task_id: string | null; ended_at: Date | null; at: string | null; title: string; ends: RepeatEnds; rule: RepeatRule; starts_on: string; owner_id: string | null; company_id: string | null; contact_id: string | null; priority: string; split_from_id: string | null; roll_pending: boolean; remind_minutes: number | null };

async function series(id: string) {
  const [row] = await sql<SeriesRow>(
    "select id, current_task_id, ended_at, to_char(at, 'HH24:MI') as at, title, ends, rule, starts_on::text as starts_on, owner_id, company_id, contact_id, priority, split_from_id, roll_pending, remind_minutes from crm.task_series where id = $1",
    [id],
  );
  return row;
}

async function parts(parentId: string) {
  return sql<SeriesRow>(
    "select id, current_task_id, ended_at, to_char(at, 'HH24:MI') as at, title, ends, rule, starts_on::text as starts_on, owner_id, company_id, contact_id, priority, split_from_id, roll_pending, remind_minutes from crm.task_series where split_from_id = $1 order by starts_on",
    [parentId],
  );
}

async function occurrences(seriesId: string) {
  return sql<{ id: string; occurs_on: string; completed: boolean; archived: boolean; title: string; due_has_time: boolean; due_at: Date; remind_minutes: number | null }>(
    "select id, occurs_on::text as occurs_on, completed_at is not null as completed, archived_at is not null as archived, title, due_has_time, due_at, remind_minutes from crm.tasks where series_id = $1 order by occurs_on, created_at",
    [seriesId],
  );
}

async function openOf(seriesId: string) {
  return (await occurrences(seriesId)).find((row) => !row.completed && !row.archived) ?? null;
}

async function events(taskId: string) {
  return sql<{ id: string; event_type: string; operation: string; changes: Record<string, unknown> }>(
    "select id, event_type, operation, changes from crm.audit_events where entity_id = $1 order by created_at, id",
    [taskId],
  );
}

function at(day: string, time: string) {
  return new Date(`${day}T${time}:00Z`).toISOString();
}

async function weekly(title: string, day = "2027-03-02", time: string | null = "14:00", extra: Record<string, unknown> = {}) {
  const due = time ? { dueAt: at(day, time) } : { dueDate: day };
  return (await createRepeatingTask(mark, { title, ...due, companyId }, { every: "week", ...extra })).body.task;
}

async function completeAll(seriesIds: string[], limit = 40) {
  let done = 0;
  for (let guard = 0; guard < limit; guard += 1) {
    let open = null;
    for (const id of seriesIds) open = open ?? (await openOf(id));
    if (!open) break;
    await completeTask(mark, open.id);
    done += 1;
  }
  return done;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@fixes.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@fixes.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@fixes.test", "Priya Nair"), "member");
  companyId = (await createCompany(mark, { name: "Northwind", domain: "northwind.test" })).body.company.id;
});

beforeEach(async () => {
  await sql("update crm.task_series set archived_at = now() where archived_at is null");
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("after N times", () => {
  it("never runs past N through pattern changes, and a save with nothing changed keeps what is left (1)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Ten times", dueDate: "2027-03-01" }, { every: "day", ends: { after: 10 } })).body.task;
    for (let index = 0; index < 3; index += 1) await completeTask(mark, (await openOf(task.seriesId!))!.id);
    const open = (await openOf(task.seriesId!))!;
    await setTaskRepeat(mark, open.id, { every: "weekday" });
    const left = (await getTask(mark, open.id)).repeat!;
    await setTaskRepeat(mark, open.id, repeatInputOf(left.rule, left.ends));
    assert.equal((await getTask(mark, open.id)).repeat?.end, left.end, "an unchanged save keeps what is left");
    await setTaskRepeat(mark, open.id, { every: "day" });
    await completeAll([task.seriesId!]);
    const done = (await occurrences(task.seriesId!)).filter((row) => row.completed).length;
    assert.equal(done, 10);
  });

  it("gives the rrule what is left after a pattern change, and refuses a count past the year 9999 (52, 53)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Rrule count", dueDate: "2027-03-01" }, { every: "day", ends: { after: 10 } })).body.task;
    await completeTask(mark, task.id);
    const open = (await openOf(task.seriesId!))!;
    const changed = (await setTaskRepeat(mark, open.id, { every: "weekday" })).body.task;
    assert.match(changed.repeat!.rrule, /COUNT=9(;|$)/);
    await assert.rejects(createRepeatingTask(mark, { title: "Far", dueDate: "2027-03-01" }, { every: "year", interval: 8, ends: { after: 999 } }), new RegExp(END_TOO_FAR));
  });
});

describe("ends", () => {
  it("removes an end with Never from the Custom editor (2)", async () => {
    const task = await weekly("Never ends", "2027-03-02", "14:00", { ends: { after: 5 } });
    const input = repeatInputOf(task.repeat!.rule, { never: true });
    assert.equal(input.ends, null);
    const saved = (await setTaskRepeat(mark, task.id, input)).body.task;
    assert.deepEqual(saved.repeat?.ends, { never: true });
  });

  it("allows an end date ten years ahead on the 29th to 31st", () => {
    assert.equal(checkEnds({ until: "2036-10-31" }, "2026-11-01", "2026-10-31"), null);
  });
});

describe("merges", () => {
  it("moves a series with a company or contact merge, so later dates follow the kept one (3)", async () => {
    const dup = (await createCompany(mark, { name: "Northwind duplicate", domain: "northwind-dup.test" })).body.company.id;
    const keep = (await createCompany(mark, { name: "Northwind kept", domain: "northwind-kept.test" })).body.company.id;
    const task = (await createRepeatingTask(mark, { title: "Merge follow", dueDate: "2027-03-02", companyId: dup }, { every: "week" })).body.task;
    await mergeCompanies(mark, keep, dup, { operation: "merge_companies" });
    assert.equal((await series(task.seriesId!)).company_id, keep);
    await completeTask(mark, task.id);
    const next = (await openOf(task.seriesId!))!;
    assert.equal((await getTask(mark, next.id)).companyId, keep);

    const person = (await createContact(mark, { firstName: "Dup", lastName: "Person", email: "dup.person@fixes.test" })).body.contact.id;
    const kept = (await createContact(mark, { firstName: "Kept", lastName: "Person", email: "kept.person@fixes.test" })).body.contact.id;
    const call = (await createRepeatingTask(mark, { title: "Contact merge follow", dueDate: "2027-03-02", contactId: person }, { every: "week" })).body.task;
    await mergeContacts(mark, kept, person, { operation: "merge_contacts" });
    assert.equal((await series(call.seriesId!)).contact_id, kept);
  });
});

describe("rolls and moves", () => {
  async function timedForSam(title: string) {
    const task = (await createRepeatingTask(mark, { title, dueDate: "2027-03-02", ownerId: sam.userId }, { every: "week" })).body.task;
    await updateOccurrence(sam, { taskId: task.id }, { dueAt: at("2027-03-02", "09:00"), remindMinutes: 30 }, "all");
    return task;
  }

  it("keeps a colleague's time and reminder when the creator skips or the cron rolls (7)", async () => {
    const task = await timedForSam("Sam's call");
    assert.equal((await series(task.seriesId!)).at, "09:00");
    const skipped = (await skipOccurrence(mark, { taskId: task.id })).body.task;
    assert.equal(skipped.dueHasTime, true);
    assert.equal(skipped.dueAt, at("2027-03-09", "09:00"));
    assert.equal(skipped.remindMinutes, 30);
    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-03-16T01:00:00Z") });
    const rolled = await getTask(sam, task.id);
    assert.equal(rolled.occursOn, "2027-03-16");
    assert.equal(rolled.dueHasTime, true);
    assert.equal(rolled.remindMinutes, 30);
  });

  it("moves a missed last one of an earlier part on into the later part (8)", async () => {
    const task = await weekly("Split roll", "2027-03-02");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { title: "Split roll later" }, "following");
    await completeTask(mark, task.id);
    const last = (await openOf(task.seriesId!))!;
    assert.equal(last.occurs_on, "2027-03-09");
    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-03-16T15:00:00Z") });
    const [later] = await parts(task.seriesId!);
    const moved = await getTask(mark, last.id);
    assert.equal(moved.seriesId, later.id);
    assert.equal(moved.occursOn, "2027-03-16");
    assert.equal(moved.title, "Split roll later");
    assert.ok((await series(task.seriesId!)).ended_at);
    const open = [...(await occurrences(task.seriesId!)), ...(await occurrences(later.id))].filter((row) => !row.completed && !row.archived);
    assert.equal(open.length, 1);
  });

  it("carries tags to the first task of a later part (9)", async () => {
    const task = await weekly("Split tags", "2027-03-02");
    await addTaskParticipants(mark, task.id, [priya.userId]);
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { title: "Split tags later" }, "following");
    await completeAll([task.seriesId!]);
    const [later] = await parts(task.seriesId!);
    const first = (await openOf(later.id))!;
    const tagged = await sql<{ user_id: string }>("select user_id from crm.task_participants where task_id = $1", [first.id]);
    assert.deepEqual(tagged.map((row) => row.user_id), [priya.userId]);
    assert.equal((await getTask(priya, first.id)).title, "Split tags later");
  });

  it("starts only the next later part when two This and following changes are made (10)", async () => {
    const task = await weekly("Two splits", "2027-03-02");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-23" }, { title: "Two splits third" }, "following");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { title: "Two splits second" }, "following");
    const [second] = await parts(task.seriesId!);
    const [third] = await parts(second.id);
    assert.equal(third.title, "Two splits third");
    await completeTask(mark, task.id);
    await completeTask(mark, (await openOf(task.seriesId!))!.id);
    const open = [task.seriesId!, second.id, third.id];
    const live = [];
    for (const id of open) live.push(...(await occurrences(id)).filter((row) => !row.completed && !row.archived));
    assert.equal(live.length, 1);
    assert.equal(live[0].title, "Two splits second");
  });

  it("stops a later part when the earlier part is set to never end (11)", async () => {
    const task = await weekly("Orphan", "2027-03-02");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { title: "Orphan later" }, "following");
    await setTaskRepeat(mark, task.id, { every: "week", ends: null });
    const [later] = await parts(task.seriesId!);
    assert.ok(later.ended_at, "the later part ends");
  });

  it("makes a removed person's series date only, like their tasks, and doesn't tag the remover on their own task (12)", async () => {
    const rita = await join(await createUser("rita@fixes.test", "Rita Lowe"), "member");
    const task = (await createRepeatingTask(rita, { title: "Rita timed", dueAt: at("2027-03-02", "09:00") }, { every: "week" })).body.task;
    assert.equal((await series(task.seriesId!)).at, "09:00");
    await removeMember(mark, rita.userId);
    const row = await series(task.seriesId!);
    assert.equal(row.at, null);
    assert.equal(row.owner_id, mark.userId);
    const tagged = await sql("select 1 from crm.task_participants where task_id = $1 and user_id = $2", [task.id, mark.userId]);
    assert.equal(tagged.length, 0);
  });

  it("records the dates a late completion passes (42)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Late daily", dueDate: "2027-03-01" }, { every: "day" })).body.task;
    await updateTask(mark, task.id, { dueDate: "2027-03-03" });
    await completeTask(mark, task.id);
    assert.equal((await openOf(task.seriesId!))!.occurs_on, "2027-03-04");
    const next = (await openOf(task.seriesId!))!;
    const history = await readRepeatHistory(mark, next.id);
    assert.deepEqual(
      history.filter((item) => item.kind === "missed").map((item) => item.day),
      ["2027-03-03", "2027-03-02"],
    );
  });

  it("moves on past a date a done occurrence already holds instead of failing (35)", async () => {
    const task = await weekly("Held date", "2027-03-02", null);
    await completeTask(mark, task.id);
    const open = (await openOf(task.seriesId!))!;
    const done = (await occurrences(task.seriesId!)).find((row) => row.completed)!;
    await sql("update crm.tasks set occurs_on = '2027-03-16' where id = $1", [done.id]);
    await completeTask(mark, open.id);
    assert.equal((await openOf(task.seriesId!))!.occurs_on, "2027-03-23");
  });
});

describe("edits by scope", () => {
  it("applies an All change before completing in the same call (13)", async () => {
    const task = await weekly("Complete and rename", "2027-03-02");
    await updateOccurrence(mark, { taskId: task.id }, { title: "Complete and renamed", priority: "high", completed: true }, "all");
    const next = (await openOf(task.seriesId!))!;
    const read = await getTask(mark, next.id);
    assert.equal(read.title, "Complete and renamed");
    assert.equal(read.priority, "high");
  });

  it("applies priority, assignee and links with This and following, and refuses what it can't (14, 44)", async () => {
    const task = await weekly("Following fields", "2027-03-02");
    const other = await createWorkspace(mark, { name: "Elsewhere fields" });
    const away = (await createCompany({ ...mark, workspaceId: other.id, workspaceName: other.name, role: "owner", scopes: scopesForRole("owner") }, { name: "Away", domain: "away-fields.test" })).body.company.id;
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { companyId: away }, "following"), /isn't in this workspace/);
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { docIds: [] }, "following"), /Change that on the open task/);
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { durationMinutes: 1000 }, "following"), /between 5 and 480/);
    const contact = (await createContact(mark, { firstName: "Following", lastName: "Link", email: "following.link@fixes.test" })).body.contact.id;
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { priority: "high", ownerId: sam.userId, contactId: contact }, "following");
    const [later] = await parts(task.seriesId!);
    assert.equal(later.priority, "high");
    assert.equal(later.owner_id, sam.userId);
    assert.equal(later.contact_id, contact);
  });

  it("moves later dates to a new day with This and following, and refuses a new day with All (15)", async () => {
    const task = await weekly("New day", "2027-03-02");
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { dueAt: at("2027-03-17", "14:00") }, "all"), new RegExp(NEW_DAY_ALL.slice(0, 20)));
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { dueAt: at("2027-03-17", "14:00") }, "following");
    const [later] = await parts(task.seriesId!);
    assert.equal(later.starts_on, "2027-03-17");
    assert.deepEqual(later.rule, { freq: "weekly", interval: 1, weekdays: ["we"] });
    assert.deepEqual((await series(task.seriesId!)).ends, { until: "2027-03-15" });
  });

  it("keeps the series' new time when the open one is handed on (16)", async () => {
    const task = await weekly("Handed time", "2027-03-02");
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    await updateOccurrence(mark, { taskId: task.id }, { dueAt: at("2027-03-02", "10:00") }, "all");
    assert.equal((await series(task.seriesId!)).at, "10:00");
  });

  it("saves a time a creator sets on a colleague's upcoming date as date only (17)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Colleague upcoming", dueDate: "2027-03-02", ownerId: sam.userId }, { every: "week" })).body.task;
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { dueAt: at("2027-03-17", "10:00") }, "this");
    const [change] = await sql<{ due_has_time: boolean }>("select due_has_time from crm.task_occurrence_changes where series_id = $1 and occurs_on = '2027-03-16'", [task.seriesId]);
    assert.equal(change.due_has_time, false);
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-23" }, { dueAt: at("2027-03-23", "10:00") }, "following");
    const [later] = await parts(task.seriesId!);
    assert.equal(later.at, null);
  });

  it("refuses a description too long for a task on one upcoming date (18)", async () => {
    const task = await weekly("Long description", "2027-03-02");
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { description: "x".repeat(10_001) }, "this"), /10000|10,000|too long/i);
  });

  it("refuses moving an upcoming date onto or past its neighbours (19)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Daily neighbours", dueDate: "2027-03-01" }, { every: "day" })).body.task;
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-04" }, { dueDate: "2027-03-03" }, "this"), /Choose a day after/);
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-04" }, { dueDate: "2027-03-05" }, "this"), /before/);
  });

  it("keeps the series' owner able to see a handed-on one an agent gives away (20)", async () => {
    const { actor: agent } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Repeat agent fixes");
    const task = (await createRepeatingTask(agent, { title: "Agent handed", dueDate: "2027-03-02" }, { every: "week" })).body.task;
    assert.equal(task.ownerId, mark.userId);
    await updateOccurrence(agent, { taskId: task.id }, { ownerId: sam.userId }, "this");
    assert.equal((await getTask(mark, task.id)).ownerId, sam.userId);
  });

  it("refuses All on an occurrence that was completed meanwhile (21)", async () => {
    const task = await weekly("Done meanwhile", "2027-03-02");
    await completeTask(mark, task.id);
    await assert.rejects(updateOccurrence(mark, { taskId: task.id }, { title: "Renamed all" }, "all"), new RegExp(DONE_ALREADY.slice(0, 20)));
  });

  it("keeps a date-only series date only when All gets a bare date (45)", async () => {
    const task = await weekly("Bare date", "2027-03-02", null);
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { dueAt: "2027-03-16", title: "Bare date all" }, "all");
    assert.equal((await series(task.seriesId!)).at, null);
  });

  it("moves the series' company with an All contact change (46)", async () => {
    const elsewhere = (await createCompany(mark, { name: "Contact's company", domain: "contacts-company.test" })).body.company.id;
    const contact = (await createContact(mark, { firstName: "Moves", lastName: "Company", email: "moves.company@fixes.test", companyId: elsewhere })).body.contact.id;
    const task = (await createRepeatingTask(mark, { title: "Contact all", dueDate: "2027-03-02" }, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { contactId: contact }, "all");
    const row = await series(task.seriesId!);
    assert.equal(row.contact_id, contact);
    assert.equal(row.company_id, elsewhere);
  });

  it("keeps the series' time when All resends the same assignee (47)", async () => {
    const task = await weekly("Same owner", "2027-03-02");
    await updateTask(mark, task.id, { dueDate: "2027-03-03" });
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: mark.userId, title: "Same owner all" }, "all");
    assert.equal((await series(task.seriesId!)).at, "14:00");
  });

  it("takes an All reminder change while the open one is overdue (48)", async () => {
    const task = await weekly("Overdue reminder", "2027-03-02");
    await sql("update crm.tasks set due_at = now() - interval '1 day' where id = $1", [task.id]);
    await updateOccurrence(mark, { taskId: task.id }, { remindMinutes: 30 }, "all");
    assert.equal((await series(task.seriesId!)).remind_minutes, 30);
  });

  it("refuses doc links, empty edits and edits to a skipped upcoming date (50)", async () => {
    const task = await weekly("Upcoming docs", "2027-03-02");
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { docIds: [] }, "this"), /Only the day, time/);
    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" });
    await assert.rejects(updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { title: "Back?" }, "this"), /skipped/);
    const [change] = await sql<{ skip: boolean }>("select skip from crm.task_occurrence_changes where series_id = $1 and occurs_on = '2027-03-16'", [task.seriesId]);
    assert.equal(change.skip, true);
  });

  it("asks for a scope when a bare dueAt with dueHasTime false removes the time (nit)", async () => {
    const task = await weekly("Remove time scope", "2027-03-02");
    await assert.rejects(updateOccurrence(mark, { taskId: task.id }, { dueAt: "2027-03-02", dueHasTime: false }, undefined), /repeatScope/);
  });
});

describe("dates", () => {
  it("keeps a past yearly anniversary instead of moving it to today (22)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Anniversary", dueDate: "2026-03-10" }, { every: "year" })).body.task;
    assert.equal(task.occursOn, "2027-03-10");
    assert.equal(task.repeat?.text, "Every year on 10 Mar");
  });

  it("keeps 29 February after a split or a pattern change (23)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Leap", dueDate: "2028-02-29" }, { every: "year" })).body.task;
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2029-02-28" }, { title: "Leap later" }, "following");
    const [later] = await parts(task.seriesId!);
    assert.equal(later.rule.monthDay, 29);
    assert.equal(ruleWords({ rule: later.rule, startsOn: later.starts_on }), "Every year on 29 Feb");
    await completeTask(mark, task.id);
    const open = (await openOf(later.id))!;
    const view = (await getTask(mark, open.id)).repeat!;
    const after = describeRepeat({ seriesId: later.id, startsOn: later.starts_on, at: null, rule: later.rule, ends: later.ends, current: true, stopped: false, occursOn: "2031-02-28", changes: [] });
    assert.equal(after.next?.occursOn, "2032-02-29");
    const changed = (await setTaskRepeat(mark, open.id, repeatInputOf(view.rule, view.ends))).body.task;
    assert.deepEqual(changed.repeat?.rule, later.rule);
  });

  it("starts every other Monday on the next Monday from a mid-week day (24)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Fortnightly", dueDate: "2027-03-03" }, { every: "week", interval: 2, days: ["mo"] })).body.task;
    assert.equal(task.occursOn, "2027-03-08");
  });

  it("anchors a pattern change on the open date, not a moved due day (25)", async () => {
    const task = await weekly("Moved anchor", "2027-03-02");
    await updateTask(mark, task.id, { dueAt: at("2027-03-04", "14:00") });
    const changed = (await setTaskRepeat(mark, task.id, { every: "year" })).body.task;
    assert.equal(changed.repeat?.text, "Every year on 2 Mar at 14:00");
  });

  it("starts a task made to repeat on its pattern, and an overdue one from today (51, 55)", async () => {
    const saturday = (await createTask(mark, { title: "Off pattern", dueDate: "2027-03-06" })).body.task;
    const made = (await setTaskRepeat(mark, saturday.id, { every: "week", days: ["fr"] })).body.task;
    assert.equal(made.occursOn, "2027-03-12");
    assert.equal(made.repeat?.startsOn, "2027-03-12");
    const today = dayKeyAt(new Date());
    const overdue = (await createTask(mark, { title: "Overdue repeat", dueDate: shiftDay(today, -5) })).body.task;
    const repeated = (await setTaskRepeat(mark, overdue.id, { every: "day" })).body.task;
    assert.equal(repeated.occursOn, today);
  });

  it("counts only skips within the end when it says how many are left (54)", () => {
    const view = describeRepeat({
      seriesId: "s",
      startsOn: "2027-03-01",
      at: null,
      rule: { freq: "daily", interval: 1 },
      ends: { count: 3 },
      current: true,
      stopped: false,
      occursOn: "2027-03-01",
      changes: [{ occursOn: "2027-03-09", skip: true }],
    });
    assert.equal(view.end, "2 more");
  });

  it("reads all seven days as every day (nit)", () => {
    assert.equal(ruleWords({ rule: { freq: "weekly", interval: 1, weekdays: ["mo", "tu", "we", "th", "fr", "sa", "su"] }, startsOn: "2027-03-01" }), "Every day");
  });
});

describe("routes and input", () => {
  it("anchors repeat on a new due day sent with it, and applies other fields to a plain task (33, 49)", async () => {
    const plain = (await createTask(mark, { title: "Plain with repeat", dueDate: "2027-03-02" })).body.task;
    const saved = (await updateTaskFromApi(mark, { taskId: plain.id }, { repeat: { every: "week" }, dueDate: "2027-03-05", title: "Plain with repeat renamed" })).body.task;
    assert.equal(saved.repeat?.text, "Every Friday");
    assert.equal(saved.title, "Plain with repeat renamed");
  });

  it("says when archiving the open one skipped it (34)", async () => {
    const task = await weekly("Archive skip", "2027-03-02");
    const result = (await archiveTask(mark, task.id)).body;
    assert.equal(result.skipped, "2027-03-02");
    assert.equal(result.task.occursOn, "2027-03-09");
  });

  it("refuses a 201st series for a colleague whose series the creator can't see, without counting them (36)", async () => {
    const values: string[] = [];
    for (let index = 0; index < 200; index += 1) values.push(`('${mark.workspaceId}', '${priya.userId}', '${sam.userId}', 'Hidden ${index}', '2027-03-01', '{"freq":"daily","interval":1}'::jsonb)`);
    await sql(`insert into crm.task_series (workspace_id, created_by_user_id, owner_id, title, starts_on, rule) values ${values.join(", ")}`);
    await assert.rejects(createRepeatingTask(mark, { title: "One too many", dueDate: "2027-03-02", ownerId: sam.userId }, { every: "week" }), new RegExp(THEIR_SERIES_FULL.slice(0, 20)));
    await sql("update crm.task_series set archived_at = now() where title like 'Hidden %'");
  });

  it("ends the series when a handed-on assignee deletes its last one (37)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Last handed", dueDate: "2027-03-02" }, { every: "week", ends: { after: 1 } })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    await archiveTask(priya, task.id);
    assert.ok((await series(task.seriesId!)).ended_at);
  });

  it("opens the series again when Done on its last one is undone (38)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Last undone", dueDate: "2027-03-02" }, { every: "week", ends: { after: 1 } })).body.task;
    await completeTask(mark, task.id);
    assert.ok((await series(task.seriesId!)).ended_at);
    await reopenTask(mark, task.id);
    assert.equal((await series(task.seriesId!)).ended_at, null);
  });

  it("gives a handed-on assignee who reopens a done one a standalone task, as decided (39)", async () => {
    const task = await weekly("Assignee reopen", "2027-03-02");
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    await completeTask(priya, task.id);
    await reopenTask(priya, task.id);
    assert.equal((await getTask(priya, task.id)).seriesId, null);
    assert.ok(await openOf(task.seriesId!));
  });

  it("refuses a reminder that can't fire between its dates (41)", async () => {
    const timed = (await createTask(mark, { title: "Timed daily", dueAt: at("2027-03-02", "09:00"), remindMinutes: 1440 })).body.task;
    await assert.rejects(setTaskRepeat(mark, timed.id, { every: "day" }), /shorter than the time between its dates/);
  });

  it("reads dueDate and dueAt the way a plain create does (43)", async () => {
    const task = (await createTaskFromApi(mark, { title: "Probe", dueAt: "", dueDate: "2027-03-03", repeat: { every: "week" } })).body.task;
    assert.equal(task.occursOn, "2027-03-03");
    await assert.rejects(createTaskFromApi(mark, { title: "Both", dueAt: at("2027-03-03", "10:00"), dueDate: "2027-03-03", repeat: { every: "week" } }), /not both/);
  });

  it("refuses a bad assignee or priority on create with a 400 (44)", async () => {
    const outsider = await createUser("outsider@fixes.test", "Out Sider");
    await assert.rejects(createRepeatingTask(mark, { title: "Outsider", dueDate: "2027-03-02", ownerId: outsider.userId }, { every: "week" }), (error: { status?: number }) => error.status === 400);
    await assert.rejects(createRepeatingTask(mark, { title: "Urgent", dueDate: "2027-03-02", priority: "urgent" as never }, { every: "week" }), (error: { status?: number }) => error.status === 400);
  });

  it("refuses unknown repeat fields, reads longer day names, and treats null as left out (58, nits)", () => {
    assert.throws(() => readRepeat({ every: "day", count: 5 }, "2027-03-01"), /doesn't take count/);
    assert.throws(() => readRepeat({ every: "day", ends: { after: 5, times: 2 } }, "2027-03-01"), /doesn't take times/);
    assert.deepEqual(readRepeat({ every: "week", days: ["tues", "thurs"] }, "2027-03-01").rule.weekdays, ["tu", "th"]);
    assert.deepEqual(readRepeat({ every: "day", monthDay: null }, "2027-03-01").rule, { freq: "daily", interval: 1 });
  });

  it("refuses skip with a scope and a scope on a task that doesn't repeat, and takes repeat on the open date (nits)", async () => {
    const task = await weekly("Skip scope", "2027-03-02");
    await assert.rejects(updateTaskFromApi(mark, { taskId: task.id }, { skip: true, repeatScope: "all" }), /Send skip on its own/);
    const plain = (await createTask(mark, { title: "Plain scope", dueDate: "2027-03-02" })).body.task;
    await assert.rejects(updateTaskFromApi(mark, { taskId: plain.id }, { title: "Plain scope all", repeatScope: "all" }), /doesn't repeat/);
    const changed = (await updateTaskFromApi(mark, { seriesId: task.seriesId!, occursOn: "2027-03-02" }, { repeat: { every: "day" } })).body.task;
    assert.equal(changed.repeat?.rule.freq, "daily");
  });

  it("keeps docs out of a new occurrence's audit, like a plain create (nit)", async () => {
    const task = await weekly("Audit docs", "2027-03-02");
    await completeTask(mark, task.id);
    const next = (await openOf(task.seriesId!))!;
    const created = (await events(next.id)).find((event) => event.event_type === "task.created")!;
    const after = created.changes.after as Record<string, unknown>;
    assert.equal("docs" in after, false);
    assert.equal("canLinkDocs" in after, false);
  });
});

describe("undo", () => {
  it("archives a task that now repeats when its creation is undone (31)", async () => {
    const plain = (await createTask(mark, { title: "Created then repeats", dueDate: "2027-03-02" })).body.task;
    await setTaskRepeat(mark, plain.id, { every: "week" });
    const created = (await events(plain.id)).find((event) => event.event_type === "task.created")!;
    await undoAuditEvent(mark, created.id, { operation: "undo_change" });
    const read = await sql<{ archived: boolean; occurs_on: string }>("select archived_at is not null as archived, occurs_on::text as occurs_on from crm.tasks where id = $1", [plain.id]);
    assert.equal(read[0].archived, true);
    assert.equal(read[0].occurs_on, "2027-03-02");
  });

  it("won't undo an older change to an upcoming date over a newer one (32)", async () => {
    const task = await weekly("Two changes", "2027-03-02");
    const first = (await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { title: "First" }, "this")).body;
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-16" }, { title: "Second" }, "this");
    await assert.rejects(undoTaskEvents(mark, task.id, first.undo, { operation: "undo_change" }), /changed since/);
    const [change] = await sql<{ title: string }>("select title from crm.task_occurrence_changes where series_id = $1 and occurs_on = '2027-03-16'", [task.seriesId]);
    assert.equal(change.title, "Second");
  });

  it("records task_series.updated when a series change is undone (59)", async () => {
    const task = await weekly("Undo event", "2027-03-02");
    const changed = (await setTaskRepeat(mark, task.id, { every: "day" })).body;
    await undoTaskEvents(mark, task.id, changed.undo, { operation: "undo_change" });
    const undone = (await events(task.id)).filter((event) => event.event_type === "task_series.updated" && event.changes.undoing === true);
    assert.equal(undone.length, 1);
  });

  it("won't undo a date change once the open one has rolled onto it (60)", async () => {
    const task = await weekly("Rolled onto", "2027-03-02");
    const changed = (await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-09" }, { title: "Rolled onto renamed" }, "this")).body;
    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-03-09T01:00:00Z") });
    assert.equal((await getTask(mark, task.id)).occursOn, "2027-03-09");
    await assert.rejects(undoTaskEvents(mark, task.id, changed.undo, { operation: "undo_change" }), /changed since/);
  });

  it("won't undo a pattern change after a skip, or a skip after a pattern change (61, 62)", async () => {
    const task = await weekly("Pattern then skip", "2027-03-02");
    const pattern = (await setTaskRepeat(mark, task.id, { every: "day" })).body;
    await skipOccurrence(mark, { taskId: task.id });
    await assert.rejects(undoTaskEvents(mark, task.id, pattern.undo, { operation: "undo_change" }), /changed since/);

    const other = await weekly("Skip then pattern", "2027-03-02");
    const skipped = (await skipOccurrence(mark, { taskId: other.id })).body;
    await setTaskRepeat(mark, other.id, { every: "day" });
    await assert.rejects(undoTaskEvents(mark, other.id, skipped.undo, { operation: "undo_change" }), /changed since/);
  });

  it("refuses undoing half of Delete the series, or a followed link change, on its own (63)", async () => {
    const task = await weekly("Delete half", "2027-03-02");
    await deleteSeries(mark, task.id);
    const archived = (await events(task.id)).find((event) => event.event_type === "task.archived")!;
    await assert.rejects(undoAuditEvent(mark, archived.id, { operation: "undo_change" }), /Undo deleting the series instead/);

    const linked = await weekly("Followed link", "2027-03-02");
    const contact = (await createContact(mark, { firstName: "Followed", lastName: "Link", email: "followed.link@fixes.test" })).body.contact.id;
    await updateOccurrence(mark, { taskId: linked.id }, { contactId: contact }, undefined);
    const follow = (await events(linked.id)).find((event) => event.changes.followsChange === true)!;
    await assert.rejects(undoAuditEvent(mark, follow.id, { operation: "undo_change" }), /Undo the change to the task instead/);
  });

  it("describes undoing a skip by its date (nit)", async () => {
    const { listRecentChanges } = await import("@/lib/crm/undo");
    const task = await weekly("Skip summary", "2027-03-02", null);
    await skipOccurrence(mark, { taskId: task.id });
    const listed = (await listRecentChanges(mark, { entityType: "task", limit: 5 })).find((change) => change.entityId === task.id)!;
    assert.match(listed.summary, /Skipped task Skip summary on Tue 2 Mar/);
  });
});

describe("database backstops", () => {
  async function asMember(user: UserActor, text: string, values: unknown[] = []) {
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user.userId, role: "authenticated" })]);
      await client.query(text, values);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async function handed(title: string) {
    const task = await weekly(title, "2027-03-02");
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    return task;
  }

  it("refuses a series that follows on from someone else's (66)", async () => {
    const task = await weekly("Not yours to split", "2027-03-02");
    await assert.rejects(
      asMember(sam, "insert into crm.task_series (workspace_id, created_by_user_id, owner_id, title, starts_on, rule, split_from_id) values ($1, $2, $2, 'Sneaky', '2027-04-01', '{\"freq\":\"daily\",\"interval\":1}'::jsonb, $3)", [mark.workspaceId, sam.userId, task.seriesId]),
      /follow on from one you can change/,
    );
  });

  it("refuses a handed-on assignee inserting an occurrence in the creator's name for anyone (67)", async () => {
    const task = await handed("Handed insert");
    await assert.rejects(
      asMember(priya, "insert into crm.tasks (workspace_id, title, owner_id, created_by_user_id, series_id, occurs_on, due_at) values ($1, 'Forged', $2, $3, $4, '2027-03-30', now())", [mark.workspaceId, sam.userId, mark.userId, task.seriesId]),
      /row-level security|violates/,
    );
  });

  it("refuses a handed-on assignee ending someone else's series by taking the task out (68)", async () => {
    const task = await handed("Handed detach");
    await assert.rejects(asMember(priya, "update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]), /take its open task out/);
    assert.equal((await series(task.seriesId!)).ended_at, null);
  });

  it("refuses completing a handed occurrence through the series' rights (69)", async () => {
    const original = (await createTask(sam, { title: "Series rights complete", dueAt: at("2027-03-02", "09:00"), ownerId: mark.userId })).body.task;
    const task = (await setTaskRepeat(mark, original.id, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    await assert.rejects(asMember(mark, "update crm.tasks set completed_at = now() where id = $1", [task.id]), /Only the assignee or the task's creator can complete/);
  });

  it("asks for a fresh roll time when a move strips the time (70)", async () => {
    const task = await weekly("Moved timed", "2027-03-02");
    const other = await createWorkspace(mark, { name: "Elsewhere roll" });
    await sql("update crm.task_series set roll_pending = false where id = $1", [task.seriesId]);
    await sql(
      "update crm.tasks set workspace_id = $2, due_has_time = false, remind_minutes = null, scheduled_by = null, company_id = null, due_at = date_trunc('day', due_at at time zone 'Europe/London') at time zone 'Europe/London' where id = $1",
      [task.id, other.id],
    );
    await sql("select private.task_series_follow_move($1, $2)", [mark.workspaceId, other.id]);
    const row = await series(task.seriesId!);
    assert.equal(row.at, null);
    assert.equal(row.roll_pending, true);
  });

  it("ends a series whose open task is deleted outright (71)", async () => {
    const task = await weekly("Hard delete", "2027-03-02");
    await sql("delete from crm.tasks where id = $1", [task.id]);
    assert.ok((await series(task.seriesId!)).ended_at);
  });

  it("rebuilds an index a failed concurrent build left invalid when the migration runs again (72)", async () => {
    await sql("update pg_index set indisvalid = false where indexrelid = 'crm.tasks_series_open_idx'::regclass");
    const file = readFileSync("supabase/migrations/20270203100000_recurring_engine_fixes.sql", "utf8");
    await applyMigrationSql(getAdminPool(), file);
    const [index] = await sql<{ valid: boolean }>("select indisvalid as valid from pg_index where indexrelid = 'crm.tasks_series_open_idx'::regclass");
    assert.equal(index.valid, true);
  });
});

