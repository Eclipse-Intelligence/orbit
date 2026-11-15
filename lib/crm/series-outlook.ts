import { createHash, randomUUID } from "node:crypto";
import { actingActor, graphFailure, openOutlook, taskBlockLink, type Access, type Failure, type Outlook } from "@/lib/crm/task-outlook";
import { clockLabel, dayStartIso, wallInstant } from "@/lib/crm/task-time";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { withActor } from "@/lib/crm/context";
import { readStored } from "@/lib/crm/inbox";
import { query } from "@/lib/db/pool";
import {
  createGraphEvent,
  deleteGraphEvent,
  findTaskBlockEvents,
  graphInstant,
  graphTimeZoneName,
  listSeriesInstances,
  patchGraphEvent,
  taskBlockBodyHtml,
  taskBlockDraft,
  type GraphRecurrence,
  type SeriesMasterDraft,
} from "@/lib/microsoft/calendar";
import {
  lastOccurrence,
  occurrenceFor,
  occurrenceOnOrAfter,
  occurrenceTiming,
  WEEKDAYS,
  type OccurrenceChange,
  type RepeatEnds,
  type RepeatPattern,
  type RepeatRule,
} from "@/lib/task-repeat";
import { appTimeZone } from "@/lib/time";

const MINUTE_MS = 60_000;
const RUN_LIMIT = 50;
const RESERVE_MS = 4_000;
const CREATE_GRACE_MS = 2 * MINUTE_MS;
const RETRY_MS = 5 * MINUTE_MS;
const LEASE_MS = 2 * MINUTE_MS - 15_000;

const GRAPH_DAYS: Record<string, string> = {
  mo: "monday",
  tu: "tuesday",
  we: "wednesday",
  th: "thursday",
  fr: "friday",
  sa: "saturday",
  su: "sunday",
};

const GRAPH_INDEX = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" } as const;

export type SeriesOutlookRow = {
  series_id: string;
  workspace_id: string;
  owner_id: string | null;
  owner_member: boolean;
  title: string;
  starts_on: string;
  at: string | null;
  duration_minutes: number;
  rule: RepeatRule;
  ends: RepeatEnds;
  ended: boolean;
  current_task_id: string | null;
  current_occurs_on: string | null;
  current_due_at: Date | string | null;
  changes: (OccurrenceChange & { dueAt: string | null })[] | null;
  user_id: string | null;
  master_id: string | null;
  create_key: string | null;
  create_user_id: string | null;
  create_sent_at: Date | string | null;
  written: MasterSpec | null;
  dates: Record<string, DateRecord> | null;
  version: string | number;
  attempts: number;
};

export type MasterSpec = {
  startDay: string;
  at: string;
  durationMinutes: number;
  title: string;
  link: string | null;
  recurrence: GraphRecurrence;
  revision?: string;
};

export type DateWant = { skip: true } | { skip?: false; start: string; end: string; title: string };

export type DateRecord = {
  instance?: "patched" | "deleting" | "deleted";
  instanceId?: string;
  single?: string;
  createKey?: string;
  rev?: string;
  written?: { start: string; end: string; title: string } | null;
};

export type SeriesPlan =
  | { kind: "remove" }
  | { kind: "write"; userId: string; master: MasterSpec | null; link: string | null; dates: Record<string, DateWant | null> };

export type SeriesRun = { written: number; removed: number; unchanged: number; deferred: number; throttled: number; orbitOnly: number; requests: number };

export const SERIES_SHARE = 30;

function day(value: string | null) {
  return value ? String(value).slice(0, 10) : null;
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function seriesRecurrence(pattern: RepeatPattern, startDay: string, lastDay: string | null, timeZone = appTimeZone()): GraphRecurrence {
  const { rule } = pattern;
  const interval = Math.max(1, Math.trunc(rule.interval) || 1);
  const anchor = pattern.startsOn;
  const shape: GraphRecurrence["pattern"] =
    rule.freq === "daily"
      ? { type: "daily", interval }
      : rule.freq === "weekly"
        ? {
            type: "weekly",
            interval,
            daysOfWeek: WEEKDAYS.filter((name) => rule.weekdays?.includes(name)).map((name) => GRAPH_DAYS[name]),
            firstDayOfWeek: "monday",
          }
        : rule.freq === "monthly"
          ? rule.monthWeek
            ? { type: "relativeMonthly", interval, daysOfWeek: [GRAPH_DAYS[rule.monthWeek.weekday]], index: GRAPH_INDEX[rule.monthWeek.n] }
            : { type: "absoluteMonthly", interval, dayOfMonth: rule.monthDay ?? Number(anchor.slice(8, 10)) }
          : { type: "absoluteYearly", interval, month: Number(anchor.slice(5, 7)), dayOfMonth: Number(anchor.slice(8, 10)) };
  const zone = graphTimeZoneName(timeZone) ?? "UTC";
  return {
    pattern: shape,
    range: lastDay ? { type: "endDate", startDate: startDay, endDate: lastDay, recurrenceTimeZone: zone } : { type: "noEnd", startDate: startDay, recurrenceTimeZone: zone },
  };
}

function patternOf(row: SeriesOutlookRow): RepeatPattern {
  return { startsOn: day(row.starts_on)!, at: row.at, rule: row.rule, ends: row.ends };
}

function changesOf(row: SeriesOutlookRow): OccurrenceChange[] {
  return (row.changes ?? []).map((change) => ({ ...change, dueAt: iso(change.dueAt) }));
}

function afterDays(row: SeriesOutlookRow, timeZone: string) {
  const occurs = day(row.current_occurs_on);
  const due = row.current_due_at ? dayKeyAt(new Date(row.current_due_at), timeZone) : null;
  return { occurs, after: occurs && due ? (due > occurs ? due : occurs) : (occurs ?? due) };
}

export function firstOutlookDay(row: SeriesOutlookRow, now: number, timeZone = appTimeZone()) {
  const pattern = patternOf(row);
  const { after } = afterDays(row, timeZone);
  const today = dayKeyAt(new Date(now), timeZone);
  const from = after ? shiftDay(after, 1) : pattern.startsOn;
  return occurrenceOnOrAfter(pattern, from > today ? from : today);
}

export function defaultWant(row: SeriesOutlookRow, occursOn: string, timeZone = appTimeZone()): Extract<DateWant, { start: string }> {
  const timing = occurrenceTiming(row.at, occursOn, timeZone);
  return { start: timing.dueAt, end: new Date(Date.parse(timing.dueAt) + row.duration_minutes * MINUTE_MS).toISOString(), title: row.title };
}

export function planSeriesOutlook(row: SeriesOutlookRow, now: number, timeZone = appTimeZone()): SeriesPlan {
  if (!row.owner_id || !row.owner_member || row.ended) return { kind: "remove" };
  const pattern = patternOf(row);
  const { occurs, after } = afterDays(row, timeZone);
  const today = dayKeyAt(new Date(now), timeZone);
  const startDay = row.at ? firstOutlookDay(row, now, timeZone) : null;
  const lastDay = lastOccurrence(pattern);
  const link = row.current_task_id ? taskBlockLink(row.current_task_id, row.workspace_id) : null;
  const master: MasterSpec | null =
    row.at && startDay
      ? { startDay, at: row.at, durationMinutes: row.duration_minutes, title: row.title, link, recurrence: seriesRecurrence(pattern, startDay, lastDay, timeZone) }
      : null;
  const hasInstance = (occursOn: string) => Boolean(master && startDay && occursOn >= startDay && occurrenceOnOrAfter(pattern, occursOn) === occursOn);
  const dates: Record<string, DateWant | null> = {};
  for (const change of changesOf(row)) {
    if ((occurs && change.occursOn <= occurs) || (lastDay && change.occursOn > lastDay)) continue;
    const occurrence = occurrenceFor(pattern, change.occursOn, change, timeZone);
    const shows = !change.skip && occurrence.dueHasTime && (!after || occurrence.day > after) && occurrence.day >= today;
    if (!shows) {
      if (hasInstance(change.occursOn)) dates[change.occursOn] = { skip: true };
      continue;
    }
    const start = occurrence.dueAt;
    const minutes = occurrence.durationMinutes ?? row.duration_minutes;
    dates[change.occursOn] = { start, end: new Date(Date.parse(start) + minutes * MINUTE_MS).toISOString(), title: occurrence.title ?? row.title };
  }
  for (const occursOn of Object.keys(row.dates ?? {})) {
    if (occursOn in dates) continue;
    if (hasInstance(occursOn)) dates[occursOn] = defaultWant(row, occursOn, timeZone);
    else dates[occursOn] = master && startDay && occursOn >= startDay ? { skip: true } : null;
  }
  const timedDates = Object.values(dates).some((want) => want !== null && !want.skip);
  if (!master && !timedDates && !holds(row)) return { kind: "remove" };
  return { kind: "write", userId: row.owner_id, master, link, dates };
}

export function seriesTransactionId(seriesId: string, key: string) {
  const hex = createHash("sha256").update(`series|${seriesId}|${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function wall(instant: number, timeZone: string) {
  const date = new Date(instant);
  return `${dayKeyAt(date, timeZone)}T${clockLabel(date.toISOString(), timeZone)}:00`;
}

export function masterDraft(seriesId: string, spec: MasterSpec, key: string, timeZone = appTimeZone()): SeriesMasterDraft {
  const [hour, minute] = spec.at.split(":").map(Number);
  const start = wallInstant(spec.startDay, hour, minute, timeZone);
  const end = start + spec.durationMinutes * MINUTE_MS;
  const zone = graphTimeZoneName(timeZone);
  const base = taskBlockDraft({
    title: spec.title,
    start: new Date(start),
    end: new Date(end),
    timeZone,
    link: spec.link,
    transactionId: seriesTransactionId(seriesId, key),
    key: `series:${seriesId}:${key}`,
  });
  if (!zone) {
    const utc = (instant: number) => ({ dateTime: new Date(instant).toISOString().slice(0, 19), timeZone: "UTC" });
    return { ...base, start: utc(start), end: utc(end), recurrence: spec.recurrence };
  }
  return {
    ...base,
    start: { dateTime: `${spec.startDay}T${spec.at}:00`, timeZone: zone },
    end: { dateTime: wall(end, timeZone), timeZone: zone },
    recurrence: spec.recurrence,
  };
}

function masterPatch(spec: MasterSpec, timeZone = appTimeZone()): Partial<SeriesMasterDraft> {
  const draft = masterDraft("patch", spec, "patch", timeZone);
  return {
    subject: draft.subject,
    body: draft.body,
    start: draft.start,
    end: draft.end,
    recurrence: draft.recurrence,
    showAs: "busy",
    sensitivity: "private",
    isReminderOn: false,
  };
}

export function singleKey(seriesId: string, createKey: string) {
  return `series:${seriesId}:single:${createKey}`;
}

function singleDraft(seriesId: string, createKey: string, want: Extract<DateWant, { start: string }>, link: string | null, timeZone: string) {
  return taskBlockDraft({
    title: want.title,
    start: new Date(want.start),
    end: new Date(want.end),
    timeZone,
    link,
    transactionId: seriesTransactionId(seriesId, `single|${createKey}`),
    key: singleKey(seriesId, createKey),
  });
}

function timesPatch(want: Extract<DateWant, { start: string }>, link: string | null, timeZone: string) {
  const draft = taskBlockDraft({ title: want.title, start: new Date(want.start), end: new Date(want.end), timeZone, link, transactionId: "", key: "" });
  return { subject: draft.subject, body: { contentType: "HTML" as const, content: taskBlockBodyHtml(link) }, start: draft.start, end: draft.end, showAs: "busy", sensitivity: "private", isReminderOn: false };
}

function written(want: Extract<DateWant, { start: string }>) {
  return { start: want.start, end: want.end, title: want.title };
}

function sameWritten(left: DateRecord["written"], right: Extract<DateWant, { start: string }>) {
  return Boolean(left) && left!.start === right.start && left!.end === right.end && left!.title === right.title;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sameMaster(left: MasterSpec | null, right: MasterSpec) {
  return stable(left ? { ...left, revision: undefined, datesPending: undefined } : null) === stable({ ...right, revision: undefined });
}

class Throttled extends Error {
  constructor(readonly userId: string) {
    super("throttled");
  }
}

class GraphFail extends Error {
  constructor(readonly failure: Failure) {
    super(failure);
  }
}

class Retry extends Error {}
class OutOfTime extends Error {}

type Context = { fetchImpl: typeof fetch; timeZone: string; budget: { left: number }; stopAt: number };

function checkTime(context: Context) {
  if (Date.now() >= context.stopAt) throw new OutOfTime();
}

function failureOf(error: unknown, outlook: Outlook) {
  if (error instanceof OutOfTime || error instanceof Throttled || error instanceof GraphFail) return error;
  const failure = graphFailure(error);
  return failure === "throttled" ? new Throttled(outlook.actor.userId) : new GraphFail(failure);
}

async function graphWrite<T>(context: Context, outlook: Outlook, run: () => Promise<T>): Promise<T> {
  checkTime(context);
  if (context.budget.left <= 0) throw new OutOfTime();
  try {
    return await run();
  } catch (error) {
    throw failureOf(error, outlook);
  }
}

async function graphRead<T>(context: Context, outlook: Outlook, run: () => Promise<T>): Promise<T> {
  checkTime(context);
  try {
    return await run();
  } catch (error) {
    throw failureOf(error, outlook);
  }
}

function failed(error: unknown, ...kinds: Failure[]) {
  return error instanceof GraphFail && kinds.includes(error.failure);
}

type State = { userId: string | null; masterId: string | null; written: MasterSpec | null; dates: Record<string, DateRecord> };

async function save(row: SeriesOutlookRow, state: State, clearKey = false) {
  await query("select private.save_series_outlook($1, $2, $3, $4, $5, $6)", [
    row.series_id,
    state.userId,
    state.masterId,
    state.written ? JSON.stringify(state.written) : null,
    JSON.stringify(state.dates),
    clearKey,
  ]);
}

function holds(row: SeriesOutlookRow) {
  return Boolean(row.master_id) || Object.values(row.dates ?? {}).some((record) => record.single || record.createKey);
}

async function deleteByKey(outlook: Outlook, key: string, context: Context) {
  const found = await graphRead(context, outlook, () => findTaskBlockEvents(outlook.token.accessToken, key, context.fetchImpl));
  for (const event of found) if (event.id) await graphWrite(context, outlook, () => deleteGraphEvent(outlook.token.accessToken, event.id!, context.fetchImpl));
}

async function deleteUnrecordedMaster(outlook: Outlook, row: SeriesOutlookRow, context: Context) {
  if (row.create_key && row.create_user_id === outlook.actor.userId) await deleteByKey(outlook, `series:${row.series_id}:${row.create_key}`, context);
}

async function removeAll(outlook: Outlook, row: SeriesOutlookRow, context: Context) {
  const dates = { ...(row.dates ?? {}) };
  for (const [occursOn, record] of Object.entries(dates)) {
    if (record.single) await graphWrite(context, outlook, () => deleteGraphEvent(outlook.token.accessToken, record.single!, context.fetchImpl));
    if (record.createKey) await deleteByKey(outlook, singleKey(row.series_id, record.createKey), context);
    delete dates[occursOn];
    await save(row, { userId: row.user_id, masterId: row.master_id, written: row.written, dates });
  }
  if (row.master_id) {
    await save(row, { userId: row.user_id, masterId: row.master_id, written: null, dates });
    await graphWrite(context, outlook, () => deleteGraphEvent(outlook.token.accessToken, row.master_id!, context.fetchImpl));
  }
  await deleteUnrecordedMaster(outlook, row, context);
  await save(row, { userId: null, masterId: null, written: null, dates: {} }, true);
}

async function findInstance(outlook: Outlook, masterId: string, occursOn: string, context: Context) {
  const start = new Date(dayStartIso(occursOn, context.timeZone));
  const end = new Date(dayStartIso(shiftDay(occursOn, 1), context.timeZone));
  const found = await graphRead(context, outlook, () => listSeriesInstances(outlook.token.accessToken, masterId, start, end, context.fetchImpl));
  const match = found.find((event) => {
    const original = event.originalStart ? Date.parse(event.originalStart) : NaN;
    const at = Number.isNaN(original) ? graphInstant(event.start) : new Date(original).toISOString();
    return at !== null && dayKeyAt(new Date(at), context.timeZone) === occursOn;
  });
  return match?.id ?? null;
}

async function ensureMaster(outlook: Outlook, row: SeriesOutlookRow, master: MasterSpec, context: Context, now: number) {
  const token = outlook.token.accessToken;
  if (row.master_id) {
    if (sameMaster(row.written, master)) return { masterId: row.master_id, revision: row.written?.revision ?? "first", created: false };
    try {
      await graphWrite(context, outlook, () => patchGraphEvent(token, row.master_id!, masterPatch(master, context.timeZone), context.fetchImpl));
      return { masterId: row.master_id, revision: randomUUID(), created: false };
    } catch (error) {
      if (failed(error, "refused")) await graphWrite(context, outlook, () => deleteGraphEvent(token, row.master_id!, context.fetchImpl));
      else if (!failed(error, "gone")) throw error;
    }
  }
  if (row.create_key && row.create_user_id === outlook.actor.userId) {
    const found = await graphRead(context, outlook, () => findTaskBlockEvents(token, `series:${row.series_id}:${row.create_key}`, context.fetchImpl));
    if (found[0]?.id) {
      await graphWrite(context, outlook, () => patchGraphEvent(token, found[0].id!, masterPatch(master, context.timeZone), context.fetchImpl));
      for (const extra of found.slice(1)) if (extra.id) await graphWrite(context, outlook, () => deleteGraphEvent(token, extra.id!, context.fetchImpl));
      return { masterId: found[0].id, revision: randomUUID(), created: true };
    }
    const sent = row.create_sent_at ? new Date(row.create_sent_at).getTime() : 0;
    if (sent > 0 && now - sent < CREATE_GRACE_MS) throw new Retry("pending");
  }
  const begun = await query<{ key: string }>("select private.begin_series_outlook_create($1, $2) as key", [row.series_id, outlook.actor.userId]);
  const key = begun.rows[0]?.key;
  if (!key) throw new Retry("gone");
  const created = await graphWrite(context, outlook, () => createGraphEvent(token, masterDraft(row.series_id, master, key, context.timeZone), { fetchImpl: context.fetchImpl }));
  if (!created.id) throw new Retry("no id");
  return { masterId: created.id, revision: randomUUID(), created: true };
}

type DateJob = {
  outlook: Outlook;
  seriesId: string;
  record: DateRecord;
  masterId: string | null;
  occursOn: string;
  want: DateWant | null;
  rewritten: boolean;
  link: string | null;
  context: Context;
  persist: (record: DateRecord) => Promise<void>;
};

async function dropInstances(job: DateJob, record: DateRecord) {
  const { outlook, context, masterId, occursOn } = job;
  if (!masterId) return;
  if (record.instance === "deleted" && !job.rewritten) return;
  const token = outlook.token.accessToken;
  const drop = async (id: string) => {
    record.instance = "deleting";
    record.instanceId = id;
    await job.persist({ ...record });
    await graphWrite(context, outlook, () => deleteGraphEvent(token, id, context.fetchImpl));
  };
  if (record.instanceId) await drop(record.instanceId);
  const found = await findInstance(outlook, masterId, occursOn, context);
  if (found) await drop(found);
  record.instance = "deleted";
}

async function writeSingle(job: DateJob, record: DateRecord, want: Extract<DateWant, { start: string }>) {
  const { outlook, context, seriesId, link } = job;
  const token = outlook.token.accessToken;
  if (record.single) {
    if (sameWritten(record.written, want)) return;
    try {
      await graphWrite(context, outlook, () => patchGraphEvent(token, record.single!, timesPatch(want, link, context.timeZone), context.fetchImpl));
      record.written = written(want);
      return;
    } catch (error) {
      if (!failed(error, "gone")) throw error;
      delete record.single;
    }
  }
  if (record.createKey) {
    const found = await graphRead(context, outlook, () => findTaskBlockEvents(token, singleKey(seriesId, record.createKey!), context.fetchImpl));
    if (found[0]?.id) {
      await graphWrite(context, outlook, () => patchGraphEvent(token, found[0].id!, timesPatch(want, link, context.timeZone), context.fetchImpl));
      for (const extra of found.slice(1)) if (extra.id) await graphWrite(context, outlook, () => deleteGraphEvent(token, extra.id!, context.fetchImpl));
      record.single = found[0].id;
      delete record.createKey;
      record.written = written(want);
      return;
    }
  } else {
    record.createKey = randomUUID();
    await job.persist(record);
  }
  const created = await graphWrite(context, outlook, () => createGraphEvent(token, singleDraft(seriesId, record.createKey!, want, link, context.timeZone), { fetchImpl: context.fetchImpl }));
  if (!created.id) throw new Retry("no id");
  record.single = created.id;
  delete record.createKey;
  record.written = written(want);
}

async function reconcileDate(job: DateJob): Promise<DateRecord | null> {
  const { outlook, context, masterId, occursOn, want, link } = job;
  const token = outlook.token.accessToken;
  const record: DateRecord = { ...job.record };
  if (job.rewritten && record.instance === "patched") delete record.instance;
  if (want === null) {
    if (record.single) await graphWrite(context, outlook, () => deleteGraphEvent(token, record.single!, context.fetchImpl));
    if (record.createKey) await deleteByKey(outlook, singleKey(job.seriesId, record.createKey), context);
    return null;
  }
  if (want.skip) {
    if (record.single) await graphWrite(context, outlook, () => deleteGraphEvent(token, record.single!, context.fetchImpl));
    if (record.createKey) await deleteByKey(outlook, singleKey(job.seriesId, record.createKey), context);
    delete record.single;
    delete record.createKey;
    record.written = null;
    await dropInstances(job, record);
    return record;
  }
  if (record.single || record.createKey || !masterId || (record.instance === "deleted" && !job.rewritten)) {
    await dropInstances(job, record);
    await writeSingle(job, record, want);
    return record;
  }
  if (record.instance === "patched" && sameWritten(record.written, want)) return record;
  let id = record.instanceId ?? null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!id) id = await findInstance(outlook, masterId, occursOn, context);
    if (!id) break;
    const target = id;
    if (record.instanceId !== target) {
      record.instanceId = target;
      await job.persist({ ...record });
    }
    try {
      await graphWrite(context, outlook, () => patchGraphEvent(token, target, timesPatch(want, link, context.timeZone), context.fetchImpl));
      return { instance: "patched", instanceId: target, written: written(want) };
    } catch (error) {
      if (failed(error, "gone") && record.instanceId === target) {
        delete record.instanceId;
        id = null;
        continue;
      }
      if (!failed(error, "refused", "denied", "gone")) throw error;
      record.instance = "deleting";
      record.instanceId = target;
      await job.persist({ ...record });
      if (!failed(error, "gone")) await graphWrite(context, outlook, () => deleteGraphEvent(token, target, context.fetchImpl));
      break;
    }
  }
  record.instance = "deleted";
  await writeSingle(job, record, want);
  return record;
}

export function isDefaultRecord(row: SeriesOutlookRow, occursOn: string, record: DateRecord | null, timeZone = appTimeZone()) {
  if (!record || record.single || record.createKey || record.instance === "deleted" || record.instance === "deleting") return false;
  return sameWritten(record.written, defaultWant(row, occursOn, timeZone));
}

async function writeSeries(outlook: Outlook, row: SeriesOutlookRow, plan: Extract<SeriesPlan, { kind: "write" }>, context: Context, now: number) {
  const dates: Record<string, DateRecord> = { ...(row.dates ?? {}) };
  let masterId: string | null = row.master_id;
  let written: MasterSpec | null = null;
  let revision = "none";
  if (plan.master) {
    const ensured = await ensureMaster(outlook, row, plan.master, context, now);
    masterId = ensured.masterId;
    revision = ensured.revision;
    written = { ...plan.master, revision };
    await save(row, { userId: outlook.actor.userId, masterId, written, dates }, ensured.created || masterId !== row.master_id);
  } else if (row.master_id || row.create_key) {
    if (row.master_id) {
      await save(row, { userId: outlook.actor.userId, masterId: row.master_id, written: null, dates });
      await graphWrite(context, outlook, () => deleteGraphEvent(outlook.token.accessToken, row.master_id!, context.fetchImpl));
    }
    await deleteUnrecordedMaster(outlook, row, context);
    masterId = null;
    for (const [key, record] of Object.entries(dates)) {
      const rest = { ...record };
      delete rest.instance;
      delete rest.instanceId;
      dates[key] = rest;
    }
    await save(row, { userId: outlook.actor.userId, masterId: null, written: null, dates }, true);
  }
  const state = () => ({ userId: outlook.actor.userId, masterId, written, dates });
  const keys = [...new Set([...Object.keys(plan.dates), ...Object.keys(dates)])].sort();
  for (const occursOn of keys) {
    const want = occursOn in plan.dates ? plan.dates[occursOn] : null;
    const record = dates[occursOn];
    if (want === null && record === undefined) continue;
    const rewritten = Boolean(record && plan.master && record.rev !== revision);
    if (!rewritten && record === undefined && want && !want.skip && plan.master && sameWritten(defaultWant(row, occursOn, context.timeZone), want)) continue;
    if (!rewritten && record && want && !want.skip && record.instance === "patched" && sameWritten(record.written, want)) continue;
    const persist = async (next: DateRecord) => {
      dates[occursOn] = next;
      await save(row, state());
    };
    const next = await reconcileDate({ outlook, seriesId: row.series_id, record: record ?? {}, masterId, occursOn, want, rewritten, link: plan.link, context, persist });
    if (next && (!plan.master || !isDefaultRecord(row, occursOn, next, context.timeZone))) dates[occursOn] = { ...next, rev: revision };
    else delete dates[occursOn];
    await save(row, state());
  }
}

function emptyRun(): SeriesRun {
  return { written: 0, removed: 0, unchanged: 0, deferred: 0, throttled: 0, orbitOnly: 0, requests: 0 };
}

async function settle(row: SeriesOutlookRow, requeue = false, waiting = false) {
  await query("select private.settle_series_outlook($1, $2, $3, $4)", [row.series_id, row.version, requeue, waiting]);
}

async function defer(row: SeriesOutlookRow, ms = RETRY_MS) {
  await query("select private.defer_series_outlook($1, $2)", [row.series_id, new Date(Date.now() + Math.min(ms * Math.max(1, row.attempts + 1), 60 * MINUTE_MS)).toISOString()]);
}

async function holderAccess(userId: string, workspaceId: string, context: Context): Promise<Access | "gone"> {
  try {
    const actor = await actingActor(userId, workspaceId, true);
    if (!actor) return "gone";
    const stored = await withActor(actor, (db) => readStored(db, actor));
    if (!stored || stored.status !== "connected") return "gone";
    return await openOutlook(actor, context.fetchImpl);
  } catch (error) {
    console.error("Opening Outlook for repeating tasks failed", error);
    return "retry";
  }
}

async function runRow(row: SeriesOutlookRow, context: Context, now: number, throttled: Set<string>, run: SeriesRun) {
  const plan = planSeriesOutlook(row, now, context.timeZone);
  const holder = row.user_id ?? (row.create_key ? row.create_user_id : null);
  if (holder && (plan.kind === "remove" || holder !== plan.userId)) {
    if (throttled.has(holder)) {
      await defer(row);
      run.throttled += 1;
      return;
    }
    const held = await holderAccess(holder, row.workspace_id, context);
    if (held === "retry" || (held === "orbit_only" && holds(row))) {
      await defer(row);
      run.deferred += 1;
      return;
    }
    if (held !== "orbit_only" && held !== "gone") await removeAll(held, row, context);
    else await save(row, { userId: null, masterId: null, written: null, dates: {} }, true);
    run.removed += 1;
    if (plan.kind === "remove") {
      await settle(row);
      return;
    }
    row = { ...row, user_id: null, master_id: null, written: null, dates: {}, create_key: null, create_user_id: null, create_sent_at: null };
  }
  if (plan.kind === "remove") {
    await settle(row);
    run.unchanged += 1;
    return;
  }
  if (throttled.has(plan.userId)) {
    await defer(row);
    run.throttled += 1;
    return;
  }
  const outlook = await holderAccess(plan.userId, row.workspace_id, context);
  if (outlook === "gone") {
    if (holds(row)) await save(row, { userId: null, masterId: null, written: null, dates: {} }, true);
    await settle(row, false, true);
    run.orbitOnly += 1;
    return;
  }
  if (outlook === "retry" || (outlook === "orbit_only" && holds(row))) {
    await defer(row);
    run.deferred += 1;
    return;
  }
  if (outlook === "orbit_only") {
    await settle(row, false, true);
    run.orbitOnly += 1;
    return;
  }
  const before = context.budget.left;
  await writeSeries(outlook, row, plan, context, now);
  await settle(row);
  if (context.budget.left < before) run.written += 1;
  else run.unchanged += 1;
}

export async function syncSeriesOutlook(
  options: { taskIds?: string[]; userId?: string; fetchImpl?: typeof fetch; now?: number; deadline?: number; limit?: number; throttled?: Set<string> } = {},
): Promise<SeriesRun> {
  const run = emptyRun();
  const limit = options.limit ?? RUN_LIMIT;
  if (limit <= 0 || (options.taskIds && options.taskIds.length === 0)) return run;
  const deadline = options.deadline ?? Date.now() + 20_000;
  const throttled = options.throttled ?? new Set<string>();
  const budget = { left: limit };
  const claimed = await query<SeriesOutlookRow>("select * from private.claim_series_outlook($1::uuid[], $2::uuid, $3)", [
    options.taskIds ?? null,
    options.userId ?? null,
    limit,
  ]);
  const base = options.fetchImpl ?? fetch;
  const counted = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (graphHost(input)) {
      if (budget.left <= 0) throw new OutOfTime();
      budget.left -= 1;
    }
    return base(input, init);
  }) as typeof fetch;
  const context: Context = { fetchImpl: counted, timeZone: appTimeZone(), budget, stopAt: Math.min(deadline - RESERVE_MS, Date.now() + LEASE_MS) };
  for (const row of claimed.rows) {
    if (Date.now() >= context.stopAt || budget.left <= 0) {
      await settle(row, true);
      continue;
    }
    const now = options.now ?? Date.now();
    try {
      await runRow(row, context, now, throttled, run);
    } catch (error) {
      try {
        if (error instanceof OutOfTime) {
          await settle(row, true);
          continue;
        }
        if (error instanceof GraphFail && error.failure === "refused") {
          await settle(row);
          run.deferred += 1;
          continue;
        }
        if (error instanceof Throttled) {
          throttled.add(error.userId);
          run.throttled += 1;
        } else {
          if (!(error instanceof Retry) && !(error instanceof GraphFail)) console.error("Outlook repeating task failed", error);
          run.deferred += 1;
        }
        await defer(row);
      } catch (failure) {
        console.error("Couldn't put a repeating task back in the Outlook queue", failure);
      }
    }
  }
  run.requests = limit - budget.left;
  return run;
}

function graphHost(input: RequestInfo | URL) {
  try {
    return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname === "graph.microsoft.com";
  } catch {
    return false;
  }
}

export async function removeSeriesOutlookFor(userId: string, workspaceId: string, options: { fetchImpl?: typeof fetch; deadline?: number } = {}) {
  const memberships = await query<{ workspace_id: string }>("select workspace_id from private.memberships_for($1)", [userId]);
  if (memberships.rows.some((row) => row.workspace_id !== workspaceId)) return;
  await query("select private.queue_series_outlook($1)", [userId]);
  const claimed = await query<SeriesOutlookRow>("select * from private.claim_series_outlook(null, $1::uuid, 200)", [userId]);
  const deadline = options.deadline ?? Date.now() + 20_000;
  const context: Context = { fetchImpl: options.fetchImpl ?? fetch, timeZone: appTimeZone(), budget: { left: 200 }, stopAt: Math.min(deadline - RESERVE_MS, Date.now() + LEASE_MS) };
  for (const row of claimed.rows) {
    const holder = row.user_id ?? (row.create_key ? row.create_user_id : null);
    try {
      if (holder === userId && holds(row)) {
        const held = await holderAccess(userId, row.workspace_id, context);
        if (held !== "gone" && held !== "orbit_only" && held !== "retry") await removeAll(held, row, context);
      }
    } catch (error) {
      console.error("Couldn't take a repeating task out of a removed person's Outlook", error);
    }
    await settle(row, true).catch(() => undefined);
  }
}

export async function seriesOutlookEvents(userId: string) {
  const result = await query<{ event_id: string }>("select event_id from private.series_outlook_events($1)", [userId]);
  return new Set(result.rows.map((row) => row.event_id));
}
