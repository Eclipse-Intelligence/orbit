import { z } from "zod";
import { dayKey, dayKeyAt, nextWorkingDay, shiftDay, wallClockAt, weekday } from "@/lib/crm/task-due";
import { laterDetail, type LaterOption } from "@/lib/mail/later";
import { appTimeZone } from "@/lib/time";

export const DEFERRAL_PRECISIONS = ["day", "week", "month", "quarter", "year"] as const;
type DeferralPrecision = (typeof DEFERRAL_PRECISIONS)[number];

export type DeferralWhen = { precision: DeferralPrecision; date: string };

export const DEFER_SCHEMA = z
  .object({ note: z.string().nullable().optional(), precision: z.string(), date: z.string() })
  .nullable()
  .optional()
  .catch(null);

export const DEFERRAL_GRACE_MINUTES = 60;

const START_HOUR = 9;
const MAX_AHEAD_DAYS = 365;
const JANUARY_RETURN_DAY = 8;

const DEFERRAL_HINT = new RegExp(
  [
    "jan(?:uary)?|feb(?:ruary)?|apr(?:il)?|june|july|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?",
    "mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|weds|thur?s?(?:day)?|fri(?:day)?|saturday|sunday|tomorrow|weekend|bank holiday",
    "q[1-4]|quarter|half[- ]?term|(?:financial|fiscal|tax) year|new year|year[- ]end",
    "(?:next|this coming|following|the) (?:week|month|year|quarter|term|season)",
    "(?:a|one|two|three|four|five|six|eight|ten|twelve|couple of|few|\\d+) (?:days?|weeks?|months?|years?)",
    "days|weeks|months|fortnight|spring|summer|autumn|winter|christmas|easter|holidays?",
    "end of (?:the )?(?:week|month|year|quarter)",
    "\\d{1,2}(?:st|nd|rd|th)|\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?|w/?c",
    "circle back|pick (?:this|it|things) (?:back )?up|revisit|reconnect|touch base|come back to (?:this|it|you|me|us)|get back to (?:you|me|us)",
    "try me|chase me|nudge me|ping me|give (?:me|us) a (?:shout|call|ring|nudge|bell)|follow up (?:in|after|next)",
    "out of (?:the )?office|on leave|back (?:on|in|from)|away (?:until|till|for)|after the|until the|till the",
    "later (?:this|in the) (?:year|month|week)",
  ].join("|"),
  "i",
);

const DEFERRAL_HINT_BOUNDED = new RegExp(`\\b(?:${DEFERRAL_HINT.source})\\b`, "i");

const AMBIGUOUS_MONTH = /\b(?:(?:in|by|after|until|till|before|early|mid|late|of|say|from|around|for)[ -]+(?:may|march)|(?:may|march),? +(?:20\d{2}|'\d{2}))\b/i;

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
  return DEFERRAL_HINT_BOUNDED.test(text) || AMBIGUOUS_MONTH.test(text);
}

const PRECISION_WORDS: Record<string, DeferralPrecision> = {
  day: "day",
  date: "day",
  week: "week",
  fortnight: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

export function normalizeDeferral(raw: { precision?: unknown; date?: unknown } | null | undefined): DeferralWhen | null {
  if (!raw || typeof raw.precision !== "string" || typeof raw.date !== "string") return null;
  const word = raw.precision.trim().toLowerCase().replace(/s$/, "");
  const precision = PRECISION_WORDS[word];
  if (!precision) return null;
  const text = raw.date.trim();
  const full = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  const monthOnly = /^(\d{4})-(\d{2})$/.exec(text);
  const yearOnly = /^(\d{4})$/.exec(text);
  const date = full ?? (monthOnly ? `${monthOnly[1]}-${monthOnly[2]}-01` : yearOnly ? `${yearOnly[1]}-01-01` : null);
  if (!date || !validKey(date)) return null;
  return { precision, date };
}

function periodAfter(when: DeferralWhen, key: string) {
  const [year, month] = key.split("-").map(Number);
  if (when.precision === "day") return shiftDay(key, 1);
  if (when.precision === "week") return shiftDay(shiftDay(key, -((weekday(key) + 6) % 7)), 7);
  const months = when.precision === "month" ? 1 : when.precision === "quarter" ? 3 : 12;
  const index = month - 1 + months;
  return dayKey(year + Math.floor(index / 12), (index % 12) + 1, 1);
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
  const key = validKey(when.date);
  let day = deferralDay(when);
  if (!key || !day) return null;
  const today = dayKeyAt(new Date(now), timeZone);
  if (day <= today || wallClockAt(day, START_HOUR, 0, timeZone) <= now) {
    if (when.precision === "day" || periodAfter(when, key) <= today) return null;
    day = nextWorkingDay(shiftDay(today, 1));
  }
  const at = wallClockAt(day, START_HOUR, 0, timeZone);
  if (at <= now || at > now + MAX_AHEAD_DAYS * 86_400_000) return null;
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
