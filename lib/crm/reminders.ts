import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound, tooLong } from "@/lib/crm/errors";
import { isUuid, replayOrRun, requestHash } from "@/lib/crm/mutate";
import { assertScope, type Scope } from "@/lib/crm/scopes";
import { readRepeat } from "@/lib/crm/task-series";
import { clockLabel, DEFAULT_TASK_DURATION, isTaskDuration, MAX_TASK_DURATION, MIN_TASK_DURATION, taskDueDay } from "@/lib/crm/task-time";
import type { Actor, UserActor } from "@/lib/crm/types";
import { dayKeyAt, dayParts, shiftDay } from "@/lib/crm/working-days";
import {
  countLeft,
  dayMonth,
  firstPatternDay,
  isClock,
  isDayKey,
  isLastWeekOfMonth,
  monthWeekOf,
  occurrenceOnOrAfter,
  occurrenceTiming,
  repeatInputOf,
  repeatSummary,
  weekdayOf,
  type RepeatEnds,
  type RepeatInput,
  type RepeatPattern,
  type RepeatRule,
} from "@/lib/task-repeat";
import { appTimeZone, readDateTime } from "@/lib/time";

export const PEOPLE_ONLY = "Reminders belong to a person. Use a personal token.";
export const MAX_OPEN_REMINDERS = 500;
export const MAX_REPEATING_REMINDERS = 200;
export const TOO_MANY_REMINDERS = "You have 500 reminders. Tick some off first.";
export const TOO_MANY_REPEATING = "You have 200 repeating reminders. End one first.";
export const NEEDS_TIME_TO_BLOCK = "Pick a time to block time.";
export const NEEDS_DATE_TO_REPEAT = "Pick a date to repeat.";
export const TIME_PASSED = "That time has passed.";
export const REOPEN_FIRST = "Reopen it first.";
export const MOVED_ON = "Can't undo. It has moved on already.";
export const NEEDS_DUE_ON = "This reminder repeats. Send dueOn, the date being ticked.";
export const MAX_TITLE = 500;
export const DONE_DAYS = 30;
export const DEFAULT_MORNING = "08:00";

export type Reminder = {
  id: string;
  title: string;
  dueOn: string | null;
  dueAt: string | null;
  time: string | null;
  blocksTime: boolean;
  durationMinutes: number;
  repeat: RepeatInput | null;
  repeatText: string | null;
  completedAt: string | null;
  repeatOf: string | null;
  movedTo: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReminderInput = {
  title?: string;
  dueOn?: string | null;
  dueAt?: string | null;
  blocksTime?: boolean;
  durationMinutes?: number;
  repeat?: RepeatInput | null;
};

export type ReminderQuery = { from?: string; to?: string; includeDone?: boolean };

export type TickResult = { reminder: Reminder; doneId: string | null; changed: boolean };

type Row = {
  id: string;
  user_id: string;
  title: string;
  due_on: string | null;
  due_at: Date | null;
  blocks_time: boolean;
  duration_minutes: number;
  repeat_rule: RepeatRule | null;
  repeat_ends: RepeatEnds | null;
  completed_at: Date | null;
  repeat_of: string | null;
  moved_to: string | null;
  pushed_for: Date | null;
  created_at: Date;
  updated_at: Date;
};

type Timing = { dueOn: string | null; dueAt: string | null; rule: RepeatRule | null; ends: RepeatEnds | null };

const COLUMNS = `id, user_id, title, due_on::text as due_on, due_at, blocks_time, duration_minutes, repeat_rule, repeat_ends,
  completed_at, repeat_of, moved_to::text as moved_to, pushed_for, created_at, updated_at`;

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

function invalid(message: string, field?: string): never {
  throw new CrmError("invalid_input", message, 400, field ? { field } : null);
}

export function personOf(actor: Actor, scope: Scope): UserActor {
  if (actor.type !== "user") throw new CrmError("forbidden", PEOPLE_ONLY, 403);
  assertScope(actor.scopes, scope);
  return actor;
}

function today(now = Date.now()) {
  return dayKeyAt(new Date(now));
}

function clockOf(dueAt: Date | string | null) {
  return dueAt ? clockLabel(new Date(dueAt).toISOString()) : null;
}

function patternOf(dueOn: string, dueAt: Date | string | null, rule: RepeatRule, ends: RepeatEnds): RepeatPattern {
  return { startsOn: dueOn, at: clockOf(dueAt), rule, ends };
}

function inputOf(rule: RepeatRule, ends: RepeatEnds): RepeatInput {
  const input = repeatInputOf(rule, ends);
  if ("count" in ends) input.ends = { after: countLeft(ends) ?? ends.count };
  return input;
}

function toReminder(row: Row): Reminder {
  const repeating = row.repeat_rule && row.repeat_ends && row.due_on;
  return {
    id: row.id,
    title: row.title,
    dueOn: row.due_on,
    dueAt: iso(row.due_at),
    time: clockOf(row.due_at),
    blocksTime: row.blocks_time,
    durationMinutes: row.duration_minutes,
    repeat: repeating ? inputOf(row.repeat_rule!, row.repeat_ends!) : null,
    repeatText: repeating ? repeatSummary(patternOf(row.due_on!, row.due_at, row.repeat_rule!, row.repeat_ends!)) : null,
    completedAt: iso(row.completed_at),
    repeatOf: row.repeat_of,
    movedTo: row.moved_to,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function cleanTitle(value: unknown) {
  if (typeof value !== "string") invalid("Enter a reminder.", "title");
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) invalid("Enter a reminder.", "title");
  if (title.length > MAX_TITLE) invalid(tooLong("a reminder", MAX_TITLE), "title");
  return title;
}

function readDuration(value: unknown) {
  if (!isTaskDuration(value)) invalid(`Choose a length between ${MIN_TASK_DURATION} and ${MAX_TASK_DURATION} minutes.`, "durationMinutes");
  return value;
}

function timeOnDay(day: string, at: string | null) {
  return at ? occurrenceTiming(at, day).dueAt : null;
}

function readTiming(input: ReminderInput, current: { dueOn: string | null; dueAt: Date | null } | null) {
  const given = { dueOn: input.dueOn, dueAt: input.dueAt };
  if (given.dueOn !== undefined && given.dueAt !== undefined && given.dueOn !== null && given.dueAt !== null) {
    invalid("Send dueOn for a day or dueAt for a time, not both.", "dueOn");
  }
  if (given.dueAt !== undefined && given.dueAt !== null) {
    if (typeof given.dueAt !== "string" || !given.dueAt.trim()) invalid("dueAt takes a time, such as 2026-11-20T10:00.", "dueAt");
    const reading = readDateTime(given.dueAt.trim());
    if (!reading.ok) invalid(reading.error, "dueAt");
    if (reading.dateOnly) return { dueOn: dayKeyAt(reading.date), dueAt: null };
    const dueAt = reading.date.toISOString();
    return { dueOn: taskDueDay(dueAt), dueAt };
  }
  if (given.dueOn !== undefined) {
    if (given.dueOn === null) return { dueOn: null, dueAt: null };
    if (!isDayKey(given.dueOn)) invalid("dueOn takes a day, such as 2026-11-20. Send dueAt for a time.", "dueOn");
    const keepClock = given.dueAt === undefined ? clockOf(current?.dueAt ?? null) : null;
    return { dueOn: given.dueOn, dueAt: timeOnDay(given.dueOn, keepClock) };
  }
  if (given.dueAt === null) return { dueOn: current?.dueOn ?? null, dueAt: null };
  return null;
}

function reanchor(rule: RepeatRule, from: string, to: string): RepeatRule {
  if (from === to) return rule;
  if (rule.freq === "weekly" && rule.weekdays?.length === 1 && rule.weekdays[0] === weekdayOf(from)) return { ...rule, weekdays: [weekdayOf(to)] };
  if (rule.freq === "monthly" && rule.monthDay === dayParts(from).day) return { ...rule, monthDay: dayParts(to).day };
  if (rule.freq === "monthly" && rule.monthWeek && rule.monthWeek.weekday === weekdayOf(from)) {
    const week = monthWeekOf(to);
    return { ...rule, monthWeek: { n: rule.monthWeek.n === -1 && isLastWeekOfMonth(to) ? -1 : week.n, weekday: week.weekday } };
  }
  if (rule.freq === "yearly") return { freq: "yearly", interval: rule.interval };
  return rule;
}

function settleRepeat(timing: Timing): Timing {
  if (!timing.rule || !timing.ends) return { ...timing, rule: null, ends: null };
  if (!timing.dueOn) invalid(NEEDS_DATE_TO_REPEAT, "repeat");
  const day = firstPatternDay(timing.rule, timing.dueOn);
  if (!day) invalid("Choose how it repeats.", "repeat");
  if ("until" in timing.ends && day > timing.ends.until) invalid("The end date is before this one.", "repeat.ends");
  if (day === timing.dueOn) return timing;
  return { ...timing, dueOn: day, dueAt: timing.dueAt ? occurrenceTiming(clockOf(timing.dueAt), day).dueAt : null };
}

async function lockPerson(db: Db, userId: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`reminders:${userId}`]);
}

async function assertRoom(db: Db, userId: string, adding: { open: boolean; repeating: boolean }) {
  if (!adding.open && !adding.repeating) return;
  await lockPerson(db, userId);
  const counted = await db.query<{ open: number; repeating: number }>(
    `select count(*)::int as open, count(*) filter (where repeat_rule is not null)::int as repeating
     from crm.reminders where user_id = $1 and completed_at is null`,
    [userId],
  );
  const { open, repeating } = counted.rows[0] ?? { open: 0, repeating: 0 };
  if (adding.open && open >= MAX_OPEN_REMINDERS) invalid(TOO_MANY_REMINDERS);
  if (adding.repeating && repeating >= MAX_REPEATING_REMINDERS) invalid(TOO_MANY_REPEATING, "repeat");
}

async function lockedRow(db: Db, id: string) {
  if (!isUuid(id)) throw notFound("reminder");
  const result = await db.query<Row>(`select ${COLUMNS} from crm.reminders where id = $1 for update`, [id]);
  const row = result.rows[0];
  if (!row) throw notFound("reminder");
  return row;
}

async function readRow(db: Db, id: string) {
  const result = await db.query<Row>(`select ${COLUMNS} from crm.reminders where id = $1`, [id]);
  return result.rows[0];
}

function repeatFrom(input: ReminderInput, startsOn: string | null, now: number) {
  if (input.repeat === undefined) return undefined;
  if (input.repeat === null) return null;
  if (!startsOn) invalid(NEEDS_DATE_TO_REPEAT, "repeat");
  return readRepeat(input.repeat, startsOn, now);
}

export async function listReminders(actor: Actor, options: ReminderQuery = {}) {
  const person = personOf(actor, "crm:read");
  if (options.from !== undefined && !isDayKey(options.from)) invalid("from takes a day, such as 2026-11-20.", "from");
  if (options.to !== undefined && !isDayKey(options.to)) invalid("to takes a day, such as 2026-11-20.", "to");
  const ranged = options.from !== undefined || options.to !== undefined;
  return withActor(person, async (db) => {
    const result = await db.query<Row>(
      `select ${COLUMNS} from crm.reminders
       where user_id = $1
         and (completed_at is null or ($2 and completed_at > now() - make_interval(days => $3)))
         and (not $4 or (due_on is not null and ($5::date is null or due_on >= $5::date) and ($6::date is null or due_on <= $6::date)))
       order by completed_at desc nulls first, due_on nulls last, due_at nulls first, created_at, id`,
      [person.userId, options.includeDone === true, DONE_DAYS, ranged, options.from ?? null, options.to ?? null],
    );
    return { reminders: result.rows.map(toReminder) };
  });
}

export const MAX_CALENDAR_DAYS = 62;

export async function listCalendarReminders(actor: Actor, range: { from: string; to: string }, options: { now?: number } = {}) {
  const person = personOf(actor, "crm:read");
  if (!isDayKey(range.from)) invalid("from takes a day, such as 2026-11-20.", "from");
  if (!isDayKey(range.to)) invalid("to takes a day, such as 2026-11-20.", "to");
  if (range.to < range.from || range.to > shiftDay(range.from, MAX_CALENDAR_DAYS)) invalid(`Ask for up to ${MAX_CALENDAR_DAYS} days at a time.`, "to");
  const day = today(options.now);
  return withActor(person, async (db) => {
    const result = await db.query<Row>(
      `select ${COLUMNS} from crm.reminders
       where user_id = $1 and completed_at is null and due_on is not null
         and ((due_on >= $2::date and due_on <= $3::date) or due_on < $4::date)
       order by due_on, due_at nulls first, created_at, id`,
      [person.userId, range.from, range.to, day],
    );
    return { reminders: result.rows.map(toReminder) };
  });
}

export async function listDayReminders(actor: Actor, day: string, options: { now?: number } = {}) {
  const person = personOf(actor, "crm:read");
  if (!isDayKey(day)) invalid("day takes a day, such as 2026-11-20.", "day");
  const current = today(options.now);
  return withActor(person, async (db) => {
    const result = await db.query<Row>(
      `select ${COLUMNS} from crm.reminders
       where user_id = $1
         and (
           (completed_at is null and (due_on = $2::date or ($2::date = $3::date and due_on < $2::date)))
           or (completed_at is not null and (completed_at at time zone $4)::date = $2::date)
         )
       order by completed_at nulls first, due_on, due_at nulls first, created_at, id`,
      [person.userId, day, current, appTimeZone()],
    );
    return { reminders: result.rows.map(toReminder) };
  });
}

export async function getReminder(actor: Actor, id: string) {
  const person = personOf(actor, "crm:read");
  if (!isUuid(id)) throw notFound("reminder");
  return withActor(person, async (db) => {
    const row = await readRow(db, id);
    if (!row) throw notFound("reminder");
    return { reminder: toReminder(row) };
  });
}

export async function createReminder(actor: Actor, input: ReminderInput, options: { now?: number; idempotencyKey?: string | null } = {}) {
  const person = personOf(actor, "tasks:write");
  if (!options.idempotencyKey) return addReminder(person, input, options.now);
  const key = options.idempotencyKey;
  return withActor(person, async (db) => (await replayOrRun(db, person, key, requestHash("create_reminder", input), 201, () => addReminder(person, input, options.now, db))).body);
}

async function addReminder(person: UserActor, input: ReminderInput, at?: number, within?: Db) {
  const now = at ?? Date.now();
  const title = cleanTitle(input.title);
  if (input.blocksTime !== undefined && typeof input.blocksTime !== "boolean") invalid("blocksTime is true or false.", "blocksTime");
  const timing = readTiming(input, null) ?? { dueOn: null, dueAt: null };
  if (timing.dueAt && Date.parse(timing.dueAt) <= now) invalid(TIME_PASSED, "dueAt");
  const repeat = repeatFrom(input, timing.dueOn, now) ?? null;
  const settled = settleRepeat({ ...timing, rule: repeat?.rule ?? null, ends: repeat?.ends ?? null });
  const blocksTime = input.blocksTime === true;
  if (blocksTime && !settled.dueAt) invalid(NEEDS_TIME_TO_BLOCK, "blocksTime");
  const durationMinutes = input.durationMinutes === undefined ? DEFAULT_TASK_DURATION : readDuration(input.durationMinutes);
  const insert = async (db: Db) => {
    await assertRoom(db, person.userId, { open: true, repeating: Boolean(settled.rule) });
    const result = await db.query<Row>(
      `insert into crm.reminders (user_id, title, due_on, due_at, blocks_time, duration_minutes, repeat_rule, repeat_ends)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning ${COLUMNS}`,
      [person.userId, title, settled.dueOn, settled.dueAt, blocksTime, durationMinutes, settled.rule, settled.ends],
    );
    return { reminder: toReminder(result.rows[0]) };
  };
  return within ? insert(within) : withActor(person, insert);
}

export async function updateReminder(actor: Actor, id: string, input: ReminderInput, options: { now?: number } = {}) {
  const person = personOf(actor, "tasks:write");
  const now = options.now ?? Date.now();
  const title = input.title === undefined ? undefined : cleanTitle(input.title);
  const durationMinutes = input.durationMinutes === undefined ? undefined : readDuration(input.durationMinutes);
  if (input.blocksTime !== undefined && typeof input.blocksTime !== "boolean") invalid("blocksTime is true or false.", "blocksTime");
  return withActor(person, async (db) => {
    const row = await lockedRow(db, id);
    if (row.completed_at) invalid(REOPEN_FIRST);
    const timing = readTiming(input, { dueOn: row.due_on, dueAt: row.due_at });
    const dueOn = timing ? timing.dueOn : row.due_on;
    const dueAt = timing ? timing.dueAt : iso(row.due_at);
    const repeat = repeatFrom(input, dueOn, now);
    let rule = repeat === undefined ? row.repeat_rule : (repeat?.rule ?? null);
    const ends = repeat === undefined ? row.repeat_ends : (repeat?.ends ?? null);
    if (repeat === undefined && rule && row.due_on && dueOn && dueOn !== row.due_on) rule = reanchor(rule, row.due_on, dueOn);
    if (rule && !dueOn) invalid(NEEDS_DATE_TO_REPEAT, "repeat");
    const settled = settleRepeat({ dueOn, dueAt, rule, ends });
    const blocksTime = input.blocksTime ?? (row.blocks_time && Boolean(settled.dueAt));
    if (blocksTime && !settled.dueAt) invalid(NEEDS_TIME_TO_BLOCK, "blocksTime");
    await assertRoom(db, person.userId, { open: false, repeating: Boolean(settled.rule) && !row.repeat_rule });
    const result = await db.query<Row>(
      `update crm.reminders
       set title = $2, due_on = $3, due_at = $4, blocks_time = $5, duration_minutes = $6, repeat_rule = $7, repeat_ends = $8
       where id = $1
       returning ${COLUMNS}`,
      [row.id, title ?? row.title, settled.dueOn, settled.dueAt, blocksTime, durationMinutes ?? row.duration_minutes, settled.rule, settled.ends],
    );
    return { reminder: toReminder(result.rows[0]) };
  });
}

function nextDate(row: Row, now: number) {
  const ends = row.repeat_ends!;
  const pattern = patternOf(row.due_on!, row.due_at, row.repeat_rule!, "until" in ends ? { until: ends.until } : { never: true });
  const from = shiftDay(row.due_on! > today(now) ? row.due_on! : today(now), 1);
  const spent = ("count" in ends ? (ends.spent ?? 0) : 0) + 1;
  const next = occurrenceOnOrAfter(pattern, from);
  const ended = !next || ("count" in ends && spent >= ends.count);
  return { next: ended ? null : next, at: pattern.at, ends: ("count" in ends ? { count: ends.count, spent } : ends) as RepeatEnds };
}

export async function completeReminder(actor: Actor, id: string, input: { dueOn?: string | null } = {}, options: { now?: number } = {}): Promise<TickResult> {
  const person = personOf(actor, "tasks:write");
  const now = options.now ?? Date.now();
  if (input.dueOn !== undefined && input.dueOn !== null && !isDayKey(input.dueOn)) invalid("dueOn takes a day, such as 2026-11-20.", "dueOn");
  return withActor(person, async (db) => {
    const row = await lockedRow(db, id);
    if (row.completed_at) return { reminder: toReminder(row), doneId: null, changed: false };
    if (!row.repeat_rule || !row.repeat_ends || !row.due_on) {
      const done = await db.query<Row>(`update crm.reminders set completed_at = now() where id = $1 returning ${COLUMNS}`, [row.id]);
      return { reminder: toReminder(done.rows[0]), doneId: row.id, changed: true };
    }
    if (!input.dueOn) invalid(NEEDS_DUE_ON, "dueOn");
    if (input.dueOn < row.due_on) return { reminder: toReminder(row), doneId: null, changed: false };
    if (input.dueOn > row.due_on) throw new CrmError("conflict", `This reminder is due on ${dayMonth(row.due_on)}. Tick that date.`, 409, { field: "dueOn", dueOn: row.due_on });
    const step = nextDate(row, now);
    if (!step.next) {
      const done = await db.query<Row>(`update crm.reminders set completed_at = now(), repeat_ends = $2 where id = $1 returning ${COLUMNS}`, [row.id, step.ends]);
      return { reminder: toReminder(done.rows[0]), doneId: row.id, changed: true };
    }
    const copy = await db.query<{ id: string }>(
      `insert into crm.reminders (user_id, title, due_on, due_at, blocks_time, duration_minutes, completed_at, repeat_of, moved_to, pushed_for)
       values ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9)
       returning id`,
      [row.user_id, row.title, row.due_on, row.due_at, row.blocks_time, row.duration_minutes, row.id, step.next, row.pushed_for],
    );
    const moved = await db.query<Row>(
      `update crm.reminders set due_on = $2, due_at = $3, repeat_ends = $4 where id = $1 returning ${COLUMNS}`,
      [row.id, step.next, timeOnDay(step.next, step.at), step.ends],
    );
    return { reminder: toReminder(moved.rows[0]), doneId: copy.rows[0].id, changed: true };
  });
}

function unspent(ends: RepeatEnds | null): RepeatEnds | null {
  if (!ends || !("count" in ends)) return ends;
  return { count: ends.count, spent: Math.max(0, (ends.spent ?? 0) - 1) };
}

export async function reopenReminder(actor: Actor, id: string) {
  const person = personOf(actor, "tasks:write");
  return withActor(person, async (db) => {
    const row = await lockedRow(db, id);
    if (!row.completed_at) return { reminder: toReminder(row), changed: false };
    if (row.repeat_of) {
      const parent = await lockedRow(db, row.repeat_of).catch((error) => {
        if (error instanceof CrmError && error.code === "not_found") return null;
        throw error;
      });
      if (parent) {
        if (parent.completed_at || !parent.repeat_rule || parent.due_on !== row.moved_to) throw new CrmError("conflict", MOVED_ON, 409);
        await db.query("delete from crm.reminders where id = $1", [row.id]);
        const back = await db.query<Row>(
          `update crm.reminders set due_on = $2, due_at = $3, repeat_ends = $4, pushed_for = $5 where id = $1 returning ${COLUMNS}`,
          [parent.id, row.due_on, timeOnDay(row.due_on!, clockOf(parent.due_at)), unspent(parent.repeat_ends), row.pushed_for],
        );
        return { reminder: toReminder(back.rows[0]), changed: true };
      }
    }
    await assertRoom(db, person.userId, { open: true, repeating: Boolean(row.repeat_rule) });
    const reopened = await db.query<Row>(
      `update crm.reminders set completed_at = null, repeat_of = null, moved_to = null, repeat_ends = $2 where id = $1 returning ${COLUMNS}`,
      [row.id, unspent(row.repeat_ends)],
    );
    return { reminder: toReminder(reopened.rows[0]), changed: true };
  });
}

export async function deleteReminder(actor: Actor, id: string) {
  const person = personOf(actor, "tasks:write");
  if (!isUuid(id)) return { id, deleted: false };
  return withActor(person, async (db) => {
    const result = await db.query("delete from crm.reminders where id = $1", [id]);
    return { id, deleted: (result.rowCount ?? 0) > 0 };
  });
}

export async function getReminderSettings(actor: Actor) {
  const person = personOf(actor, "crm:read");
  return withActor(person, async (db) => {
    const result = await db.query<{ morning_at: string }>("select to_char(morning_at, 'HH24:MI') as morning_at from crm.reminder_settings where user_id = $1", [person.userId]);
    return { morningAt: result.rows[0]?.morning_at ?? DEFAULT_MORNING };
  });
}

export async function setReminderMorning(actor: Actor, morningAt: unknown) {
  const person = personOf(actor, "tasks:write");
  if (!isClock(morningAt)) invalid("Choose a time, such as 08:00.", "morningAt");
  return withActor(person, async (db) => {
    await db.query(
      `insert into crm.reminder_settings (user_id, morning_at) values ($1, $2::time)
       on conflict (user_id) do update set morning_at = excluded.morning_at`,
      [person.userId, morningAt],
    );
    return { morningAt };
  });
}
