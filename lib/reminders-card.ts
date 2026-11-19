import type { Reminder, ReminderInput } from "@/lib/crm/reminders";
import { clockLabel, localInstant, MAX_TASK_DURATION, MIN_TASK_DURATION, taskDueDay } from "@/lib/crm/task-time";
import { shiftDay } from "@/lib/crm/working-days";
import { formatDateLabel, todayValue } from "@/lib/date-input";
import { padDueHasTime, padReading, padRepeatDue, parseTaskText, readingKey, readPhrase, type PadMark, type PadRepeat } from "@/lib/task-pad";
import { repeatInputOf, ruleWords, WORKWEEK, weekdayOf, type MonthWeek, type RepeatEnds, type RepeatInput, type RepeatRule, type Weekday } from "@/lib/task-repeat";

export type HeldTick = { snapshot: Reminder; doneId: string | null };

export type ReminderRow = { key: string; reminder: Reminder; ticked: boolean; overdue: boolean };

export type ReminderGroups = { today: ReminderRow[]; upcoming: ReminderRow[]; noDate: ReminderRow[]; done: Reminder[] };

export function remindersToday(now = new Date()) {
  return todayValue(now);
}

function byDue(left: Reminder, right: Reminder) {
  if (left.dueOn !== right.dueOn) {
    if (!left.dueOn) return 1;
    if (!right.dueOn) return -1;
    return left.dueOn < right.dueOn ? -1 : 1;
  }
  if (left.dueAt !== right.dueAt) {
    if (!left.dueAt) return -1;
    if (!right.dueAt) return 1;
    return left.dueAt < right.dueAt ? -1 : 1;
  }
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function stillWaiting(reminder: Reminder, held: HeldTick | undefined) {
  return Boolean(held && reminder.dueOn === held.snapshot.dueOn && reminder.dueAt === held.snapshot.dueAt);
}

export function groupReminders(reminders: Reminder[], held: Record<string, HeldTick>, today: string): ReminderGroups {
  const heldDone = new Set(Object.values(held).flatMap((tick) => [tick.doneId, tick.snapshot.id]));
  const rows: ReminderRow[] = [];
  for (const reminder of reminders) {
    if (reminder.completedAt || stillWaiting(reminder, held[reminder.id])) continue;
    rows.push({ key: reminder.id, reminder, ticked: false, overdue: Boolean(reminder.dueOn && reminder.dueOn < today) });
  }
  for (const tick of Object.values(held)) {
    const reminder = tick.snapshot;
    rows.push({ key: `ticked:${reminder.id}`, reminder, ticked: true, overdue: Boolean(reminder.dueOn && reminder.dueOn < today) });
  }
  rows.sort((left, right) => byDue(left.reminder, right.reminder) || Number(left.ticked) - Number(right.ticked));
  const done = reminders
    .filter((reminder) => reminder.completedAt && !heldDone.has(reminder.id))
    .sort((left, right) => (left.completedAt! < right.completedAt! ? 1 : left.completedAt! > right.completedAt! ? -1 : 0));
  return {
    today: rows.filter((row) => row.reminder.dueOn && row.reminder.dueOn <= today),
    upcoming: rows.filter((row) => row.reminder.dueOn && row.reminder.dueOn > today),
    noDate: rows.filter((row) => !row.reminder.dueOn),
    done,
  };
}

export function dueCount(reminders: Reminder[], today: string) {
  return reminders.filter((reminder) => !reminder.completedAt && reminder.dueOn && reminder.dueOn <= today).length;
}

export function dayLabel(day: string, today: string, now = new Date()) {
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  if (day === shiftDay(today, 1)) return "Tomorrow";
  return formatDateLabel(day, now);
}

export function repeatWords(reminder: Pick<Reminder, "repeat" | "dueOn">) {
  const draft = draftOfRepeat(reminder.repeat, reminder.dueOn);
  return draft && reminder.dueOn ? ruleWords({ rule: draft.rule, startsOn: reminder.dueOn }) : null;
}

export type AddGuess = { due: string; key: string; phrase: string };

export type AddLength = { minutes: number; key: string; phrase: string; start: number; end: number };

export type AddReading = {
  title: string;
  due: string | null;
  repeat: PadRepeat | null;
  durationMinutes: number | null;
  phrase: string;
  key: string;
  marks: PadMark[];
  guess: AddGuess | null;
  length: AddLength | null;
};

const LENGTH = /\bfor\s+(\d{1,3}(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h)\b/i;

export function readLength(text: string): AddLength | null {
  const match = LENGTH.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  const hours = /^h/i.test(match[2]);
  if (!hours && !Number.isInteger(amount)) return null;
  const minutes = Math.round(hours ? amount * 60 : amount);
  if (minutes < MIN_TASK_DURATION || minutes > MAX_TASK_DURATION) return null;
  return { minutes, key: `length:${match[0].toLowerCase().replace(/\s+/g, " ")}`, phrase: match[0], start: match.index, end: match.index + match[0].length };
}

function textWithout(text: string, marks: PadMark[]) {
  let result = "";
  let last = 0;
  for (const mark of [...marks].sort((left, right) => left.start - right.start)) {
    result += ` ${text.slice(last, mark.start)} `;
    last = Math.max(last, mark.end);
  }
  result += text.slice(last);
  return result
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
    .trim();
}

export function readAddLine(text: string, choices: { confirmed: string | null; kept: readonly string[] }, now = new Date()): AddReading {
  const found = readLength(text);
  const source = found ? `${text.slice(0, found.start)}${" ".repeat(found.end - found.start)}${text.slice(found.end)}` : text;
  const parsed = parseTaskText(source, now);
  const guessMarks = parsed.marks.filter((mark) => mark.kind === "when");
  const guessKey = parsed.unsure && parsed.guess && guessMarks.length > 0 ? readingKey(source, guessMarks) : null;
  const confirmed = guessKey !== null && choices.confirmed === guessKey && !choices.kept.includes(guessKey);
  const ai = confirmed ? { title: textWithout(source, guessMarks) || source.trim(), due: parsed.guess, remindMinutes: null, durationMinutes: parsed.durationMinutes, marks: guessMarks } : null;
  const reading = padReading(source, parsed, ai, choices.kept);
  const repeat = reading.due ? (reading.repeat ?? null) : null;
  const due = repeat ? (padRepeatDue(repeat, reading.due, now) ?? reading.due) : reading.due;
  const timed = Boolean(due && padDueHasTime(due));
  const length = found && timed && !choices.kept.includes(found.key) ? found : null;
  const dateMarks = reading.marks.filter((mark) => mark.kind !== "reminder");
  const marks = length ? [...dateMarks, { start: length.start, end: length.end, kind: "when" as const }] : dateMarks;
  const ownTitle = !reading.key || (found && !length) || dateMarks.length !== reading.marks.length;
  const title = !reading.key ? text.replace(/\s+/g, " ").trim() : ownTitle ? textWithout(text, marks) || text.trim() : reading.title;
  const offered = !reading.key && guessKey !== null && parsed.guess && !choices.kept.includes(guessKey) ? { due: parsed.guess, key: guessKey, phrase: readPhrase(source, guessMarks) } : null;
  return {
    title,
    due,
    repeat,
    durationMinutes: length ? length.minutes : timed ? reading.durationMinutes : null,
    phrase: reading.phrase,
    key: reading.key,
    marks,
    guess: offered,
    length,
  };
}

export function reminderInputOf(reading: Pick<AddReading, "title" | "due" | "repeat" | "durationMinutes">): ReminderInput {
  const input: ReminderInput = { title: reading.title };
  if (reading.due && padDueHasTime(reading.due)) input.dueAt = localInstant(reading.due);
  else if (reading.due) input.dueOn = reading.due;
  if (reading.due && reading.repeat) input.repeat = repeatInputOf(reading.repeat.rule, reading.repeat.ends);
  if (reading.durationMinutes && reading.due && padDueHasTime(reading.due)) {
    input.blocksTime = true;
    input.durationMinutes = reading.durationMinutes;
  }
  return input;
}

export function reminderDue(reminder: Pick<Reminder, "dueOn" | "time">) {
  if (!reminder.dueOn) return null;
  return reminder.time ? `${reminder.dueOn}T${reminder.time}` : reminder.dueOn;
}

export function dueChange(value: string | null): ReminderInput {
  if (!value) return { dueOn: null };
  if (padDueHasTime(value)) return { dueAt: localInstant(value) };
  return { dueOn: value, dueAt: null };
}

function weekdayFrom(value: string): Weekday | null {
  const key = value.trim().toLowerCase().slice(0, 2);
  return (["mo", "tu", "we", "th", "fr", "sa", "su"] as const).find((day) => day === key) ?? null;
}

export function draftOfRepeat(input: RepeatInput | null, startsOn: string | null): PadRepeat | null {
  if (!input || !startsOn) return null;
  const interval = input.interval ?? 1;
  let rule: RepeatRule;
  if (input.every === "day") rule = { freq: "daily", interval };
  else if (input.every === "weekday") rule = { freq: "weekly", interval, weekdays: [...WORKWEEK] };
  else if (input.every === "week") {
    const days = (input.days ?? []).map(weekdayFrom).filter((day): day is Weekday => day !== null);
    rule = { freq: "weekly", interval, weekdays: days.length > 0 ? days : [weekdayOf(startsOn)] };
  } else if (input.every === "month") {
    const week = input.monthWeek ? weekdayFrom(input.monthWeek.weekday) : null;
    rule = input.monthWeek && week
      ? { freq: "monthly", interval, monthWeek: { n: input.monthWeek.n as MonthWeek["n"], weekday: week } }
      : { freq: "monthly", interval, monthDay: input.monthDay ?? Number(startsOn.slice(8, 10)) };
  } else rule = { freq: "yearly", interval };
  const ends: RepeatEnds = input.ends && "after" in input.ends ? { count: input.ends.after } : input.ends && "on" in input.ends ? { until: input.ends.on } : { never: true };
  return { rule, ends };
}

export type CardPoint = { x: number; y: number };
export type CardSize = { width: number; height: number };

export const CARD_MARGIN = 8;
export const CARD_TOP = 64;
export const CARD_RIGHT = 18;
export const CARD_HEADER = 44;

export function defaultCardPosition(size: CardSize, viewport: CardSize, beside = 0): CardPoint {
  return clampCardPosition({ x: viewport.width - beside - size.width - CARD_RIGHT, y: CARD_TOP }, size, viewport, beside);
}

export function clampCardPosition(point: CardPoint, size: CardSize, viewport: CardSize, beside = 0): CardPoint {
  const maxX = Math.max(CARD_MARGIN, viewport.width - beside - size.width - CARD_MARGIN);
  const maxY = Math.max(CARD_MARGIN, viewport.height - Math.min(size.height, CARD_HEADER * 2) - CARD_MARGIN);
  return {
    x: Math.round(Math.min(maxX, Math.max(CARD_MARGIN, point.x))),
    y: Math.round(Math.min(maxY, Math.max(CARD_MARGIN, point.y))),
  };
}

export function readCardPosition(raw: string | null): CardPoint | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const { x, y } = value as Record<string, unknown>;
    return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

export function optimisticReminder(reminder: Reminder, change: ReminderInput): Reminder {
  const next: Reminder = { ...reminder };
  if (change.title !== undefined) next.title = change.title ?? reminder.title;
  if (change.blocksTime !== undefined) next.blocksTime = change.blocksTime;
  if (change.durationMinutes !== undefined) next.durationMinutes = change.durationMinutes;
  if (typeof change.dueAt === "string" && change.dueAt) {
    next.dueAt = change.dueAt;
    next.dueOn = taskDueDay(change.dueAt);
    next.time = clockLabel(change.dueAt);
  } else if (change.dueOn !== undefined) {
    next.dueOn = change.dueOn;
    if (change.dueOn === null || change.dueAt === null) {
      next.dueAt = null;
      next.time = null;
    } else if (reminder.time) {
      next.dueAt = localInstant(`${change.dueOn}T${reminder.time}`);
    }
  } else if (change.dueAt === null) {
    next.dueAt = null;
    next.time = null;
  }
  if (!next.time) next.blocksTime = false;
  if (change.repeat !== undefined) {
    next.repeat = change.repeat;
    next.repeatText = null;
  }
  return next;
}

export type AddKey = { typed: string; key: string };

export function addKeyFor(current: AddKey | null, input: ReminderInput, fresh: () => string): AddKey {
  const typed = JSON.stringify(input);
  return current?.typed === typed ? current : { typed, key: fresh() };
}

export function taskStartOf(reminder: Reminder) {
  return {
    title: reminder.title,
    due: reminderDue(reminder),
    durationMinutes: reminder.durationMinutes,
    repeat: draftOfRepeat(reminder.repeat, reminder.dueOn),
  };
}

export type AddDraft = { text: string; confirmed: string | null; kept: string[]; key: AddKey | null };

export const EMPTY_DRAFT: AddDraft = { text: "", confirmed: null, kept: [], key: null };

export const REMINDER_NOT_REMOVED = "Couldn't remove the reminder. Try again.";
