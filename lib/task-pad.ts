import { REMINDER_MINUTES } from "@/lib/crm/reminder-options";
import { MAX_TASK_DURATION } from "@/lib/crm/task-time";
import { onWorkingDay, snoozeDetail } from "@/lib/crm/task-snooze";
import { dayKey, dayParts, shiftDay } from "@/lib/crm/working-days";
import {
  checkEnds,
  checkRule,
  daysInMonth,
  firstPatternDay,
  normalRule,
  weekdayOf,
  WEEKDAYS as TASK_WEEKDAYS,
  WORKWEEK,
  type MonthWeek,
  type RepeatEnds,
  type RepeatEvery,
  type RepeatRule,
  type Weekday,
} from "@/lib/task-repeat";

export type PadMark = { start: number; end: number; kind: "when" | "reminder" | "record" | "ask" };

type PadParse = {
  title: string;
  due: string | null;
  remindMinutes: number | null;
  durationMinutes: number | null;
  unsure: boolean;
  marks: PadMark[];
  guess: string | null;
  repeat?: PadRepeat | null;
};

type Day = { year: number; month: number; day: number };
type Span = { start: number; end: number; kind: "when" | "reminder" | "keep" };

const DOC_REFERENCE = /\[\[[^\]\n]*(?:\]\])?/g;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MEETING_CUE = "(?:call|ring|phone|meet|meeting|chat|catch\\s+up|catch-up|demo|interview|lunch|coffee)";
const MEETING_ANYWHERE = new RegExp(`\\b${MEETING_CUE}\\b`, "i");
const CUE_WORD = new RegExp(`^${MEETING_CUE}$`, "i");

function cuedNumber(before: string) {
  const words = before.trim().split(/\s+/).filter(Boolean);
  let names = 0;
  let joined = false;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index].replace(/[,;:]+$/, "");
    if (CUE_WORD.test(word) || (index > 0 && CUE_WORD.test(`${words[index - 1]} ${word}`))) return true;
    if (names > 0 && !joined && word.toLowerCase() === "with") {
      joined = true;
      continue;
    }
    if (!joined && names < 3 && /^\p{Lu}[\p{L}'’-]*$/u.test(word)) {
      names += 1;
      continue;
    }
    return false;
  }
  return false;
}
const COUNTED = /\b(?:room|rooms|top|chapter|chapters|no|nos|number|version|page|pages|step|steps|level|floor|flat|unit|suite|gate|table|platform|row|seat|section|part|lesson|week|day|item|items|slide|slides|issue|ticket)\s*$/i;
const CLOCK = "(?:\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm)\\b|\\d{1,2}:\\d{2}\\b|noon\\b|midday\\b|midnight\\b)";
const DAY_WORD = "(?:today|tonight|tomorrow|tmrw|tmr|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)";
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, thirty: 30 };
const LEAD = "(?:\\b(?:on|by|due|for|at)\\s+)?";
const NOT_MONEY = "(?<![£$€]\\s*)(?<!\\b(?:gbp|usd|eur)\\s*)";
const NOT_CURRENCY_AFTER = "(?!\\s*(?:gbp|usd|eur)\\b)";

const TEMPORAL =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|weds?|thu(?:rs?)?|fri)\b|\b(january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)\b|\b(today|tomorrow|tonight|morning|afternoon|evening|noon|midday|week|weekend|month|fortnight|remind|reminder|after next|fortnight|night|lunch|last)\b|\b(sat|sun)\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}(st|nd|rd|th)\b/i;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function addDays(day: Day, days: number): Day {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekday(day: Day) {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

function compare(a: Day, b: Day) {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

function valid(day: Day) {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day));
  return date.getUTCMonth() === day.month - 1 && date.getUTCDate() === day.day;
}

function weekdayIndex(word: string) {
  const key = word.toLowerCase().slice(0, 3);
  return WEEKDAYS.findIndex((name) => name.startsWith(key));
}

function monthIndex(word: string) {
  const key = word.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((name) => name.startsWith(key));
}

function nearestReminder(minutes: number) {
  return REMINDER_MINUTES.reduce((best, option) => (Math.abs(option - minutes) < Math.abs(best - minutes) ? option : best));
}

function unitMinutes(unit: string) {
  const key = unit.toLowerCase();
  if (key.startsWith("w")) return 7 * 24 * 60;
  if (key.startsWith("d")) return 24 * 60;
  if (key.startsWith("h")) return 60;
  return 1;
}

function amount(value: string) {
  return /^\d+$/.test(value) ? Number(value) : (NUMBER_WORDS[value.toLowerCase()] ?? 1);
}

function toHour(hour: number, minute: number, meridiem: string | undefined) {
  let h = hour;
  const m = meridiem?.toLowerCase();
  if (m && (h === 0 || h > 12)) return null;
  if (m === "pm" && h < 12) h += 12;
  if (m === "am" && h === 12) h = 0;
  if (h > 23 || minute > 59) return null;
  return { hour: h, minute };
}

function wallTimeCount(day: Day, time: { hour: number; minute: number }) {
  const wall = Date.UTC(day.year, day.month - 1, day.day, time.hour, time.minute);
  return [0, 60, -60].filter((offset) => {
    const parts = londonParts(new Date(wall - offset * 60_000));
    return parts.year === day.year && parts.month === day.month && parts.day === day.day && parts.hour === time.hour && parts.minute === time.minute;
  }).length;
}

export function londonParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function guessable(hour: string, meridiem: string | undefined) {
  const value = Number(hour);
  return Boolean(meridiem) || hour.length === 2 || value === 0 || value > 6;
}

type WeekdayWord = { start: number; end: number; target: number; cue: string | null; timed: boolean; weekLater: boolean; short: boolean; name: boolean; compound: boolean };

const WEEKDAY_ANY = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)";
const DAY_PREFIX = /\b(?:black|cyber|good|easter|holy|ash|super|casual|giving|shrove|maundy|manic|freaky|throwback|motivation|fun|whit)\s+$/i;
const DAY_COMPOUND =
  /^\s+(?:reports?|meetings?|updates?|reviews?|stand-?ups?|briefings?|syncs?|newsletters?|editions?|deals?|sales?|campaigns?|specials?|club|blues|round-?ups?|digests?|posts?|emails?|sessions?|class(?:es)?|shifts?|rotas?|deadlines?|agendas?|notes|lists?|run|slot|team|crew|squad)\b/i;
const TIME_AFTER = new RegExp(
  `^\\s*,?\\s*(?:at\\s+)?(?:${CLOCK}|(?:night|morning|afternoon|evening|lunch\\s*time|eod)\\b|\\d{1,2}\\b(?!\\s*(?:st|nd|rd|th|[/.:]\\d|${MONTH})))`,
  "i",
);
const TIME_BEFORE = new RegExp(`(?:${CLOCK}|\\bat\\s+\\d{1,2}|\\b(?:morning|afternoon|evening))\\s*,?\\s*(?:on\\s+)?$`, "i");

function readWeekdays(text: string, spans: Span[]): WeekdayWord[] {
  const found: WeekdayWord[] = [];
  const pattern = new RegExp(`\\b(?:(on|by|due|for|until|from|this|next|coming)\\s+)?(?:(this|next|coming)\\s+)?${WEEKDAY_ANY}\\b(\\s+week\\b)?`, "gi");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (spans.some((span) => start < span.end && end > span.start)) continue;
    const word = match[3].toLowerCase();
    const before = text.slice(0, start);
    const after = text.slice(end);
    found.push({
      start,
      end,
      target: weekdayIndex(word),
      cue: (match[2] ?? match[1])?.toLowerCase() ?? null,
      timed: TIME_AFTER.test(after) || TIME_BEFORE.test(before),
      weekLater: Boolean(match[4]),
      short: word === "sat" || word === "sun",
      name: /^\.[a-z]/i.test(after) || /^\s+[A-Z][a-z]/.test(after) || DAY_PREFIX.test(before),
      compound: DAY_COMPOUND.test(after) || !FREE_AFTER.test(after),
    });
  }
  return found.filter((item) => item.target >= 0);
}

const START_TIME_WORD = /^\s*(?:the\s+)?(?:afternoon|evening|morning|midnight|midday|noon|night|weekend|tonight|today|tomorrow|tmrw|tmr|eod|eow|end)\b/i;
const FREE_WORDS = "about|re|regarding|with|for|and|to|at|in|via|on|by|then|if|please|remind|reminder";
const FREE_AFTER = new RegExp(`^\\s*(?:$|[,.;:!?)]|(?:${FREE_WORDS})\\b)`, "i");
const NOUN_AFTER = new RegExp(`^\\s+(?!(?:${FREE_WORDS})\\b)[a-z]`, "i");
const NAMED_TIME = /\b(?:Today|Tonight|Tomorrow|Noon|Midday|Midnight|Morning|Afternoon|Evening|Night|Day|After|Weekend|Week|Month|End|Eod)\b/;

const EXTRA_DOUBT = new RegExp(
  [
    `\\b${WEEKDAY_ANY}\\s+(?:1[3-9]|2\\d|3[01])\\b(?!\\s*(?:[:.]\\d|am\\b|pm\\b|st\\b|nd\\b|rd\\b|th\\b|${MONTH}))`,
    "\\bnext\\s+next\\b",
    `\\bfor\\s+(?:the\\s+)?(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}|${MONTH}\\s+\\d|\\d{1,2}\\/\\d{1,2}|${WEEKDAY_ANY}\\b|today\\b|tomorrow\\b|tonight\\b|tmrw\\b|tmr\\b)`,
  ].join("|"),
  "i",
);

const TIME_ZONE = /\b(?:gmt|bst|utc|est|edt|pst|pdt|cet|cest|ist|aest)\b|\b(?:their|our|your|local|uk|us)\s+time\b/i;
const UNREAD_DATE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[.-]\d{1,2}[.-]\d{2,4}\b|\b2moro\b/i;
const BARE_NUMBER_END = new RegExp(`(?<!\\b(?:room|rooms|top|chapter|chapters|no|nos|number|version|page|pages|step|steps|level|floor|flat|unit|suite|gate|table|platform|row|seat|section|part|lesson|item|items|slide|slides|issue|ticket|phase|stage|round|team|year|grade|v)\\s+)(?<![£$€#.,/\\d-])\\b(?:[1-9]|1[0-9]|2[0-3])$`, "i");
const LEFTOVER = new RegExp(
  `${TEMPORAL.source}|(?<=\\d|\\d\\s?(?:am|pm)|\\s|^)ish\\b|~|\\bapprox(?:imately)?\\b|\\bat\\s+the\\s+latest\\b|\\b(?:am|pm|eod|eow|cob|cop|tmrw|tmr|daily|weekly|fortnightly|weeks?|days?|hours?|hrs?|mins?|minutes?|lunchtime|first\\s+thing|close\\s+of\\s+(?:play|business)|asap|later|now|tonight|half|quarter|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|sharp|sometime|someday|soon|months?|years?|yesterday|q[1-4]|20\\d\\d|next|dawn|dusk|sunrise|sunset|tom+or+o?w+|tom+o?r+ow|tmw|tomoz|2mor+ow|2moro|tonite|2nite|2day|2morrow|tdy|todya|tody|tonigh|tonihgt|tomrrow|tmrrw|tommorrow|morrow|christmas|xmas|easter|new\\s+year|bank\\s+holiday|(?:mon|tues|wednes|thurs|fri|satur|sun)days)\\b|\\b(?:at|by|before|after|around|from|until|till)\\s+\\d|\\b\\d{1,2}\\s+(?:to|past)\\s+\\d|\\b(?:half|quarter)\\s+(?:past|to|\\d)|\\bin\\s+${MONTH}\\b|(?<![\\d/])\\b(?!24\\/7\\b)(?:[12]?\\d|3[01])\\/(?:0?[1-9]|1[0-2])\\b(?!\\/\\d)|\\d\\s*(?:am|pm)\\b|${NOT_MONEY}(?<![\\d.])(?<!\\b(?:v|ver|version|release|ios|android)\\s*)\\b\\d{1,2}[:.]\\d{2}\\b(?![.\\d])${NOT_CURRENCY_AFTER}`,
  "i",
);
const DANGLING_BEFORE =
  /(?:\b(?:before|from|at|the|to|last|every|by|on|until|till|of|end|start|early|mid|late|after|since|around|about|re|or|between|than|next|in|off|w\/c|dated|starting|not|approx|approximately|around|circa|~)|['’]s|[-–/:+&@(["'“”‘’[])\s*$/i;
const DANGLING_AFTER = /^\s*(?:at\s+the\s+latest\b|latest\b|['’]s\b|[-–/:+&@)\]"'“”‘’]|\.\d|to\b|or\b|ish\b|o['’]?clock\b|am\b|pm\b|\d)/i;

function debris(text: string, spans: Span[], strict = false) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const runs: { start: number; end: number }[] = [];
  for (const span of sorted) {
    const last = runs.at(-1);
    if (last && (span.start < last.end || /^[\s,;]*$/.test(text.slice(last.end, span.start)))) last.end = Math.max(last.end, span.end);
    else runs.push({ start: span.start, end: span.end });
  }
  return runs.some((run) => {
    const before = text.slice(0, run.start);
    const after = text.slice(run.end);
    if (DANGLING_BEFORE.test(before) || DANGLING_AFTER.test(after)) return true;
    if (run.start > 0 && NOUN_AFTER.test(after)) return true;
    if (run.start > 0 && NAMED_TIME.test(text.slice(run.start, run.end)) && text !== text.toUpperCase()) return true;
    if (run.start === 0 && NAMED_TIME.test(text.slice(run.start, run.end)) && /^\s+[A-Z]/.test(after) && text !== text.toUpperCase()) return true;
    if (strict && run.start === 0 && NOUN_AFTER.test(after)) return true;
    if (run.start === 0 && START_TIME_WORD.test(text.slice(run.start, run.end)) && NOUN_AFTER.test(after)) return true;
    const number = /(?:^|\s)(\d{1,4})\s*$/.exec(before);
    return Boolean(number) && !COUNTED.test(before.slice(0, number!.index));
  });
}

const GLUE = String.raw`(?:[,;:]|[-–—](?=\s|$)|\band\b)`;
const GLUE_GAP = new RegExp(String.raw`^(?:\s|${GLUE})*$`, "i");
const GLUE_BEFORE = new RegExp(String.raw`(?:\s*${GLUE})+\s*$`, "i");
const ONLY_GLUE = new RegExp(String.raw`^\s*(?:${GLUE}\s*)*$`, "i");
const ENDING = new RegExp(String.raw`^(?:\s|[,;:.!…]|[-–—]|\band\b)*$`, "i");
const SEPARATOR_AFTER = /^\s*(?:[,;:]|[-–—](?=\s))/;

function trimSpan(text: string, span: Span): Span {
  const lead = /^\s*/.exec(text.slice(span.start, span.end))?.[0].length ?? 0;
  const tail = /\s*$/.exec(text.slice(span.start + lead, span.end))?.[0].length ?? 0;
  return { ...span, start: span.start + lead, end: span.end - tail };
}

function withGlue(text: string, spans: Span[]): Span[] {
  const sorted: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start).map((span) => trimSpan(text, span))) {
    if (span.end <= span.start) continue;
    const last = sorted.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else sorted.push({ ...span });
  }
  const runs: Span[][] = [];
  for (const span of sorted) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (run && previous && GLUE_GAP.test(text.slice(previous.end, span.start))) {
      previous.end = span.start;
      run.push(span);
    } else runs.push([span]);
  }
  for (const run of runs) {
    const first = run[0];
    const last = run[run.length - 1];
    const before = text.slice(0, first.start);
    const after = text.slice(last.end);
    if (ONLY_GLUE.test(before)) {
      first.start = before.length - before.trimStart().length;
      const separator = SEPARATOR_AFTER.exec(after);
      if (separator && !ENDING.test(after)) last.end += separator[0].length;
    }
    if (ENDING.test(after)) {
      last.end = text.length - (text.length - text.trimEnd().length);
      const glue = GLUE_BEFORE.exec(before);
      if (glue && /\S/.test(before.slice(0, glue.index))) first.start = glue.index + (/^\s*/.exec(glue[0])?.[0].length ?? 0);
    } else if (/[,;:]\s*$/.test(before) && /^\s*[,;:]/.test(after)) {
      last.end += /^\s*[,;:]/.exec(after)![0].length;
    }
  }
  return runs.flat().map((span) => trimSpan(text, span)).filter((span) => span.end > span.start);
}

function typedTitle(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function cleanTitle(text: string, spans: Span[]) {
  let result = "";
  let last = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const piece = text.slice(last, span.start).trim();
    if (piece) result = !result ? piece : /^[,.;:!?]/.test(piece) ? `${result}${piece}` : `${result} ${piece}`;
    last = Math.max(last, span.end);
  }
  const rest = text.slice(last).trim();
  if (rest) result = !result ? rest : /^[,.;:!?]/.test(rest) ? `${result}${rest}` : `${result} ${rest}`;
  return typedTitle(result);
}

export function parseTaskText(text: string, now = new Date()): PadParse {
  const repeated = parseRepeatText(text, now);
  if (repeated) return repeated;
  const spans: Span[] = [...text.matchAll(DOC_REFERENCE)].map((match) => ({ start: match.index, end: match.index + match[0].length, kind: "keep" as const }));
  const wall = londonParts(now);
  const today: Day = { year: wall.year, month: wall.month, day: wall.day };
  const found: {
    date: Day | null;
    time: { hour: number; minute: number } | null;
    exact: number | null;
    remind: number | null;
    duration: number | null;
  } = { date: null, time: null, exact: null, remind: null, duration: null };
  let ambiguous = false;
  let doubt = false;
  let slot = false;
  let eveningClock = false;
  let explicitTime = false;
  let evening = false;
  let sameWeekday = false;
  let dateSource: "explicit" | "relative" | "week" | null = null;
  let dateHits = 0;
  let hardDoubt = false;
  let weekAnchor: Day | null = null;
  let weekSpan = null as { start: number; end: number; weeks: number } | null;
  let endOfDay = false;
  const clock = (hour: string, minute: number, meridiem: string | undefined) => {
    explicitTime = true;
    if (!meridiem && !hour.startsWith("0") && Number(hour) >= 1 && Number(hour) <= 12) ambiguous = true;
    if (guessable(hour, meridiem)) return toHour(Number(hour), minute, meridiem);
    ambiguous = true;
    return toHour(Number(hour) + 12, minute, undefined);
  };
  const bareHour = (hour: string) => {
    const value = Number(hour);
    if (evening) return value >= 1 && value <= 11 ? { hour: value + 12, minute: 0 } : value >= 12 && value <= 23 ? { hour: value, minute: 0 } : null;
    if (value < 1 || value > 23) return null;
    if (value <= 12) ambiguous = true;
    return { hour: value <= 6 ? value + 12 : value, minute: 0 };
  };

  const take = (
    pattern: RegExp,
    handle: (match: RegExpExecArray) => boolean | void,
    kind: Span["kind"] = "when",
  ) => {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null = null;
    for (let next = global.exec(text); next; next = global.exec(text)) {
      const candidate = next;
      if (!spans.some((span) => candidate.index < span.end && candidate.index + candidate[0].length > span.start)) {
        match = candidate;
        break;
      }
      if (candidate[0].length === 0) global.lastIndex += 1;
    }
    if (!match) return;
    if (handle(match) === false) return;
    spans.push({ start: match.index, end: match.index + match[0].length, kind });
  };

  const setDate = (candidate: Day, explicitYear: boolean) => {
    if (!valid(candidate)) return false;
    if (!explicitYear && compare(candidate, today) < 0 && compare({ ...candidate, year: candidate.year + 1 }, addDays(today, 92)) > 0) {
      doubt = true;
      if (compare(candidate, addDays(today, -61)) >= 0) hardDoubt = true;
    }
    found.date = !explicitYear && compare(candidate, today) < 0 ? { ...candidate, year: candidate.year + 1 } : candidate;
    dateSource = "explicit"; dateHits += 1;
  };

  take(
    /[,;]?\s*(?:\band\s+)?\bremind(?:er)?(?:\s+me)?\s+(?:(\d+|an?|one|two|three|four|five|six|ten|fifteen|thirty)\s*(mins?|minutes?|m|hrs?|hours?|h|days?|d|weeks?|w)\s*(?:before|early|earlier|beforehand|ahead)?|(?:at|on)\s+the\s+(?:due\s+)?time|on\s+time)\b/i,
    (match) => {
      found.remind = match[1] ? nearestReminder(amount(match[1]) * unitMinutes(match[2])) : 0;
    },
    "reminder",
  );
  take(/\bin\s+(\d+|an?|one|two|three|four|five|six|ten|fifteen|thirty)\s*(mins?|minutes?|hrs?|hours?|days?|weeks?)\b/i, (match) => {
    const minutes = amount(match[1]) * unitMinutes(match[2]);
    if (minutes >= 24 * 60) {
      found.date = addDays(today, Math.round(minutes / (24 * 60)));
      dateSource = /^w/i.test(match[2]) ? "week" : "relative"; dateHits += 1;
      weekAnchor = dateSource === "week" ? found.date : null;
      if (dateSource === "week") weekSpan = { start: match.index, end: match.index + match[0].length, weeks: amount(match[1]) };
    } else found.exact = minutes;
  });
  take(new RegExp(`${LEAD}\\b(?:the\\s+)?day\\s+after\\s+tomorrow\\b`, "i"), () => {
    found.date = addDays(today, 2);
    dateSource = "relative"; dateHits += 1;
  });
  take(new RegExp(`${LEAD}\\b(today|tonight|tomorrow|tmrw|tmr)\\b`, "i"), (match) => {
    const word = match[1].toLowerCase();
    found.date = word === "today" || word === "tonight" ? today : addDays(today, 1);
    dateSource = "relative"; dateHits += 1;
    if (word === "tonight" && !found.time) {
      found.time = { hour: 19, minute: 0 };
      evening = true;
    }
  });
  take(/(?<=\b(?:tonight|night|evening)\s+)(?:at\s+)?(\d{1,2})(?:[:.]([0-5]\d))?(?:\s*(am|pm))?\b(?![:.]?\d)/i, (match) => {
    const hour = Number(match[1]);
    if (match[3]?.toLowerCase() === "am" || hour === 0 || hour === 12 || hour > 23) {
      doubt = true;
      return false;
    }
    found.time = { hour: hour < 12 ? hour + 12 : hour, minute: Number(match[2] ?? 0) };
    eveningClock = true;
    evening = false;
  });
  take(new RegExp(`${LEAD}\\b(?:end\\s+of\\s+(?:the\\s+)?week|eow)\\b`, "i"), () => {
    found.date = addDays(today, (5 - weekday(today) + 7) % 7);
    found.time = found.time ?? { hour: 17, minute: 0 };
    dateSource = "relative"; dateHits += 1;
  });
  take(new RegExp(`${LEAD}\\bnext\\s+week\\b`, "i"), (match) => {
    found.date = addDays(today, ((1 - weekday(today) + 7) % 7) || 7);
    dateSource = "week"; dateHits += 1;
    weekAnchor = found.date;
    weekSpan = { start: match.index, end: match.index + match[0].length, weeks: 0 };
  });
  take(new RegExp(`${LEAD}\\b(?:this\\s+)?weekend\\b`, "i"), () => {
    if (weekday(today) === 0 || weekday(today) === 6) doubt = true;
    found.date = addDays(today, ((6 - weekday(today) + 7) % 7) || 7);
    dateSource = "relative"; dateHits += 1;
  });
  take(new RegExp(`${LEAD}\\bnext\\s+month\\b`, "i"), () => {
    found.date = { year: today.month === 12 ? today.year + 1 : today.year, month: today.month === 12 ? 1 : today.month + 1, day: 1 };
    dateSource = "relative"; dateHits += 1;
  });
  take(new RegExp(`${LEAD}\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}\\b(?:\\s+(\\d{4}))?`, "i"), (match) =>
    setDate({ year: match[3] ? Number(match[3]) : today.year, month: monthIndex(match[2]) + 1, day: Number(match[1]) }, Boolean(match[3])),
  );
  take(new RegExp(`${LEAD}\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "i"), (match) =>
    setDate({ year: match[3] ? Number(match[3]) : today.year, month: monthIndex(match[1]) + 1, day: Number(match[2]) }, Boolean(match[3])),
  );
  take(new RegExp(`${LEAD}(?<![\\d/.])\\b(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?\\b(?![/.]\\d)`, "i"), (match) => {
    if (match[1] === "24" && match[2] === "7" && !match[3]) return false;
    const year = match[3] ? (match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])) : today.year;
    const led = /^\s*(?:on|by|due|for|this)\s/i.test(match[0]);
    const after = text.slice(match.index + match[0].length);
    const closing = /^\s*(?:$|[,;.!?]|(?:at\s+)?\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\b|at\b|remind)/i.test(after);
    if (!match[3] && !led && valid({ year, month: Number(match[2]), day: Number(match[1]) })) ambiguous = true;
    if (!match[3] && !led && !closing) return false;
    return setDate({ year, month: Number(match[2]), day: Number(match[1]) }, Boolean(match[3]));
  });
  take(
    new RegExp(`\\b(?:at\\s+|from\\s+)?${NOT_MONEY}(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)?\\s*-\\s*(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)\\b`, "i"),
    (match) => {
      const end = toHour(Number(match[4]), Number(match[5] ?? 0), match[6]);
      if (!end) return false;
      const startHour = Number(match[1]);
      if (startHour < 1) return false;
      const startMinute = Number(match[2] ?? 0);
      const later = toHour(startHour, startMinute, match[3] ?? match[6]);
      const start = match[3] || (later && later.hour * 60 + later.minute < end.hour * 60 + end.minute) ? later : toHour(startHour, startMinute, "am");
      if (!start) return false;
      const minutes = end.hour * 60 + end.minute - (start.hour * 60 + start.minute);
      if (minutes <= 0) return false;
      found.time = start;
      found.duration = minutes <= MAX_TASK_DURATION ? minutes : null;
      ambiguous = true;
    },
  );
  take(new RegExp(`\\b(?:at\\s+)?${NOT_MONEY}(\\d{1,2}):(\\d{2})(?:\\s*(am|pm))?\\b${NOT_CURRENCY_AFTER}`, "i"), (match) => {
    const parsed = clock(match[1], Number(match[2]), match[3]);
    if (!parsed) return false;
    found.time = parsed;
  });
  take(
    new RegExp(
      `(?:\\bat\\s+|(?<=\\b${DAY_WORD}\\s+))${NOT_MONEY}(\\d{1,2})\\.(\\d{2})(?:\\s*(am|pm))?\\b${NOT_CURRENCY_AFTER}|\\b${NOT_MONEY}(\\d{1,2})\\.(\\d{2})\\s*(am|pm)\\b`,
      "i",
    ),
    (match) => {
      const parsed = clock(match[1] ?? match[4], Number(match[2] ?? match[5]), match[3] ?? match[6]);
      if (!parsed) return false;
      found.time = parsed;
    },
  );
  take(new RegExp(`\\b(?:at\\s+)?${NOT_MONEY}(?<!\\d\\s*-\\s*)(\\d{1,2})\\s*(am|pm)\\b`, "i"), (match) => {
    const parsed = toHour(Number(match[1]), 0, match[2]);
    if (!parsed) return false;
    found.time = parsed;
    explicitTime = true;
  });
  take(
    new RegExp(`(?:(?<=\\b${DAY_WORD}\\s+)(?:at\\s+)?|\\bat\\s+)${NOT_MONEY}(\\d{1,2})(?=\\s*(?:$|[,;!?]|\\.(?!\\d)|and\\b|remind|(?:on\\s+|this\\s+|next\\s+)?${DAY_WORD}\\b))`, "i"),
    (match) => {
      if (found.time && !evening) return false;
      const parsed = bareHour(match[1]);
      if (!parsed) return false;
      found.time = parsed;
      evening = false;
    },
  );
  take(
    new RegExp(`(?<![\\d£$€.,:/]\\s?)\\b${NOT_MONEY}(\\d{1,2})(?=\\s+(?:on\\s+|this\\s+|next\\s+)?${DAY_WORD}\\b)`, "i"),
    (match) => {
      const before = text.slice(0, match.index);
      if ((found.time && !evening) || COUNTED.test(before)) return false;
      if (!cuedNumber(before)) {
        if (MEETING_ANYWHERE.test(before)) ambiguous = true;
        return false;
      }
      const parsed = bareHour(match[1]);
      if (!parsed) return false;
      found.time = parsed;
      evening = false;
    },
  );
  take(new RegExp(`\\b(?:at\\s+)?${NOT_MONEY}(\\d{1,2})\\s*o['’]?clock\\b`, "i"), (match) => {
    if (found.time && !evening) return false;
    const parsed = bareHour(match[1]);
    if (!parsed) return false;
    found.time = parsed;
  });
  take(/\b(?:at\s+)?(noon|midday|midnight)\b/i, (match) => {
    found.time = match[1].toLowerCase() === "midnight" ? { hour: 0, minute: 0 } : { hour: 12, minute: 0 };
  });
  take(new RegExp(`\\bhalf\\s+past\\s+(\\d{1,2})\\b|\\bquarter\\s+(past|to)\\s+(\\d{1,2})\\b`, "i"), (match) => {
    if (found.time && !evening) return false;
    const base = bareHour(match[1] ?? match[3]);
    if (!base) return false;
    const offset = match[1] ? 30 : match[2].toLowerCase() === "past" ? 15 : -15;
    const minutes = base.hour * 60 + offset;
    found.time = { hour: Math.floor(minutes / 60), minute: minutes % 60 };
    ambiguous = true;
    evening = false;
  });
  take(/\b(?:at\s+)?lunch\s*time\b/i, () => {
    if (found.time) return false;
    found.time = { hour: 12, minute: 30 };
    ambiguous = true;
  });
  take(new RegExp(`(?<=\\b${DAY_WORD}\\s+)night\\b`, "i"), () => {
    if (found.time && !eveningClock) return false;
    found.time = found.time ?? { hour: 19, minute: 0 };
    slot = true;
  });
  take(/\b(?:in\s+the\s+|this\s+)?(morning|afternoon|evening)\b/i, (match) => {
    const key = match[1].toLowerCase();
    if (eveningClock && key === "evening") return;
    if (found.time) return false;
    found.time = key === "morning" ? { hour: 9, minute: 0 } : key === "afternoon" ? { hour: 14, minute: 0 } : { hour: 18, minute: 0 };
    slot = true;
  });
  take(/\b(?:by\s+)?(?:eod|end\s+of\s+(?:the\s+)?day)\b/i, () => {
    slot = true;
    endOfDay = true;
    found.time = found.time ?? { hour: 17, minute: 0 };
  });
  const bounded = new RegExp(`\\b(before|after)\\s+(?:at\\s+)?${CLOCK}`, "i").exec(text);
  if (bounded && found.time) {
    ambiguous = true;
    spans.push({ start: bounded.index, end: bounded.index + bounded[1].length, kind: "when" });
  }

  const weekdays = readWeekdays(text, spans);
  const otherDate = dateSource !== null || found.exact !== null;
  const near = (item: WeekdayWord) =>
    spans.some((span) => span.kind === "when" && /^[\s,]*$/.test(item.end <= span.start ? text.slice(item.end, span.start) : span.end <= item.start ? text.slice(span.end, item.start) : "x"));
  const dated = weekdays.filter((item) => !item.name && (item.cue || item.timed || item.weekLater || near(item) || (!otherDate && !item.compound && !item.short)));
  const targets = new Set(dated.map((item) => item.target));
  const consume = () => {
    for (const item of dated) spans.push({ start: item.start, end: item.end, kind: "when" });
  };
  if (dated.some((item) => item.cue === "from" || item.cue === "until")) doubt = true;
  if (targets.size > 1) ambiguous = true;
  else if (dated.length > 0) {
    const chosen = dated[0];
    const ahead = (chosen.target - weekday(today) + 7) % 7;
    if (found.exact !== null) ambiguous = true;
    else if (dateSource === "explicit" || dateSource === "relative") {
      if (found.date && weekday(found.date) === chosen.target) consume();
      else ambiguous = true;
    } else if (dateSource === "week" && weekSpan && weekAnchor) {
      if (weekSpan.weeks > 0) {
        found.date = addDays(today, (ahead || 7) + 7 * weekSpan.weeks);
        if ((chosen.target + 6) % 7 <= (weekday(today) + 6) % 7) doubt = true;
        if (ahead === 0) ambiguous = true;
      }
      else found.date = addDays(addDays(weekAnchor, -((weekday(weekAnchor) + 6) % 7)), (chosen.target + 6) % 7);
      consume();
    } else {
      found.date = chosen.cue === "this" && ahead === 0 ? today : addDays(today, (ahead || 7) + (chosen.weekLater ? 7 : 0));
      sameWeekday = ahead === 0 && !chosen.weekLater && chosen.cue !== "next" && chosen.cue !== "this";
      if (chosen.cue === "next" && ahead > 0 && (weekday(today) + 6) % 7 + ahead <= 6) doubt = true;
      if (chosen.weekLater && ahead === 0) ambiguous = true;
      consume();
    }
  }
  if (endOfDay && !found.date) found.date = today;

  let due: string | null = null;
  if (found.exact !== null) {
    const parts = londonParts(new Date(now.getTime() + found.exact * 60_000));
    due = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
    if (wallTimeCount({ year: parts.year, month: parts.month, day: parts.day }, { hour: parts.hour, minute: parts.minute }) !== 1) ambiguous = true;
  } else if (found.date || found.time) {
    const time = found.time;
    let day = found.date ?? today;
    const passed = time !== null && (time.hour < wall.hour || (time.hour === wall.hour && time.minute < wall.minute));
    if (time && !found.date && passed) day = addDays(today, 1);
    if (time && sameWeekday && !passed) day = today;
    const date = `${day.year}-${pad(day.month)}-${pad(day.day)}`;
    due = time ? `${date}T${pad(time.hour)}:${pad(time.minute)}` : date;
    if (time && wallTimeCount(day, time) !== 1) ambiguous = true;
    if (sameWeekday && (!time || slot)) doubt = true;
    if (time && slot && !found.date && passed) {
      doubt = true;
      hardDoubt = true;
    }
    const dueAt = time ? Date.UTC(day.year, day.month - 1, day.day, time.hour, time.minute) : Date.UTC(day.year, day.month - 1, day.day, 23, 59);
    const wallNow = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    if (dueAt < wallNow) {
      doubt = true;
      hardDoubt = true;
    }
  }

  const readable = text.replace(DOC_REFERENCE, (found) => " ".repeat(found.length));
  if (TIME_ZONE.test(readable) || UNREAD_DATE.test(readable) || dateHits > 1 || EXTRA_DOUBT.test(readable)) doubt = true;
  const kept = (due ? spans : spans.filter((span) => span.kind !== "reminder")).filter((span) => span.kind !== "keep");
  const glued = withGlue(text, kept);
  const title = cleanTitle(text, glued);
  const docFree = title.replace(DOC_REFERENCE, " ");
  if (new RegExp(`(?<![£$€\\d.]\\s*)(?<!\\b(?:gbp|usd|eur)\\s*)\\b\\d{1,2}\\.[0-5]\\d\\b(?!\\s*(?:gbp|usd|eur)\\b)`, "i").test(docFree) && !/\b(?:v|ver|version|release)\s*\d/i.test(docFree)) ambiguous = true;
  const marks = glued.filter((span) => span.kind === "when" || due).map((span) => ({ start: span.start, end: span.end, kind: span.kind }) as PadMark);
  if (/\?\s*$/.test(readable)) doubt = true;
  const plainTitle = explicitTime ? docFree.replace(/\blunch\b/gi, "") : docFree;
  if (kept.length > 0 && (doubt || !title || LEFTOVER.test(plainTitle) || debris(text, kept))) {
    return { title: typedTitle(text), due: null, remindMinutes: null, durationMinutes: null, unsure: true, marks: marks.filter((mark) => mark.kind === "when"), guess: hardDoubt ? null : due };
  }
  const unsure = ambiguous || doubt || LEFTOVER.test(plainTitle) || BARE_NUMBER_END.test(docFree);
  return {
    title: unsure || !due ? typedTitle(text) : title,
    due,
    remindMinutes: due ? found.remind : null,
    durationMinutes: due && found.time ? found.duration : null,
    unsure,
    marks,
    guess: hardDoubt ? null : due,
  };
}

export type PadRepeat = { rule: RepeatRule; ends: RepeatEnds };

const REPEAT_NUMBERS: Record<string, number> = { other: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, one: 1 };
const REPEAT_DAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)";
const REPEAT_DAYS = `${REPEAT_DAY}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*)${REPEAT_DAY})*`;
const REPEAT_COUNT = "(?:other|\\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const REPEAT_NTH = "(?:first|second|third|fourth|last|1st|2nd|3rd|4th)";
const REPEAT_ORD = "\\d{1,2}(?:st|nd|rd|th)";
const REPEAT_MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const REPEAT_DATE = `(?:\\d{1,2}(?:st|nd|rd|th)?(?:\\s+of)?\\s+${REPEAT_MONTH}|${REPEAT_MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?)\\b`;
type RepeatKind = "daily" | "weekdays" | "weekly" | "month-week" | "month-day" | "monthly" | "yearly";
const REPEAT_PATTERNS: { kind: RepeatKind; pattern: RegExp }[] = [
  { kind: "daily", pattern: new RegExp(`\\b(?:every|each)\\s+${REPEAT_COUNT}\\s+days?\\b|\\b(?:every|each)\\s+day\\b|\\bdaily\\b`, "gi") },
  { kind: "weekdays", pattern: /\b(?:every|each)\s+weekday\b/gi },
  { kind: "weekly", pattern: new RegExp(`\\b(?:(?:every|each)\\s+${REPEAT_COUNT}\\s+weeks?|(?:every|each)\\s+week|weekly)(?:\\s+on\\s+${REPEAT_DAYS})?\\b|\\b(?:every|each)\\s+(?:other\\s+)?${REPEAT_DAYS}\\b`, "gi") },
  { kind: "month-week", pattern: new RegExp(`(?:\\bon\\s+)?(?:\\bthe\\s+)?\\b${REPEAT_NTH}\\s+${REPEAT_DAY}\\s+of\\s+(?:every|each|the)\\s+month\\b`, "gi") },
  { kind: "month-day", pattern: new RegExp(`(?:\\bon\\s+)?\\bthe\\s+${REPEAT_ORD}\\s+of\\s+(?:every|each|the)\\s+month\\b`, "gi") },
  { kind: "monthly", pattern: new RegExp(`\\b(?:(?:every|each)\\s+${REPEAT_COUNT}\\s+months?|(?:every|each)\\s+month|monthly)(?:\\s+on\\s+the\\s+(?:${REPEAT_ORD}|${REPEAT_NTH}\\s+${REPEAT_DAY}))?\\b`, "gi") },
  { kind: "yearly", pattern: new RegExp(`\\b(?:(?:every|each)\\s+${REPEAT_COUNT}\\s+years?|(?:every|each)\\s+year|yearly|annually)(?:\\s+on\\s+(?:the\\s+)?${REPEAT_DATE})?|\\b(?:every|each)\\s+${REPEAT_DATE}`, "gi") },
];
const REPEAT_BARE = /^(?:daily|weekly|monthly|yearly|annually)/i;
const REPEAT_NOUN_BEFORE = /\b(?:the|a|an|my|our|your|their|his|her|its|this|that|these|those)\s+$/i;
const REPEAT_TIME = new RegExp(`^\\s*,?\\s*(?:(?:at\\s+)?${CLOCK}|at\\s+\\d{1,2}\\b(?![:.]\\d))`, "i");
const REPEAT_END = new RegExp(
  `^\\s*,?\\s*(?:(?:until|till)\\s+(${REPEAT_DATE}(?:,?\\s+\\d{4})?)|for\\s+(\\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s+(days?|weeks?|months?|years?)\\b|(?:for\\s+)?(\\d{1,3})\\s+times\\b)`,
  "i",
);
const REPEAT_START = /^\s*,?\s*(?:from|starting(?:\s+(?:on|from))?|beginning|commencing)\b(?=\s+\S)/i;
const REPEAT_TITLE_WORDS = /\b(?:daily|weekly|monthly|yearly|annually)\b/gi;

function repeatNumber(word: string | undefined) {
  if (!word) return 1;
  return /^\d+$/.test(word) ? Number(word) : (REPEAT_NUMBERS[word.toLowerCase()] ?? 1);
}

function repeatWeekday(word: string): Weekday {
  return TASK_WEEKDAYS[(weekdayIndex(word) + 6) % 7];
}

function repeatDays(words: string): Weekday[] {
  const days = [...words.matchAll(new RegExp(`\\b${REPEAT_DAY}s?\\b`, "gi"))].map((match) => repeatWeekday(match[0]));
  return TASK_WEEKDAYS.filter((day) => days.includes(day));
}

function repeatNth(word: string): MonthWeek["n"] {
  const key = word.toLowerCase();
  if (key === "last") return -1;
  return (["first", "second", "third", "fourth"].indexOf(key) + 1 || Number(key.slice(0, 1))) as MonthWeek["n"];
}

function readDayMonth(words: string, todayKey: string) {
  const dayFirst = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${REPEAT_MONTH})\\b(?:,?\\s+(\\d{4}))?`, "i").exec(words);
  const monthFirst = dayFirst ? null : new RegExp(`(${REPEAT_MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "i").exec(words);
  if (!dayFirst && !monthFirst) return null;
  const day = Number(dayFirst ? dayFirst[1] : monthFirst![2]);
  const month = monthIndex(dayFirst ? dayFirst[2] : monthFirst![1]) + 1;
  const year = dayFirst ? dayFirst[3] : monthFirst![3];
  if (year) return valid({ year: Number(year), month, day }) ? dayKey(Number(year), month, day) : null;
  const today = dayParts(todayKey);
  for (let candidate = today.year; candidate <= today.year + 4; candidate += 1) {
    if (valid({ year: candidate, month, day }) && dayKey(candidate, month, day) >= todayKey) return dayKey(candidate, month, day);
  }
  return null;
}

type FoundRepeat = {
  spans: Span[];
  startCue: number | null;
  rule: (start: string) => RepeatRule;
  fixedDay: string | null;
  ends: { until?: string; span?: { amount: number; unit: string }; count?: number };
};

function findRepeat(text: string, todayKey: string): FoundRepeat | "unsure" | null {
  const docs = [...text.matchAll(DOC_REFERENCE)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const hits: { start: number; end: number; kind: RepeatKind }[] = [];
  for (const { kind, pattern } of REPEAT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (docs.some((doc) => start < doc.end && end > doc.start)) continue;
      if (REPEAT_BARE.test(match[0]) && REPEAT_NOUN_BEFORE.test(text.slice(0, start))) continue;
      hits.push({ start, end, kind });
    }
  }
  const chosen = hits
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((hit, index, all) => !all.slice(0, index).some((other) => hit.start < other.end && hit.end > other.start));
  if (chosen.length === 0) return null;
  if (chosen.length > 1) return "unsure";
  const hit = chosen[0];
  const spans: Span[] = [{ start: hit.start, end: hit.end, kind: "when" }];
  const ends: FoundRepeat["ends"] = {};
  let cursor = hit.end;
  let timed = false;
  let ended = false;
  for (let step = 0; step < 3; step += 1) {
    const rest = text.slice(cursor);
    const time = timed ? null : REPEAT_TIME.exec(rest);
    if (time) {
      timed = true;
      cursor += time[0].length;
      continue;
    }
    const end = ended ? null : REPEAT_END.exec(rest);
    if (!end) break;
    ended = true;
    if (end[1]) {
      const until = readDayMonth(end[1], todayKey);
      if (!until) return "unsure";
      ends.until = until;
    } else if (end[2]) ends.span = { amount: repeatNumber(end[2]), unit: end[3].toLowerCase().replace(/s$/, "") };
    else ends.count = Number(end[4]);
    spans.push({ start: cursor + (end[0].length - end[0].trimStart().length), end: cursor + end[0].length, kind: "when" });
    cursor += end[0].length;
  }
  const started = REPEAT_START.exec(text.slice(cursor));
  if (started) spans.push({ start: cursor + (started[0].length - started[0].trimStart().length), end: cursor + started[0].length, kind: "when" });
  else if (!FREE_AFTER.test(text.slice(cursor))) return null;
  const words = text.slice(hit.start, hit.end).toLowerCase();
  const interval = /\b(?:every|each)\s+other\b/.test(words) ? 2 : repeatNumber(/\b(?:every|each)\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:days?|weeks?|months?|years?)\b/.exec(words)?.[1]);
  const named = repeatDays(words);
  const nth = new RegExp(`\\b(${REPEAT_NTH})\\s+(${REPEAT_DAY})\\b`, "i").exec(words);
  const ord = /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(words);
  let fixedDay: string | null = null;
  if (hit.kind === "yearly" && new RegExp(`\\b${REPEAT_MONTH}\\b`, "i").test(words)) {
    fixedDay = readDayMonth(words, todayKey);
    if (!fixedDay) return "unsure";
  }
  const rule = (start: string): RepeatRule => {
    if (hit.kind === "daily") return { freq: "daily", interval };
    if (hit.kind === "weekdays") return { freq: "weekly", interval: 1, weekdays: [...WORKWEEK] };
    if (hit.kind === "weekly") return { freq: "weekly", interval, weekdays: named.length > 0 ? named : [weekdayOf(start)] };
    if (nth && (hit.kind === "month-week" || hit.kind === "monthly")) return { freq: "monthly", interval, monthWeek: { n: repeatNth(nth[1]), weekday: repeatWeekday(nth[2]) } };
    if (hit.kind === "month-day" || hit.kind === "monthly") return { freq: "monthly", interval, monthDay: ord ? Number(ord[1]) : Number(start.slice(8, 10)) };
    return { freq: "yearly", interval };
  };
  return { spans, startCue: started ? cursor + started[0].length : null, rule, fixedDay, ends };
}

export function padRepeatDue(repeat: PadRepeat, due: string | null, now = new Date()) {
  const wall = londonParts(now);
  const todayKey = dayKey(wall.year, wall.month, wall.day);
  const at = due && padDueHasTime(due) ? due.slice(11, 16) : null;
  const start = !due || due.slice(0, 10) < todayKey ? todayKey : due.slice(0, 10);
  const rule = { ...repeat.rule, interval: 1 };
  let day = firstPatternDay(rule, start);
  if (day && at && `${day}T${at}` <= `${todayKey}T${pad(wall.hour)}:${pad(wall.minute)}`) day = firstPatternDay(rule, start, shiftDay(day, 1));
  if (!day) return null;
  return at ? `${day}T${at}` : day;
}

function untilAfter(first: string, span: { amount: number; unit: string }) {
  if (span.unit === "day") return shiftDay(first, span.amount - 1);
  if (span.unit === "week") return shiftDay(first, span.amount * 7 - 1);
  const { year, month, day } = dayParts(first);
  const index = year * 12 + (month - 1) + (span.unit === "month" ? span.amount : span.amount * 12);
  const toYear = Math.floor(index / 12);
  const toMonth = (index % 12) + 1;
  return shiftDay(dayKey(toYear, toMonth, Math.min(day, daysInMonth(toYear, toMonth))), -1);
}

function unsureRepeat(text: string): PadParse {
  return { title: typedTitle(text), due: null, remindMinutes: null, durationMinutes: null, unsure: true, marks: [], guess: null };
}

function parseRepeatText(text: string, now: Date): PadParse | null {
  const wall = londonParts(now);
  const todayKey = dayKey(wall.year, wall.month, wall.day);
  const found = findRepeat(text, todayKey);
  if (found === null) return null;
  if (found === "unsure") return unsureRepeat(text);
  let masked = text;
  for (const span of found.spans) masked = `${masked.slice(0, span.start)}${" ".repeat(span.end - span.start)}${masked.slice(span.end)}`;
  const inner = parseTaskText(masked, now);
  if (inner.unsure) return unsureRepeat(text);
  const innerDay = inner.due ? inner.due.slice(0, 10) : null;
  const at = inner.due && padDueHasTime(inner.due) ? inner.due.slice(11, 16) : null;
  if (found.startCue !== null && !inner.marks.some((mark) => mark.kind === "when" && /^\s*$/.test(text.slice(found.startCue!, mark.start)))) return unsureRepeat(text);
  if (found.fixedDay && innerDay && innerDay !== todayKey && innerDay !== shiftDay(todayKey, 1)) return unsureRepeat(text);
  const start = found.fixedDay ?? innerDay ?? todayKey;
  const rule = normalRule(found.rule(start));
  if (checkRule(rule)) return unsureRepeat(text);
  const due = padRepeatDue({ rule, ends: { never: true } }, at ? `${start}T${at}` : start, now);
  if (!due) return unsureRepeat(text);
  const first = due.slice(0, 10);
  const ends: RepeatEnds = found.ends.until
    ? { until: found.ends.until }
    : found.ends.span
      ? { until: untilAfter(first, found.ends.span) }
      : found.ends.count !== undefined
        ? { count: found.ends.count }
        : { never: true };
  if (checkEnds(ends, first, todayKey)) return unsureRepeat(text);
  const spans: Span[] = [...found.spans, ...inner.marks.map((mark): Span => ({ start: mark.start, end: mark.end, kind: mark.kind === "reminder" ? "reminder" : "when" }))];
  const glued = withGlue(text, spans);
  const title = cleanTitle(text, glued);
  const docFree = title.replace(DOC_REFERENCE, " ");
  if (!title || debris(text, spans) || LEFTOVER.test(docFree.replace(REPEAT_TITLE_WORDS, " "))) return unsureRepeat(text);
  return {
    title,
    due,
    remindMinutes: at ? inner.remindMinutes : null,
    durationMinutes: at ? inner.durationMinutes : null,
    unsure: false,
    marks: glued.map((span): PadMark => ({ start: span.start, end: span.end, kind: span.kind === "reminder" ? "reminder" : "when" })),
    guess: due,
    repeat: { rule, ends },
  };
}

export type PadAiRepeat = {
  phrase: string;
  every: RepeatEvery;
  interval?: number | null;
  days?: string[] | null;
  monthDay?: number | null;
  monthWeek?: { n: number; weekday: string } | null;
  ends?: { after?: number | null; on?: string | null } | null;
};

const AI_REPEAT_CUE = /\b(?:every|each|daily|weekly|fortnightly|monthly|yearly|annually|weekdays|(?:mon|tues|wednes|thurs|fri|satur|sun)days)\b/i;
const AI_REPEAT_WORD = new RegExp(
  [
    "^(?:every|each|other|alternate|daily|weekly|fortnightly|monthly|yearly|annually|weekday|weekdays|week|weeks|day|days|month|months|year|years|on|the|of|and|until|till|for|times|first|second|third|fourth|last|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|&)$",
    "^\\d{1,4}(?:st|nd|rd|th)?$",
    `^${REPEAT_MONTH}$`,
    `^${REPEAT_DAY}s?$`,
  ].join("|"),
  "i",
);

function aiRepeatRule(input: PadAiRepeat, start: string): RepeatRule | null {
  const interval = input.interval ?? 1;
  if (input.every === "day") return { freq: "daily", interval };
  if (input.every === "weekday") return { freq: "weekly", interval, weekdays: [...WORKWEEK] };
  if (input.every === "week") {
    const days = (input.days ?? []).map((day) => TASK_WEEKDAYS.find((name) => name === day.trim().toLowerCase().slice(0, 2)) ?? null);
    if (days.some((day) => day === null)) return null;
    return { freq: "weekly", interval, weekdays: days.length > 0 ? (days as Weekday[]) : [weekdayOf(start)] };
  }
  if (input.every === "month") {
    if (input.monthWeek) {
      const weekday = TASK_WEEKDAYS.find((name) => name === input.monthWeek!.weekday.trim().toLowerCase().slice(0, 2));
      return weekday ? { freq: "monthly", interval, monthWeek: { n: input.monthWeek.n as MonthWeek["n"], weekday } } : null;
    }
    return { freq: "monthly", interval, monthDay: input.monthDay ?? Number(start.slice(8, 10)) };
  }
  if (input.every === "year") return { freq: "yearly", interval };
  return null;
}

function aiRepeatAgrees(phrase: string, rule: RepeatRule, ends: RepeatEnds, first: string) {
  const all = phrase.toLowerCase();
  const words = all.replace(/\b(?:until|till|for)\b.*$/, " ").replace(/\b\d{1,3}\s+times\b/, " ");
  const named = repeatDays(words.replace(/\bweekdays?\b/g, " "));
  const monthWord = new RegExp(`\\b${REPEAT_MONTH}\\b`, "i").test(words);
  const allowed = new Set<RepeatRule["freq"]>();
  if (/\bdaily\b|\bdays?\b/.test(words)) allowed.add("daily");
  if (/\bweekly\b|\bweeks?\b|\bfortnightly\b|\bweekdays?\b/.test(words) || (named.length > 0 && !/\bmonths?\b/.test(words))) allowed.add("weekly");
  if (/\bmonthly\b|\bmonths?\b/.test(words)) allowed.add("monthly");
  if (/\byearly\b|\bannually\b|\byears?\b/.test(words) || monthWord) allowed.add("yearly");
  if (!allowed.has(rule.freq) || (monthWord && rule.freq !== "yearly")) return false;
  const shown = rule.freq === "weekly" ? (rule.weekdays ?? []) : rule.monthWeek ? [rule.monthWeek.weekday] : [];
  if (named.length > 0 ? named.join() !== [...shown].sort((a, b) => TASK_WEEKDAYS.indexOf(a) - TASK_WEEKDAYS.indexOf(b)).join() : rule.freq === "weekly" && !/\bweekdays?\b/.test(words) && shown.length !== 1) return false;
  if (/\bweekdays?\b/.test(words) && named.length === 0 && (rule.freq !== "weekly" || shown.length !== 5 || !WORKWEEK.every((day) => shown.includes(day)))) return false;
  const counted = /\b(other|alternate|\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:days?|weeks?|months?|years?)\b/.exec(words);
  const wanted = /\bfortnightly\b/.test(words) ? 2 : counted ? repeatNumber(counted[1] === "alternate" ? "other" : counted[1]) : /\b(?:other|alternate)\b/.test(words) ? 2 : null;
  if (wanted !== null ? wanted !== rule.interval : rule.interval !== 1 && !/\b(?:first|second|third|fourth)\b/.test(words)) return false;
  if (rule.monthWeek && !new RegExp(`\\b(?:${["", "first", "second", "third", "fourth"][rule.monthWeek.n] || "last"}|${rule.monthWeek.n === -1 ? "last" : `${rule.monthWeek.n}(?:st|nd|rd|th)`})\\b`).test(words)) return false;
  if (rule.monthDay !== undefined && /\b\d{1,2}(?:st|nd|rd|th)\b/.test(words) && !new RegExp(`\\b${rule.monthDay}(?:st|nd|rd|th)\\b`).test(words)) return false;
  if (rule.freq === "yearly" && monthWord) {
    const day = readDayMonth(words, first);
    if (!day || day.slice(5) !== first.slice(5)) return false;
  }
  if ("never" in ends) return !/\b(?:until|till|times|for)\b/.test(all);
  if ("count" in ends) return new RegExp(`\\b${ends.count}\\s+times\\b`).test(all);
  const until = /\b(?:until|till)\b(.*)$/.exec(all);
  if (until) return "until" in ends && readDayMonth(until[1], first) === ends.until;
  const span = /\bfor\s+(\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month|year)s?\b/.exec(all);
  return Boolean(span) && "until" in ends && untilAfter(first, { amount: repeatNumber(span![1]), unit: span![2] }) === ends.until;
}

function acceptAiRepeat(text: string, input: PadAiRepeat, due: string, now: Date): { span: Span; repeat: PadRepeat } | null {
  const phrase = input.phrase?.trim() ?? "";
  if (!phrase || !AI_REPEAT_CUE.test(phrase)) return null;
  if (!phrase.split(/[\s,]+/).filter(Boolean).every((word) => AI_REPEAT_WORD.test(word.replace(/[.!?]+$/, "")))) return null;
  const found = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${spacedPattern(phrase)}(?![\\p{L}\\p{N}])`, "gu"))];
  if (found.length !== 1) return null;
  const start = found[0].index;
  const end = start + found[0][0].length;
  if ([...text.matchAll(DOC_REFERENCE)].some((doc) => start < doc.index + doc[0].length && end > doc.index)) return null;
  const wall = londonParts(now);
  const todayKey = dayKey(wall.year, wall.month, wall.day);
  const rule = aiRepeatRule(input, due.slice(0, 10));
  if (!rule || checkRule(rule)) return null;
  const ends: RepeatEnds = input.ends?.after != null ? { count: input.ends.after } : input.ends?.on ? { until: input.ends.on } : { never: true };
  const repeat = { rule: normalRule(rule), ends };
  if (padRepeatDue(repeat, due, now) !== due) return null;
  if (checkEnds(ends, due.slice(0, 10), todayKey)) return null;
  if (!aiRepeatAgrees(phrase, repeat.rule, ends, due.slice(0, 10))) return null;
  return { span: { start, end, kind: "when" }, repeat };
}

export type PadAiAnswer = { phrases: string[]; due: string | null; remindMinutes: number | null; durationMinutes: number | null; repeat?: PadAiRepeat | null };
export type PadAiParse = { title: string; due: string | null; remindMinutes: number | null; durationMinutes: number | null; marks: PadMark[]; repeat?: PadRepeat | null };

const MONTH_WORD = new RegExp(`\\b${MONTH}\\b`, "gi");
const WEEKDAY_WORD = new RegExp(`\\b${WEEKDAY_ANY}\\b`, "gi");
const TIME_WORD = /\b(?:morning|afternoon|evening|tonight|night|noon|midday|midnight|lunch\s*time|eod|eow|end\s+of\s+(?:the\s+)?(?:day|week)|o'?clock)\b/i;
const PHRASE_WORD = new RegExp(
  [
    `^${MONTH}$`,
    `^${WEEKDAY_ANY}s?$`,
    "^(?:today|tonight|tomorrow|tmrw|tmr|morning|afternoon|evening|night|noon|midday|midnight|lunchtime|lunch|eod|eow|cob|end|day|days|week|weeks|weekend|month|months|year|fortnight|hour|hours|hr|hrs|min|mins|minute|minutes|am|pm|a|an|and|the|of|on|at|by|in|next|this|coming|from|for|before|after|until|till|due|remind|reminder|me|half|quarter|past|to|first|thing|early|late|mid|start|o'clock|oclock|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|sixty|ninety)$",
    "^\\d{1,4}(?:st|nd|rd|th|am|pm|h|m|hrs?|mins?)?$",
    "^\\d{1,2}[:.]\\d{2}(?:am|pm)?$",
    "^\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?$",
    "^\\d{1,2}-\\d{1,2}(?:am|pm)?$",
  ].join("|"),
  "i",
);

function phraseWords(phrase: string) {
  return phrase
    .split(/[\s,]+/)
    .filter(Boolean)
    .every((word) => PHRASE_WORD.test(word.replace(/[.!?]+$/, "")));
}

function spacedPattern(words: string) {
  return words.split(/\s+/).filter(Boolean).map(escapeRegExp).join("\\s+");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const AI_DUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const AI_REACH_DAYS = 730;

const SPELLED: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  "forty-five": 45,
  fifty: 50,
  sixty: 60,
  ninety: 90,
};
const AI_NUM = `(?:\\d+|${Object.keys(SPELLED).join("|")})`;
const AI_SHORT_UNIT = "(?:min(?:ute)?s?|hours?|hrs?)";
const AI_UNIT = "(?:min(?:ute)?s?|hours?|hrs?|days?|weeks?)";
const AI_RANGE = "\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)?\\s*-\\s*(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)\\b";
const AI_CLOCK = `${AI_RANGE}|\\b\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm)\\b|\\b\\d{1,2}:\\d{2}\\b|\\b(?:noon|midday|midnight)\\b|\\bat\\s+\\d{1,2}(?::\\d{2})?\\b(?![.]\\d)|\\b\\d{1,2}\\s*o'?clock\\b`;
const AI_DAY_MONTH = `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`;
const AI_NUMERIC_DATE = "\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?\\b";
const AI_IN_UNITS = `\\bin\\s+${AI_NUM}\\s+${AI_UNIT}\\b`;
const AI_REMIND = `\\bremind(?:er)?(?:\\s+me)?\\s+${AI_NUM}\\s+${AI_UNIT}\\s+(?:before|early|ahead)\\b|\\b${AI_NUM}\\s+${AI_UNIT}\\s+(?:before|early|ahead)\\b|\\b${AI_NUM}[\\s-]+${AI_UNIT}\\s+reminder\\b`;
const AI_FOR = `\\bfor\\s+${AI_NUM}\\s+${AI_SHORT_UNIT}\\b`;
const AI_STRUCTURE = new RegExp([AI_CLOCK, AI_DAY_MONTH, AI_NUMERIC_DATE, AI_IN_UNITS, AI_REMIND, AI_FOR, "\\b20\\d\\d\\b"].join("|"), "gi");
const AI_ANCHOR = new RegExp(
  [
    `\\b${WEEKDAY_ANY}\\b`,
    "\\b(?:today|tomorrow|tmrw|tmr|tonight)\\b",
    AI_CLOCK,
    AI_DAY_MONTH,
    AI_NUMERIC_DATE,
    AI_IN_UNITS,
    "\\bnext\\s+(?:week|month)\\b",
    "\\bweekend\\b",
    "\\bend\\s+of\\s+(?:the\\s+)?(?:day|week)\\b",
    "\\beo[dw]\\b",
  ].join("|"),
  "i",
);
const AI_LOOSE = new RegExp(
  `\\d|\\b${MONTH}\\b|\\b(?:${Object.keys(SPELLED).filter((word) => word.length > 2).join("|")}|half|quarter|remind|reminder|me)\\b`,
  "i",
);

function phraseKind(phrase: string): "when" | "remind" | "length" | null {
  if (!phraseWords(phrase)) return null;
  if (/^in\s/i.test(phrase) && !new RegExp(`^${AI_IN_UNITS}`, "i").test(phrase)) return null;
  if (AI_LOOSE.test(phrase.replace(AI_STRUCTURE, " "))) return null;
  if (AI_ANCHOR.test(phrase)) return "when";
  if (new RegExp(AI_REMIND, "i").test(phrase)) return "remind";
  if (new RegExp(AI_FOR, "i").test(phrase)) return "length";
  return null;
}

function amountOf(word: string) {
  if (/^\d+$/.test(word)) return Number(word);
  return SPELLED[word.toLowerCase()] ?? null;
}

function unitMinutesOf(unit: string) {
  const key = unit.toLowerCase();
  if (key.startsWith("w")) return 7 * 24 * 60;
  if (key.startsWith("d")) return 24 * 60;
  if (key.startsWith("h")) return 60;
  return 1;
}

function hourFits(hour: number, said: string) {
  if (/\bmorning\b/i.test(said) && (hour < 5 || hour > 11)) return false;
  if (/\bafternoon\b/i.test(said) && (hour < 12 || hour > 17)) return false;
  if (/\bevening\b/i.test(said) && (hour < 17 || hour > 22)) return false;
  if (/\b(?:tonight|night)\b/i.test(said) && hour < 17) return false;
  return true;
}

function dueAgrees(said: string, day: Day, time: { hour: number; minute: number } | null, wall: ReturnType<typeof londonParts>, duration: number | null) {
  const today: Day = { year: wall.year, month: wall.month, day: wall.day };
  const ahead = Math.round((Date.UTC(day.year, day.month - 1, day.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000);
  const dated = new RegExp(`${AI_DAY_MONTH}|${AI_NUMERIC_DATE}|${AI_IN_UNITS}|\\bweek\\b`, "i").test(said);
  for (const word of said.match(WEEKDAY_WORD) ?? []) {
    if (weekdayIndex(word) !== weekday(day)) return false;
    if (!dated && ahead > (/\bnext\b/i.test(said) ? 13 : 7)) return false;
  }
  if (/\b(?:today|tonight)\b/i.test(said) && ahead !== 0) return false;
  if (/\b(?:tomorrow|tmrw|tmr)\b/i.test(said) && ahead !== 1) return false;
  if (/\bnext\s+week\b/i.test(said)) {
    const monday = addDays(today, ((1 - weekday(today) + 7) % 7) || 7);
    const offset = Math.round((Date.UTC(day.year, day.month - 1, day.day) - Date.UTC(monday.year, monday.month - 1, monday.day)) / 86_400_000);
    if (offset < 0 || offset > 6) return false;
  }
  for (const found of said.matchAll(/\b(20\d\d)\b/g)) if (Number(found[1]) !== day.year) return false;
  const explicitYear = /\b20\d\d\b/.test(said);
  const dayMonths = [
    ...[...said.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, "gi"))].map((found) => ({ day: Number(found[1]), month: monthIndex(found[2]) + 1 })),
    ...[...said.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"))].map((found) => ({ day: Number(found[2]), month: monthIndex(found[1]) + 1 })),
    ...[...said.matchAll(/\b(\d{1,2})\/(\d{1,2})\b(?!\/)/g)].map((found) => ({ day: Number(found[1]), month: Number(found[2]) })),
  ];
  for (const found of dayMonths) {
    if (found.day !== day.day || found.month !== day.month) return false;
    if (!explicitYear) {
      const thisYear = { year: today.year, month: found.month, day: found.day };
      const nearest = compare(thisYear, today) >= 0 ? today.year : today.year + 1;
      if (day.year !== nearest) return false;
    }
  }
  for (const found of said.matchAll(new RegExp(`\\bin\\s+(${AI_NUM})\\s+(${AI_UNIT})\\b`, "gi"))) {
    const amount = amountOf(found[1]);
    if (amount === null) return false;
    const minutes = amount * unitMinutesOf(found[2]);
    if (minutes >= 24 * 60) {
      if (ahead !== Math.round(minutes / (24 * 60))) return false;
    } else {
      if (!time) return false;
      const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) + minutes * 60_000;
      const got = Date.UTC(day.year, day.month - 1, day.day, time.hour, time.minute);
      if (Math.abs(got - target) > 60_000) return false;
    }
  }
  const range = new RegExp(AI_RANGE, "i").exec(said);
  if (range) {
    if (!time) return false;
    const startHour = Number(range[1]);
    const startMinute = Number(range[2] ?? 0);
    const options = range[3] ? [toHour(startHour, startMinute, range[3])] : [toHour(startHour, startMinute, "am"), toHour(startHour, startMinute, "pm")];
    if (!options.some((option) => option && option.hour === time.hour && option.minute === time.minute)) return false;
    const end = toHour(Number(range[4]), Number(range[5] ?? 0), range[6]);
    if (duration !== null && (!end || end.hour * 60 + end.minute - (time.hour * 60 + time.minute) !== duration)) return false;
  }
  const rest = said.replace(new RegExp(AI_RANGE, "gi"), " ");
  for (const found of rest.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b|\bat\s+(\d{1,2})(?::(\d{2}))?\b|\b(\d{1,2})\s*o'?clock\b/gi)) {
    if (!time) return false;
    if (found[1] !== undefined) {
      const wanted = toHour(Number(found[1]), Number(found[2] ?? 0), found[3]);
      if (!wanted || wanted.hour !== time.hour || wanted.minute !== time.minute) return false;
    } else {
      const hour = Number(found[4] ?? found[6] ?? found[8]);
      const minute = Number(found[5] ?? found[7] ?? 0);
      if (time.minute !== minute || (time.hour !== hour && time.hour !== hour + 12) || hour > 23) return false;
    }
  }
  if (/\bnoon\b|\bmidday\b/i.test(said) && (!time || time.hour !== 12 || time.minute !== 0)) return false;
  if (/\bmidnight\b/i.test(said) && (!time || time.hour !== 0 || time.minute !== 0)) return false;
  if (time && !hourFits(time.hour, said)) return false;
  const length = new RegExp(`\\bfor\\s+(${AI_NUM})\\s+(${AI_SHORT_UNIT})\\b`, "i").exec(said);
  if (length && duration !== null) {
    const amount = amountOf(length[1]);
    if (amount === null || amount * unitMinutesOf(length[2]) !== duration) return false;
  }
  return true;
}

export function acceptAiReading(typed: string, answer: PadAiAnswer, now = new Date()): PadAiParse {
  const text = typed.trim();
  const lead = typed.length - typed.trimStart().length;
  const kept: PadAiParse = { title: text, due: null, remindMinutes: null, durationMinutes: null, marks: [] };
  if (!answer.due) return kept;
  const spans: Span[] = [];
  const kinds: string[] = [];
  for (const raw of answer.phrases) {
    const phrase = raw.trim();
    const kind = phrase ? phraseKind(phrase) : null;
    if (!kind) return kept;
    const found = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${spacedPattern(phrase)}(?![\\p{L}\\p{N}])`, "gu"))];
    if (found.length !== 1) return kept;
    const start = found[0].index;
    const end = start + found[0][0].length;
    if ([...text.matchAll(DOC_REFERENCE)].some((doc) => start < doc.index + doc[0].length && end > doc.index)) return kept;
    const span: Span = { start, end, kind: kind === "remind" ? "reminder" : "when" };
    if (spans.some((other) => span.start < other.end && span.end > other.start)) return kept;
    spans.push(span);
    kinds.push(kind);
  }
  if (!kinds.includes("when") && !answer.repeat) return kept;
  const said = answer.phrases.join(" ");
  if ((said.match(MONTH_WORD) ?? []).length > 1 || (said.match(WEEKDAY_WORD) ?? []).length > 1) return kept;
  const match = AI_DUE.exec(answer.due);
  if (!match) return kept;
  const day: Day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (!valid(day)) return kept;
  const time = match[4] === undefined ? null : { hour: Number(match[4]), minute: Number(match[5]) };
  if (time && (time.hour > 23 || time.minute > 59 || wallTimeCount(day, time) !== 1)) return kept;
  if (time && !/\d/.test(said) && !TIME_WORD.test(said)) return kept;
  const wall = londonParts(now);
  const today: Day = { year: wall.year, month: wall.month, day: wall.day };
  if (compare(day, today) < 0 || compare(day, addDays(today, AI_REACH_DAYS)) > 0) return kept;
  if (time && compare(day, today) === 0 && (time.hour < wall.hour || (time.hour === wall.hour && time.minute < wall.minute))) return kept;
  const statesLength = new RegExp(AI_FOR, "i").test(said) || new RegExp(AI_RANGE, "i").test(said);
  const duration =
    statesLength && answer.durationMinutes !== null && Number.isInteger(answer.durationMinutes) && answer.durationMinutes > 0 && answer.durationMinutes <= MAX_TASK_DURATION
      ? answer.durationMinutes
      : null;
  if (!dueAgrees(said, day, time, wall, duration)) return kept;
  const repeated = answer.repeat ? acceptAiRepeat(text, answer.repeat, answer.due, now) : null;
  if (answer.repeat && (!repeated || spans.some((other) => repeated.span.start < other.end && repeated.span.end > other.start))) return kept;
  if (repeated) spans.push(repeated.span);
  const asksReminder = new RegExp(AI_REMIND, "i").test(said);
  const reminder =
    !asksReminder || answer.remindMinutes === null || !Number.isFinite(answer.remindMinutes) || answer.remindMinutes < 0 ? null : nearestReminder(answer.remindMinutes);
  const glued = withGlue(text, spans);
  const title = cleanTitle(text, glued);
  if (!title || debris(text, spans, true)) return kept;
  return {
    title,
    due: answer.due,
    remindMinutes: reminder,
    durationMinutes: time ? duration : null,
    ...(repeated ? { repeat: repeated.repeat } : {}),
    marks: glued.map((span) => ({ start: span.start + lead, end: span.end + lead, kind: span.kind === "reminder" ? ("reminder" as const) : ("when" as const) })),
  };
}

export function confirmedReading(parsed: Pick<PadParse, "title" | "due" | "remindMinutes" | "durationMinutes" | "unsure" | "marks" | "repeat">, ai: PadAiParse | null): PadAiParse {
  if (ai) return ai;
  if (parsed.unsure) return { title: parsed.title, due: null, remindMinutes: null, durationMinutes: null, marks: [] };
  return {
    title: parsed.title,
    due: parsed.due,
    remindMinutes: parsed.remindMinutes,
    durationMinutes: parsed.durationMinutes,
    marks: parsed.due ? parsed.marks.filter((mark) => mark.kind === "when" || mark.kind === "reminder") : [],
    ...(parsed.due && parsed.repeat ? { repeat: parsed.repeat } : {}),
  };
}

function coreWords(piece: string) {
  return typedTitle(piece)
    .replace(/^(?:[,;:\-–—]\s*|and\s+)+/i, "")
    .replace(/(?:\s*[,;:.!…\-–—]|\s+and)+$/i, "");
}

export function readPhrase(text: string, marks: PadMark[]) {
  return coreWords(marks.map((mark) => text.slice(mark.start, mark.end).trim()).filter(Boolean).join(" "));
}

export function readingKey(text: string, marks: PadMark[]) {
  return marks.map((mark) => `${mark.kind}:${coreWords(text.slice(mark.start, mark.end))}`).join("\u0000");
}

export type KeptReading = { key: string; words: string[] };

export function keptReading(text: string, marks: PadMark[]): KeptReading {
  return { key: readingKey(text, marks), words: marks.map((mark) => coreWords(text.slice(mark.start, mark.end))).filter(Boolean) };
}

function wordsAt(text: string, words: string[]) {
  const found: { start: number; end: number }[] = [];
  let from = 0;
  for (const word of words) {
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${spacedPattern(word)}(?![\\p{L}\\p{N}])`, "u").exec(text.slice(from));
    if (!match) return null;
    found.push({ start: from + match.index, end: from + match.index + match[0].length });
    from += match.index + match[0].length;
  }
  return found;
}

export function keptAfterTyping(kept: readonly KeptReading[], text: string, produced: Pick<PadReading, "key" | "marks">): KeptReading[] {
  return kept.filter((entry) => {
    const at = wordsAt(text, entry.words);
    if (!at) return false;
    if (!produced.key || produced.key === entry.key) return true;
    return !produced.marks.some((mark) => at.some((word) => mark.start < word.end && mark.end > word.start));
  });
}

export type PadReading = PadAiParse & { phrase: string; key: string };

export function padReading(
  text: string,
  parsed: Pick<PadParse, "title" | "due" | "remindMinutes" | "durationMinutes" | "unsure" | "marks" | "repeat">,
  ai: PadAiParse | null,
  keptAsText: readonly string[],
): PadReading {
  const reading = confirmedReading(parsed, ai);
  const phrase = readPhrase(text, reading.marks);
  if (!reading.due || !phrase) return { title: typedTitle(text), due: null, remindMinutes: null, durationMinutes: null, marks: [], phrase: "", key: "" };
  const key = readingKey(text, reading.marks);
  if (keptAsText.includes(key)) return { title: typedTitle(text), due: null, remindMinutes: null, durationMinutes: null, marks: [], phrase: "", key: "" };
  return { ...reading, phrase, key };
}

export const AI_SETTLE_MS = 300;

export function readingToSave<T>(shown: T, asTyped: T, ai: { shownAt: number | null } | null, now = Date.now()): T {
  if (!ai) return shown;
  return ai.shownAt !== null && now - ai.shownAt >= AI_SETTLE_MS ? shown : asTyped;
}

export function backspaceKeeps(marks: PadMark[], caret: number, selectionEnd: number) {
  return caret === selectionEnd && marks.some((mark) => (mark.kind === "when" || mark.kind === "reminder") && mark.end === caret);
}

export function stripMention(text: string, caret: number) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/\s{2,}|\n/.test(query) || query.length > 40) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  return { start: at, end: caret, query };
}

export type DocQuery = { start: number; end: number; query: string };

export function docQueryAt(text: string, caret: number): DocQuery | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf("[[");
  if (open < 0) return null;
  const closed = /^[^[\]\n]*(?=\]\])/.exec(text.slice(caret))?.[0];
  const rest = closed ?? /^[^\s\]]*/.exec(text.slice(caret))?.[0] ?? "";
  const query = before.slice(open + 2) + rest;
  if (/[\]\n]/.test(query) || query.length > 80) return null;
  return { start: open, end: caret + rest.length, query };
}

export function withoutDocQuery(text: string, found: Pick<DocQuery, "start" | "end">) {
  const before = text.slice(0, found.start).replace(/\s+$/, "");
  const after = text.slice(found.end).replace(/^\]\]/, "").replace(/^\s+/, "");
  if (!after) {
    const next = before ? `${before} ` : "";
    return { text: next, caret: next.length };
  }
  const next = before ? `${before} ${after}` : after;
  return { text: next, caret: before ? before.length + 1 : 0 };
}

const APOSTROPHES = /['\u2019\u2018\u02bc\u201b]/g;

export function straightQuotes(value: string) {
  return value.replace(APOSTROPHES, "'");
}

export function namePattern(name: string) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(APOSTROPHES, "['\u2019\u2018\u02bc\u201b]");
}

export function nameMarks(text: string, names: string[], kind: "record" | "ask" = "record"): PadMark[] {
  const marks: PadMark[] = [];
  for (const name of names) {
    const clean = name.trim();
    if (clean.length < 2) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${namePattern(clean)})(?=$|[^\\p{L}\\p{N}])`, "giu");
    for (const match of text.matchAll(pattern)) {
      const start = (match.index ?? 0) + match[1].length;
      marks.push({ start, end: start + match[2].length, kind });
    }
  }
  return marks;
}

export function mergeMarks(marks: PadMark[]) {
  const sorted = [...marks].sort((a, b) => a.start - b.start || b.end - a.end);
  const result: PadMark[] = [];
  for (const mark of sorted) {
    if (result.length && mark.start < result[result.length - 1].end) continue;
    result.push(mark);
  }
  return result;
}

type PadRef = { id: string; name: string };
type PadPerson = PadRef & { company: PadRef | null };
type PadChoice = { id: string; name: string; detail: string | null; company: PadRef | null };
export type PadPick<T> = { set: boolean; value: T; side?: boolean };
type PadFound = {
  company: PadRef | null;
  contact: PadPerson | null;
  opportunity: (PadRef & { companyId: string }) | null;
  ask: { word: string; candidates: PadChoice[] } | null;
};
export type PadLinks = {
  contact: PadPerson | null;
  company: PadRef | null;
  opportunity: PadRef | null;
  ask: { word: string; candidates: PadChoice[] } | null;
  fromText: boolean;
  personOnlyCompany: boolean;
};

type PadState = {
  text: string;
  found: PadFound | null;
  fixedCompany: PadRef | null;
  contact: PadPick<PadPerson | null>;
  company: PadPick<PadRef | null>;
  opportunity: PadPick<PadRef | null>;
  dismissed: string[];
};

export function padRelease<T>(pick: PadPick<T>): PadPick<T> {
  return pick.side ? { set: false, value: undefined as T } : pick;
}

export function padAnchor(state: Pick<PadState, "fixedCompany" | "company">) {
  return state.fixedCompany ?? (state.company.set ? state.company.value : null);
}

export function padFits(anchor: PadRef | null, record: { company: PadRef | null } | null | undefined) {
  return !anchor || !record?.company || record.company.id === anchor.id;
}

export function resolvePadLinks(state: PadState): PadLinks {
  const { found } = state;
  const anchor = padAnchor(state);
  const fromText = !state.contact.set && Boolean(found?.contact) && padFits(anchor, found?.contact);
  const person = state.contact.set ? state.contact.value : fromText && found?.contact ? found.contact : null;
  const named = Boolean(found?.company && nameMarks(state.text, [found.company.name]).length > 0);
  const viaDeal = Boolean(found?.company && found.opportunity?.companyId === found.company.id);
  const personOnlyCompany = Boolean(found?.company && found.contact?.company?.id === found.company.id && !named && !viaDeal);
  const auto = fromText
    ? (found?.company ?? found?.contact?.company ?? null)
    : found?.company && !personOnlyCompany
      ? found.company
      : (person?.company ?? null);
  const pinned = state.contact.set ? (state.contact.value?.company ?? null) : null;
  const company = state.fixedCompany ?? (state.company.set ? state.company.value : (pinned ?? auto));
  const spotted = found?.opportunity && company && company.id === found.opportunity.companyId ? found.opportunity : null;
  const opportunity = state.opportunity.set ? state.opportunity.value : spotted;
  const choices = found?.ask ? found.ask.candidates.filter((choice) => padFits(anchor, choice)) : [];
  const ask =
    !state.contact.set && !person && found?.ask && !state.dismissed.includes(found.ask.word) && choices.length > 0
      ? { word: found.ask.word, candidates: choices }
      : null;
  return { contact: person, company, opportunity, ask, fromText, personOnlyCompany };
}

type SaveIds = { companyId?: string | null; contactId?: string | null; opportunityId?: string | null };

export function padSaveIds(
  links: Pick<PadLinks, "contact" | "company" | "opportunity"> | null,
  state: Pick<PadState, "fixedCompany" | "contact" | "company" | "opportunity">,
): SaveIds {
  const hand = <T extends PadRef>(pick: PadPick<T | null>) => (pick.set ? (pick.value?.id ?? null) : undefined);
  const ids: SaveIds = links
    ? {
        companyId: links.company?.id ?? hand(state.company),
        contactId: links.contact?.id ?? hand(state.contact),
        opportunityId: links.opportunity?.id ?? hand(state.opportunity),
      }
    : {
        companyId: state.fixedCompany?.id ?? hand(state.company),
        contactId: hand(state.contact),
        opportunityId: hand(state.opportunity),
      };
  return Object.fromEntries(Object.entries(ids).filter(([, value]) => value !== undefined));
}

type ShownLinks = { contactId: string | null; companyId: string | null; ask: string | null };

export function padNeedsConfirm(shown: ShownLinks, fresh: ShownLinks & { contactByName: boolean; companyOneWord: boolean }) {
  if (fresh.ask && fresh.ask !== shown.ask) return true;
  if (fresh.contactId && fresh.contactId !== shown.contactId && fresh.contactByName) return true;
  return Boolean(fresh.companyId && fresh.companyId !== shown.companyId && fresh.companyOneWord);
}

type ConfirmInput = {
  contact: { name: string; company: { name: string } | null } | null;
  contactTitle: string | null;
  company: { name: string } | null;
  companyDomain: string | null;
  matchedBy: "full" | "name" | null;
  word: string | null;
};

export function padConfirmLine(found: ConfirmInput) {
  const only = found.word ? ` is the only ${found.word}` : "";
  if (found.contact) {
    const company = found.contact.company?.name || null;
    const title = found.contactTitle?.trim() || null;
    const role = title ? (company ? `${title} at ${company}` : title) : null;
    const lead = role ? `${found.contact.name}, ${role}` : company ? `${found.contact.name} at ${company}` : found.contact.name;
    if (found.matchedBy !== "name" || !only) return lead;
    return role ? `${lead},${only}` : `${lead}${only}`;
  }
  if (!found.company) return null;
  const lead = found.companyDomain ? `${found.company.name} (${found.companyDomain})` : found.company.name;
  return `${lead}${only}`;
}

const SHORT_DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function padDueHasTime(due: string | null | undefined) {
  return Boolean(due && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(due));
}

type LinkedTask = {
  companyId: string | null;
  contactId: string | null;
  contactCompanyId?: string | null;
  contactName?: string | null;
  opportunityId: string | null;
  opportunityName?: string | null;
};
type LinkPick = { id: string; company?: PadRef | null } | null;
type Relink = { companyId?: string | null; contactId?: string | null; opportunityId?: string | null };

export function relinkChange(task: LinkedTask, kind: "company" | "contact" | "opportunity", option: LinkPick): Relink {
  const contactCompany = task.contactId ? (task.contactCompanyId === undefined ? task.companyId : task.contactCompanyId) : null;
  if (kind === "company") {
    const companyId = option?.id ?? null;
    if (!companyId || companyId === task.companyId) return { companyId };
    return {
      companyId,
      ...(task.opportunityId ? { opportunityId: null } : {}),
      ...(contactCompany && contactCompany !== companyId ? { contactId: null } : {}),
    };
  }
  if (!option) return kind === "contact" ? { contactId: null } : { opportunityId: null };
  const companyId = option.company?.id;
  const moves = Boolean(companyId && companyId !== task.companyId);
  if (kind === "contact") {
    return { contactId: option.id, ...(companyId ? { companyId } : {}), ...(moves && task.opportunityId ? { opportunityId: null } : {}) };
  }
  return {
    opportunityId: option.id,
    ...(companyId ? { companyId } : {}),
    ...(contactCompany && companyId && contactCompany !== companyId ? { contactId: null } : {}),
  };
}

export function relinkNote(task: LinkedTask, kind: "company" | "contact" | "opportunity", change: Relink) {
  const names = [
    kind !== "contact" && change.contactId === null && task.contactId ? (task.contactName ?? "the person") : null,
    kind !== "opportunity" && change.opportunityId === null && task.opportunityId ? (task.opportunityName ?? "the opportunity") : null,
  ].filter((name): name is string => Boolean(name));
  if (names.length === 0) return null;
  return `Removed ${names.join(" and ")}. ${names.length === 1 ? "It belongs" : "They belong"} to another company.`;
}

export function ownerSetsTime(viewerId: string | null | undefined, ownerId: string | null | undefined) {
  return Boolean(viewerId && ownerId && ownerId !== viewerId);
}

export function ownerTimeLine(ownerName: string | null | undefined) {
  return `Only ${ownerName?.trim().split(/\s+/)[0] || "the assignee"} can set a time.`;
}

export function dayOnlyHint(ownerName: string | null | undefined) {
  return `${ownerTimeLine(ownerName).slice(0, -1)}, so this saves the day only.`;
}

export function dayOnlyNote(ownerName: string | null | undefined) {
  return `Saved the day only. ${ownerTimeLine(ownerName)}`;
}

export function movedMessage(
  task: { dueHasTime: boolean; ownerName: string | null },
  at: string,
  saved: { dueAt: string | null; dueHasTime: boolean } | undefined,
  now: number,
) {
  const timed = saved ? saved.dueHasTime : task.dueHasTime;
  const when = snoozeDetail(saved?.dueAt ? new Date(saved.dueAt) : onWorkingDay(new Date(at)), timed, now);
  return task.dueHasTime && !timed ? `Due ${when}. ${ownerTimeLine(task.ownerName)}` : `Due ${when}.`;
}

export function reminderClock(due: string, minutes: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(due);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute) - minutes * 60_000);
  const clock = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
  if (at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day) return clock;
  const parts = SHORT_DAY.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}, ${clock}`;
}
