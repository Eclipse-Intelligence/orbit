import { dayKeyAt, weekday } from "@/lib/crm/working-days";
import { appTimeZone, zonedParts } from "@/lib/time";

export type LearnedKind = "call" | "email" | "other";
export type LearnedSignal = "placed" | "booked" | "ticked";

export const LEARNED_KINDS: readonly LearnedKind[] = ["call", "email", "other"];
export const LEARN_DAYS = 90;
export const LEARN_THRESHOLD = 10;
export const HALF_HOURS = 48;
export const WEEK_SLOTS = 7 * HALF_HOURS;
export const LEARNED_GOOD = 0.5;
export const MAX_PERIODS = 3;
export const SIGNAL_WEIGHTS: Record<LearnedSignal, number> = { placed: 4, booked: 2, ticked: 1 };

const SMOOTHING = [0.25, 0.6, 1, 0.6, 0.25];
const BROAD_MINUTES = 180;
const ANY_TIME_SHARE = 0.85;

export type KindSpread = { slots: number[]; placed: number; booked: number; ticked: number };
export type LearnedSpread = Record<LearnedKind, KindSpread>;

export type LearnedKindView = {
  kind: LearnedKind;
  learned: boolean;
  label: string;
  periods: LearnedPeriod[];
  caption: string;
  week: number[][];
};

export const STRIP_DAYS = [1, 2, 3, 4, 5] as const;
export const STRIP_FROM = 16;
export const STRIP_TO = 36;

export function emptyKindSpread(): KindSpread {
  return { slots: Array.from({ length: WEEK_SLOTS }, () => 0), placed: 0, booked: 0, ticked: 0 };
}

export function emptySpread(): LearnedSpread {
  return { call: emptyKindSpread(), email: emptyKindSpread(), other: emptyKindSpread() };
}

export function slotAt(instant: number | string | Date, timeZone = appTimeZone()) {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const parts = zonedParts(date, timeZone);
  const day = weekday(dayKeyAt(date, timeZone));
  return day * HALF_HOURS + Math.min(HALF_HOURS - 1, Math.floor((parts.hour * 60 + parts.minute) / 30));
}

export function addSignal(spread: LearnedSpread, kind: LearnedKind, signal: LearnedSignal, instant: number | string | Date, timeZone = appTimeZone()) {
  const slot = slotAt(instant, timeZone);
  if (slot === null) return;
  const target = spread[kind];
  target.slots[slot] += SIGNAL_WEIGHTS[signal];
  target[signal] += 1;
}

export function signalCount(spread: KindSpread) {
  return Math.floor(spread.placed + spread.booked + spread.ticked / 2);
}

export function isLearned(spread: KindSpread) {
  return signalCount(spread) >= LEARN_THRESHOLD;
}

function smooth(values: number[]) {
  const reach = Math.floor(SMOOTHING.length / 2);
  return values.map((_, index) => {
    let total = 0;
    for (let offset = -reach; offset <= reach; offset += 1) {
      const at = index + offset;
      if (at >= 0 && at < values.length) total += values[at] * SMOOTHING[offset + reach];
    }
    return total;
  });
}

export function dayProfile(spread: KindSpread) {
  const totals = Array.from({ length: HALF_HOURS }, (_, half) => {
    let total = 0;
    for (let day = 0; day < 7; day += 1) total += spread.slots[day * HALF_HOURS + half] ?? 0;
    return total;
  });
  const smoothed = smooth(totals);
  const peak = Math.max(...smoothed);
  return smoothed.map((value) => (peak > 0 ? value / peak : 0));
}

export type LearnedPeriod = { from: number; to: number };

export function learnedPeriods(spread: KindSpread): LearnedPeriod[] {
  const profile = dayProfile(spread);
  const runs: (LearnedPeriod & { peak: number })[] = [];
  let first = -1;
  let peak = 0;
  for (let half = 0; half <= HALF_HOURS; half += 1) {
    const good = half < HALF_HOURS && profile[half] >= LEARNED_GOOD;
    if (good) {
      if (first < 0) {
        first = half;
        peak = 0;
      }
      peak = Math.max(peak, profile[half]);
    } else if (first >= 0) {
      runs.push({ from: first * 30, to: half * 30, peak });
      first = -1;
    }
  }
  return runs
    .sort((left, right) => right.peak - left.peak || left.from - right.from)
    .slice(0, MAX_PERIODS)
    .sort((left, right) => left.from - right.from)
    .map(({ from, to }) => ({ from, to }));
}

export function periodScore(periods: LearnedPeriod[], start: number, minutes: number) {
  const end = start + minutes;
  if (periods.some((period) => start >= period.from && end <= period.to)) return 0;
  let gap = Number.POSITIVE_INFINITY;
  for (const period of periods) gap = Math.min(gap, end <= period.from ? period.from - end : start >= period.to ? start - period.to : 0);
  return 1 + gap;
}

export function timeOfDayLabel(minutes: number) {
  if (minutes < 9 * 60) return "Early morning";
  if (minutes < 10 * 60 + 30) return "Morning";
  if (minutes < 12 * 60) return "Late morning";
  if (minutes < 13 * 60) return "Around lunch";
  if (minutes < 15 * 60) return "After lunch";
  if (minutes < 18 * 60) return "Late afternoon";
  return "Evening";
}

export type LabelSpan = { from: number; to: number };

function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function periodLabel(period: LearnedPeriod, span: LabelSpan | null = null) {
  if (span && span.to > span.from) {
    const covered = Math.max(0, Math.min(period.to, span.to) - Math.max(period.from, span.from));
    if (covered >= (span.to - span.from) * ANY_TIME_SHARE) return "Any time";
  }
  if (period.to - period.from > BROAD_MINUTES) return `${clock(period.from)} to ${clock(period.to)}`;
  return timeOfDayLabel((period.from + period.to) / 2);
}

export function periodsLabel(periods: LearnedPeriod[], span: LabelSpan | null = null) {
  const labels = [...new Set(periods.map((period) => periodLabel(period, span)))];
  if (labels.includes("Any time")) return "Any time";
  if (labels.length === 0) return null;
  const lowered = labels.map((label, index) => (index === 0 || /^\d/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)));
  return lowered.length > 1 ? `${lowered.slice(0, -1).join(", ")} and ${lowered[lowered.length - 1]}` : lowered[0];
}

export function reasonPhrase(minutes: number) {
  if (minutes < 12 * 60) return "in the morning";
  if (minutes < 13 * 60) return "around lunch";
  if (minutes < 15 * 60) return "after lunch";
  if (minutes < 18 * 60) return "in the afternoon";
  return "in the evening";
}

const DEFAULT_LABELS: Record<LearnedKind, string> = { call: "Late morning", email: "After lunch", other: "Any time" };
const DEFAULT_UNTIL: Record<LearnedKind, string> = {
  call: "Late morning until then.",
  email: "After lunch until then.",
  other: "Any time in working hours until then.",
};
const NOUNS: Record<LearnedKind, [string, string]> = { call: ["call", "calls"], email: ["email", "emails"], other: ["task", "tasks"] };

function noun(kind: LearnedKind, count: number) {
  return NOUNS[kind][count === 1 ? 0 : 1];
}

export function learnedCaption(kind: LearnedKind, spread: KindSpread) {
  if (!isLearned(spread)) return `Not enough yet (${signalCount(spread)} of about ${LEARN_THRESHOLD}). ${DEFAULT_UNTIL[kind]}`;
  const parts: string[] = [];
  if (spread.placed > 0) parts.push(`${spread.placed} ${noun(kind, spread.placed)} you placed`);
  if (spread.booked > 0) parts.push(`${spread.booked} ${spread.booked === 1 ? "meeting" : "meetings"} you booked`);
  if (spread.ticked > 0) {
    const elide = parts.length === 1 && spread.placed > 0;
    parts.push(elide ? `${spread.ticked} you ticked off` : `${spread.ticked} ${noun(kind, spread.ticked)} you ticked off`);
  }
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `Learned from ${listed}.`;
}

export function learnedView(kind: LearnedKind, spread: KindSpread, span: LabelSpan | null = null): LearnedKindView {
  const learned = isLearned(spread);
  const periods = learned ? learnedPeriods(spread) : [];
  const strength = learned ? 1 : Math.min(1, (spread.placed + spread.booked + spread.ticked / 2) / LEARN_THRESHOLD);
  const row = dayProfile(spread)
    .slice(STRIP_FROM, STRIP_TO)
    .map((weight) => Math.round(weight * strength * 1000) / 1000);
  return {
    kind,
    learned,
    label: periodsLabel(periods, span) ?? DEFAULT_LABELS[kind],
    periods,
    caption: learnedCaption(kind, spread),
    week: STRIP_DAYS.map(() => [...row]),
  };
}

export function readSpread(raw: unknown): LearnedSpread | null {
  if (!raw || typeof raw !== "object") return null;
  const spread = emptySpread();
  for (const kind of LEARNED_KINDS) {
    const value = (raw as Record<string, unknown>)[kind];
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (!Array.isArray(item.slots) || item.slots.length !== WEEK_SLOTS) return null;
    const slots = item.slots.map((slot) => (typeof slot === "number" && Number.isFinite(slot) && slot >= 0 ? slot : 0));
    const count = (field: unknown) => (typeof field === "number" && Number.isInteger(field) && field >= 0 ? field : 0);
    spread[kind] = { slots, placed: count(item.placed), booked: count(item.booked), ticked: count(item.ticked) };
  }
  return spread;
}
