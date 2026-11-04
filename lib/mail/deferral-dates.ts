import { z } from "zod";
import { dayKey, dayKeyAt, nextWorkingDay, shiftDay, wallClockAt, weekday } from "@/lib/crm/task-due";
import { laterDetail, type LaterOption } from "@/lib/mail/later";
import { appTimeZone } from "@/lib/time";

export const DEFERRAL_PRECISIONS = ["day", "week", "month", "quarter", "year"] as const;
type DeferralPrecision = (typeof DEFERRAL_PRECISIONS)[number];

export type DeferralWhen = { precision: DeferralPrecision; date: string };

export const DEFER_SCHEMA = z
  .object({ note: z.string().nullable().optional(), precision: z.enum(DEFERRAL_PRECISIONS), date: z.string() })
  .nullable()
  .optional()
  .catch(null);

const START_HOUR = 9;
const MIN_AHEAD_MS = 24 * 3_600_000;
const MAX_AHEAD_DAYS = 365;
const JANUARY_RETURN_DAY = 8;

const DEFERRAL_HINT =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|apr(?:il)?|june|july|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|quarter|(?:next|this coming) (?:week|month|year|quarter|term|season)|new year|weeks|months|fortnight|spring|summer|autumn|winter|christmas|easter|holidays?|year[- ]end|end of (?:the )?(?:week|month|year|quarter)|circle back|pick (?:this|it|things) (?:back )?up|revisit|reconnect|touch base|come back to (?:this|it|you)|try me|later (?:this|in the) (?:year|month))\b/i;

const AMBIGUOUS_MONTH = /\b(?:(?:in|by|after|until|till|before|early|mid|late|of)[ -]+(?:may|march)|(?:may|march),? +(?:20\d{2}|'\d{2}))\b/i;

function validKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return dayKey(year, month, day);
}

function mondayOnOrAfter(key: string) {
  let next = key;
  while (weekday(next) !== 1) next = shiftDay(next, 1);
  return next;
}

export function deferralHint(text: string) {
  return DEFERRAL_HINT.test(text) || AMBIGUOUS_MONTH.test(text);
}

function deferralDay(when: DeferralWhen) {
  const key = validKey(when.date);
  if (!key) return null;
  const [year, month] = key.split("-").map(Number);
  if (when.precision === "day") return nextWorkingDay(key);
  if (when.precision === "week") return nextWorkingDay(shiftDay(key, -((weekday(key) + 6) % 7)));
  const start = dayKey(year, month, month === 1 ? JANUARY_RETURN_DAY : 1);
  return nextWorkingDay(mondayOnOrAfter(start));
}

export function resolveDeferral(when: DeferralWhen, now = Date.now(), timeZone = appTimeZone()) {
  const day = deferralDay(when);
  if (!day) return null;
  const at = wallClockAt(day, START_HOUR, 0, timeZone);
  if (at < now + MIN_AHEAD_MS || at > now + MAX_AHEAD_DAYS * 86_400_000) return null;
  return new Date(at);
}

function nextMonthStart(now: number, months: number, timeZone: string) {
  const [year, month] = dayKeyAt(new Date(now), timeZone).split("-").map(Number);
  const index = month - 1 + months;
  return dayKey(year + Math.floor(index / 12), (index % 12) + 1, 1);
}

export function deferralOptions(now = Date.now(), timeZone = appTimeZone()): LaterOption[] {
  const today = dayKeyAt(new Date(now), timeZone);
  const nextMonday = mondayOnOrAfter(shiftDay(today, 1));
  const choices: { id: string; label: string; when: DeferralWhen }[] = [
    { id: "next-week", label: "Next week", when: { precision: "week", date: nextMonday } },
    { id: "two-weeks", label: "In two weeks", when: { precision: "week", date: shiftDay(nextMonday, 7) } },
    { id: "next-month", label: "Next month", when: { precision: "month", date: nextMonthStart(now, 1, timeZone) } },
    { id: "three-months", label: "In three months", when: { precision: "month", date: nextMonthStart(now, 3, timeZone) } },
  ];
  const options: LaterOption[] = [];
  for (const choice of choices) {
    const day = deferralDay(choice.when);
    if (!day) continue;
    const at = new Date(wallClockAt(day, START_HOUR, 0, timeZone));
    if (at.getTime() <= now || options.some((option) => option.at === at.toISOString())) continue;
    options.push({ id: choice.id, label: choice.label, detail: laterDetail(at, now, timeZone), at: at.toISOString() });
  }
  return options;
}
