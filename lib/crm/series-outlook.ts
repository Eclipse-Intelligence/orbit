import { createHash } from "node:crypto";
import { actingActor, graphFailure, openOutlook, taskBlockLink, type Access, type Outlook } from "@/lib/crm/task-outlook";
import { clockLabel, dayStartIso, wallInstant } from "@/lib/crm/task-time";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
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
  starts_on: string | Date;
  at: string | null;
  duration_minutes: number;
  rule: RepeatRule;
  ends: RepeatEnds;
  ended: boolean;
  current_task_id: string | null;
  current_occurs_on: string | Date | null;
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
};

export type DateWant = { skip: true } | { skip?: false; start: string; end: string; title: string };

export type DateRecord = {
  instance?: "patched" | "deleted";
  instanceId?: string;
  single?: string;
  written?: { start: string; end: string; title: string } | null;
};

export type SeriesPlan =
  | { kind: "remove" }
  | { kind: "write"; userId: string; master: MasterSpec; dates: Record<string, DateWant | null> };

export type SeriesRun = { written: number; removed: number; unchanged: number; deferred: number; throttled: number; orbitOnly: number };

function day(value: string | Date | null) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
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
  const zone = graphTimeZoneName(timeZone);
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

export function firstOutlookDay(row: SeriesOutlookRow, now: number, timeZone = appTimeZone()) {
  const pattern = patternOf(row);
  const occurs = day(row.current_occurs_on);
  const due = row.current_due_at ? dayKeyAt(new Date(row.current_due_at), timeZone) : null;
  const after = occurs && due ? (due > occurs ? due : occurs) : (occurs ?? due);
  const today = dayKeyAt(new Date(now), timeZone);
  const from = after ? shiftDay(after, 1) : pattern.startsOn;
  return occurrenceOnOrAfter(pattern, from > today ? from : today);
}

export function defaultWant(row: SeriesOutlookRow, occursOn: string, timeZone = appTimeZone()): DateWant {
  const timing = occurrenceTiming(row.at, occursOn, timeZone);
  return { start: timing.dueAt, end: new Date(Date.parse(timing.dueAt) + row.duration_minutes * MINUTE_MS).toISOString(), title: row.title };
}

export function planSeriesOutlook(row: SeriesOutlookRow, now: number, timeZone = appTimeZone()): SeriesPlan {
  if (!row.owner_id || !row.owner_member || !row.at || row.ended) return { kind: "remove" };
  const pattern = patternOf(row);
  const startDay = firstOutlookDay(row, now, timeZone);
  if (!startDay) return { kind: "remove" };
  const lastDay = lastOccurrence(pattern);
  const master: MasterSpec = {
    startDay,
    at: row.at,
    durationMinutes: row.duration_minutes,
    title: row.title,
    link: row.current_task_id ? taskBlockLink(row.current_task_id, row.workspace_id) : null,
    recurrence: seriesRecurrence(pattern, startDay, lastDay, timeZone),
  };
  const dates: Record<string, DateWant | null> = {};
  for (const change of changesOf(row)) {
    if (change.occursOn < startDay || (lastDay && change.occursOn > lastDay)) continue;
    if (change.skip) {
      dates[change.occursOn] = { skip: true };
      continue;
    }
    const occurrence = occurrenceFor(pattern, change.occursOn, change, timeZone);
    if (!occurrence.dueHasTime) {
      dates[change.occursOn] = { skip: true };
      continue;
    }
    const start = occurrence.dueAt;
    const minutes = occurrence.durationMinutes ?? row.duration_minutes;
    dates[change.occursOn] = { start, end: new Date(Date.parse(start) + minutes * MINUTE_MS).toISOString(), title: occurrence.title ?? row.title };
  }
  for (const occursOn of Object.keys(row.dates ?? {})) {
    if (!(occursOn in dates)) dates[occursOn] = occursOn >= startDay && (!lastDay || occursOn <= lastDay) ? defaultWant(row, occursOn, timeZone) : null;
  }
  return { kind: "write", userId: row.owner_id, master, dates };
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

function singleDraft(seriesId: string, occursOn: string, want: Extract<DateWant, { start: string }>, link: string | null, timeZone = appTimeZone()) {
  const key = `series:${seriesId}:${occursOn}:${want.start}`;
  return taskBlockDraft({
    title: want.title,
    start: new Date(want.start),
    end: new Date(want.end),
    timeZone,
    link,
    transactionId: seriesTransactionId(seriesId, `${occursOn}|${want.start}`),
    key,
  });
}

function timesPatch(want: Extract<DateWant, { start: string }>, link: string | null, timeZone = appTimeZone()) {
  const draft = taskBlockDraft({ title: want.title, start: new Date(want.start), end: new Date(want.end), timeZone, link, transactionId: "", key: "" });
  return { subject: draft.subject, body: { contentType: "HTML" as const, content: taskBlockBodyHtml(link) }, start: draft.start, end: draft.end, showAs: "busy", sensitivity: "private", isReminderOn: false };
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
  return stable(left) === stable(right);
}

class Throttled extends Error {}
class Retry extends Error {}

function rethrow(error: unknown): never {
  const failure = graphFailure(error);
  if (failure === "throttled") throw new Throttled();
  throw error instanceof Retry ? error : new Retry(failure);
}

type Context = { fetchImpl: typeof fetch; timeZone: string };

async function save(row: SeriesOutlookRow, state: { userId: string | null; masterId: string | null; written: MasterSpec | null; dates: Record<string, DateRecord> }, clearKey = false) {
  await query("select private.save_series_outlook($1, $2, $3, $4, $5, $6)", [
    row.series_id,
    state.userId,
    state.masterId,
    state.written ? JSON.stringify(state.written) : null,
    JSON.stringify(state.dates),
    clearKey,
  ]);
}

async function removeAll(outlook: Outlook, row: SeriesOutlookRow, context: Context) {
  for (const record of Object.values(row.dates ?? {})) {
    if (record.single) await deleteGraphEvent(outlook.token.accessToken, record.single, context.fetchImpl).catch(rethrow);
  }
  if (row.master_id) await deleteGraphEvent(outlook.token.accessToken, row.master_id, context.fetchImpl).catch(rethrow);
  await save(row, { userId: null, masterId: null, written: null, dates: {} }, true);
}

async function findInstance(outlook: Outlook, masterId: string, occursOn: string, context: Context) {
  const start = new Date(dayStartIso(occursOn, context.timeZone));
  const end = new Date(dayStartIso(shiftDay(occursOn, 1), context.timeZone));
  const found = await listSeriesInstances(outlook.token.accessToken, masterId, start, end, context.fetchImpl).catch(rethrow);
  const match = found.find((event) => {
    const at = graphInstant(event.start);
    return at !== null && dayKeyAt(new Date(at), context.timeZone) === occursOn;
  });
  return match?.id ?? null;
}

async function ensureMaster(outlook: Outlook, row: SeriesOutlookRow, master: MasterSpec, context: Context, now: number) {
  if (row.master_id) {
    if (sameMaster(row.written, master)) return { masterId: row.master_id, rewritten: false };
    try {
      await patchGraphEvent(outlook.token.accessToken, row.master_id, masterPatch(master, context.timeZone), context.fetchImpl);
      return { masterId: row.master_id, rewritten: true };
    } catch (error) {
      if (graphFailure(error) !== "gone") rethrow(error);
    }
  }
  if (row.create_key && row.create_user_id === outlook.actor.userId) {
    const found = await findTaskBlockEvents(outlook.token.accessToken, `series:${row.series_id}:${row.create_key}`, context.fetchImpl).catch(rethrow);
    if (found[0]?.id) {
      await patchGraphEvent(outlook.token.accessToken, found[0].id, masterPatch(master, context.timeZone), context.fetchImpl).catch(rethrow);
      for (const extra of found.slice(1)) if (extra.id) await deleteGraphEvent(outlook.token.accessToken, extra.id, context.fetchImpl).catch(rethrow);
      return { masterId: found[0].id, rewritten: true, created: true };
    }
    const sent = row.create_sent_at ? new Date(row.create_sent_at).getTime() : 0;
    if (sent > 0 && now - sent < CREATE_GRACE_MS) throw new Retry("pending");
  }
  const begun = await query<{ key: string }>("select private.begin_series_outlook_create($1, $2) as key", [row.series_id, outlook.actor.userId]);
  const key = begun.rows[0]?.key;
  if (!key) throw new Retry("gone");
  const created = await createGraphEvent(outlook.token.accessToken, masterDraft(row.series_id, master, key, context.timeZone), { fetchImpl: context.fetchImpl }).catch(rethrow);
  if (!created.id) throw new Retry("no id");
  return { masterId: created.id, rewritten: true, created: true };
}

async function reconcileDate(
  outlook: Outlook,
  seriesId: string,
  masterId: string,
  occursOn: string,
  want: DateWant | null,
  record: DateRecord | undefined,
  rewritten: boolean,
  link: string | null,
  context: Context,
): Promise<DateRecord | null> {
  const token = outlook.token.accessToken;
  const current: DateRecord = { ...(record ?? {}) };
  if (rewritten && current.instance) {
    delete current.instance;
    delete current.instanceId;
  }
  if (want === null) {
    if (current.single) await deleteGraphEvent(token, current.single, context.fetchImpl).catch(rethrow);
    return null;
  }
  const dropInstance = async () => {
    if (current.instance === "deleted") return;
    const id = current.instanceId ?? (await findInstance(outlook, masterId, occursOn, context));
    if (id) await deleteGraphEvent(token, id, context.fetchImpl).catch(rethrow);
    current.instance = "deleted";
    delete current.instanceId;
  };
  if (want.skip) {
    if (current.single) await deleteGraphEvent(token, current.single, context.fetchImpl).catch(rethrow);
    delete current.single;
    current.written = null;
    await dropInstance();
    return current;
  }
  if (current.single) {
    await dropInstance();
    if (!sameWritten(current.written, want)) {
      try {
        await patchGraphEvent(token, current.single, timesPatch(want, link, context.timeZone), context.fetchImpl);
      } catch (error) {
        if (graphFailure(error) !== "gone") rethrow(error);
        const created = await createGraphEvent(token, singleDraft(seriesId, occursOn, want, link, context.timeZone), { fetchImpl: context.fetchImpl }).catch(rethrow);
        current.single = created.id ?? undefined;
      }
    }
    current.written = { start: want.start, end: want.end, title: want.title };
    return current;
  }
  if (current.instance !== "deleted") {
    const id = current.instanceId ?? (await findInstance(outlook, masterId, occursOn, context));
    if (id) {
      if (current.instance === "patched" && sameWritten(current.written, want)) return current;
      try {
        await patchGraphEvent(token, id, timesPatch(want, link, context.timeZone), context.fetchImpl);
        return { instance: "patched", instanceId: id, written: { start: want.start, end: want.end, title: want.title } };
      } catch (error) {
        const failure = graphFailure(error);
        if (failure === "throttled" || failure === "retry" || failure === "orbit_only") rethrow(error);
        if (failure !== "gone") await deleteGraphEvent(token, id, context.fetchImpl).catch(rethrow);
      }
    }
    current.instance = "deleted";
    delete current.instanceId;
  }
  const created = await createGraphEvent(token, singleDraft(seriesId, occursOn, want, link, context.timeZone), { fetchImpl: context.fetchImpl }).catch(rethrow);
  if (!created.id) throw new Retry("no id");
  return { instance: "deleted", single: created.id, written: { start: want.start, end: want.end, title: want.title } };
}

export function isDefaultRecord(row: SeriesOutlookRow, occursOn: string, record: DateRecord | null, timeZone = appTimeZone()) {
  if (!record || record.single || record.instance === "deleted") return false;
  const base = defaultWant(row, occursOn, timeZone);
  return "start" in base && sameWritten(record.written, base);
}

async function writeSeries(outlook: Outlook, row: SeriesOutlookRow, plan: Extract<SeriesPlan, { kind: "write" }>, context: Context, now: number) {
  const ensured = await ensureMaster(outlook, row, plan.master, context, now);
  const dates: Record<string, DateRecord> = { ...(row.dates ?? {}) };
  await save(row, { userId: outlook.actor.userId, masterId: ensured.masterId, written: plan.master, dates }, Boolean(ensured.created) || ensured.masterId !== row.master_id);
  const masterRewritten = ensured.rewritten;
  const keys = [...new Set([...Object.keys(plan.dates), ...Object.keys(dates)])].sort();
  for (const occursOn of keys) {
    const want = occursOn in plan.dates ? plan.dates[occursOn] : null;
    const before = dates[occursOn];
    if (!masterRewritten && before === undefined && want && !want.skip && sameWritten(defaultWant(row, occursOn, context.timeZone) as DateRecord["written"], want)) continue;
    const next = await reconcileDate(outlook, row.series_id, ensured.masterId, occursOn, want, before, masterRewritten, plan.master.link, context);
    if (next && !isDefaultRecord(row, occursOn, next, context.timeZone)) dates[occursOn] = next;
    else delete dates[occursOn];
    await save(row, { userId: outlook.actor.userId, masterId: ensured.masterId, written: plan.master, dates });
  }
  return masterRewritten || keys.length > 0;
}

function emptyRun(): SeriesRun {
  return { written: 0, removed: 0, unchanged: 0, deferred: 0, throttled: 0, orbitOnly: 0 };
}

async function settle(row: SeriesOutlookRow, requeue = false) {
  await query("select private.settle_series_outlook($1, $2, $3)", [row.series_id, row.version, requeue]);
}

async function defer(row: SeriesOutlookRow, ms = RETRY_MS) {
  await query("select private.defer_series_outlook($1, $2)", [row.series_id, new Date(Date.now() + Math.min(ms * Math.max(1, row.attempts + 1), 60 * MINUTE_MS)).toISOString()]);
}

async function access(userId: string, workspaceId: string, context: Context): Promise<Access> {
  try {
    const actor = await actingActor(userId, workspaceId, true);
    return actor ? await openOutlook(actor, context.fetchImpl) : "orbit_only";
  } catch (error) {
    console.error("Opening Outlook for repeating tasks failed", error);
    return "retry";
  }
}

async function runRow(row: SeriesOutlookRow, context: Context, now: number, throttled: Set<string>, run: SeriesRun) {
  const plan = planSeriesOutlook(row, now, context.timeZone);
  const holder = row.user_id ?? (row.create_key ? row.create_user_id : null);
  const moving = holder && (plan.kind === "remove" || holder !== plan.userId);
  if (moving) {
    if (throttled.has(holder)) {
      await defer(row);
      run.throttled += 1;
      return;
    }
    const held = await access(holder, row.workspace_id, context);
    if (held === "retry") {
      await defer(row);
      run.deferred += 1;
      return;
    }
    if (held !== "orbit_only") await removeAll(held, row, context);
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
  const outlook = await access(plan.userId, row.workspace_id, context);
  if (outlook === "retry") {
    await defer(row);
    run.deferred += 1;
    return;
  }
  if (outlook === "orbit_only") {
    await settle(row);
    run.orbitOnly += 1;
    return;
  }
  const changed = await writeSeries(outlook, row, plan, context, now);
  await settle(row);
  if (changed) run.written += 1;
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
  const context: Context = { fetchImpl: options.fetchImpl ?? fetch, timeZone: appTimeZone() };
  const claimed = await query<SeriesOutlookRow>("select * from private.claim_series_outlook($1::uuid[], $2::uuid, $3)", [
    options.taskIds ?? null,
    options.userId ?? null,
    limit,
  ]);
  for (const row of claimed.rows) {
    if (deadline - Date.now() < RESERVE_MS) {
      await settle(row, true);
      continue;
    }
    const now = options.now ?? Date.now();
    try {
      await runRow(row, context, now, throttled, run);
    } catch (error) {
      if (error instanceof Throttled) {
        const user = row.owner_id ?? row.user_id;
        if (user) throttled.add(user);
        run.throttled += 1;
      } else {
        if (!(error instanceof Retry)) console.error("Outlook repeating task failed", error);
        run.deferred += 1;
      }
      await defer(row);
    }
  }
  return run;
}

export async function seriesOutlookEvents(userId: string) {
  const result = await query<{ event_id: string }>("select event_id from private.series_outlook_events($1)", [userId]);
  return new Set(result.rows.map((row) => row.event_id));
}
