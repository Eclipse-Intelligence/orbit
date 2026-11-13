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
export const SIGNAL_WEIGHTS: Record<LearnedSignal, number> = { placed: 4, booked: 2, ticked: 1 };

const SMOOTHING = [0.25, 0.6, 1, 0.6, 0.25];
const DAY_EMPHASIS = 2.5;

export type KindSpread = { slots: number[]; placed: number; booked: number; ticked: number };
export type LearnedSpread = Record<LearnedKind, KindSpread>;

export type LearnedKindView = {
  kind: LearnedKind;
  learned: boolean;
  label: string;
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

export function slotWeights(spread: KindSpread): number[] {
  const days = Array.from({ length: 7 }, (_, day) => spread.slots.slice(day * HALF_HOURS, (day + 1) * HALF_HOURS));
  const tod = smooth(Array.from({ length: HALF_HOURS }, (_, half) => days.reduce((total, day) => total + (day[half] ?? 0), 0)));
  const weights: number[] = [];
  for (const day of days) {
    const own = smooth(day);
    const blended = tod.map((value, half) => value + DAY_EMPHASIS * own[half]);
    const peak = Math.max(...blended);
    weights.push(...blended.map((value) => (peak > 0 ? Math.round((value / peak) * 1000) / 1000 : 0)));
  }
  return weights;
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

export function learnedWindow(spread: KindSpread) {
  const profile = dayProfile(spread);
  const top = profile.indexOf(Math.max(...profile));
  if (top < 0 || profile[top] <= 0) return null;
  let first = top;
  let last = top;
  while (first > 0 && profile[first - 1] >= LEARNED_GOOD) first -= 1;
  while (last < HALF_HOURS - 1 && profile[last + 1] >= LEARNED_GOOD) last += 1;
  return { from: first * 30, to: (last + 1) * 30 };
}

export function slotScore(weights: number[], start: number, minutes: number, timeZone = appTimeZone()) {
  const first = slotAt(start, timeZone);
  if (first === null) return Number.POSITIVE_INFINITY;
  const count = Math.max(1, Math.ceil(minutes / 30));
  let total = 0;
  for (let index = 0; index < count; index += 1) total += weights[(first + index) % WEEK_SLOTS] ?? 0;
  const average = total / count;
  return average >= LEARNED_GOOD ? 0 : 1 + Math.round((1 - average) * 100);
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

export function learnedView(kind: LearnedKind, spread: KindSpread): LearnedKindView {
  const learned = isLearned(spread);
  const window = learned ? learnedWindow(spread) : null;
  const weights = slotWeights(spread);
  return {
    kind,
    learned,
    label: window ? timeOfDayLabel((window.from + window.to) / 2) : DEFAULT_LABELS[kind],
    caption: learnedCaption(kind, spread),
    week: STRIP_DAYS.map((day) => weights.slice(day * HALF_HOURS + STRIP_FROM, day * HALF_HOURS + STRIP_TO)),
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
