import { REMINDER_MINUTES } from "@/lib/crm/reminder-options";

export type PadMark = { start: number; end: number; kind: "when" | "reminder" | "record" };

export type PadParse = {
  title: string;
  due: string | null;
  remindMinutes: number | null;
  unsure: boolean;
  marks: PadMark[];
};

type Day = { year: number; month: number; day: number };
type Span = { start: number; end: number; kind: "when" | "reminder" };

const DEFAULT_HOUR = 9;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAY = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri)";
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, thirty: 30 };
const LEAD = "(?:\\b(?:on|by|due|for|at|this)\\s+)?";

const TEMPORAL =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri)\b|\b(january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)\b|\b(today|tomorrow|tonight|morning|afternoon|evening|noon|midday|week|weekend|month|fortnight|remind|reminder|after next|fortnight)\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}(st|nd|rd|th)\b/i;

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
  if (m === "pm" && h < 12) h += 12;
  if (m === "am" && h === 12) h = 0;
  if (h > 23 || minute > 59) return null;
  return { hour: h, minute };
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

function cleanTitle(text: string, spans: Span[]) {
  let result = "";
  let last = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start < last) continue;
    result += `${text.slice(last, span.start)} `;
    last = span.end;
  }
  result += text.slice(last);
  let title = result
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[,;:]\s*(?=[,;:.]|$)/g, "")
    .trim();
  for (let index = 0; index < 3; index += 1) {
    title = title
      .replace(/(?:^|\s)(?:on|at|by|due|for|and|this|,)\s*$/i, "")
      .replace(/^(?:and|,)\s+/i, "")
      .replace(/[\s,;:-]+$/, "")
      .trim();
  }
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "";
}

export function parseTaskText(text: string, now = new Date()): PadParse {
  const spans: Span[] = [];
  const wall = londonParts(now);
  const today: Day = { year: wall.year, month: wall.month, day: wall.day };
  const found: {
    date: Day | null;
    time: { hour: number; minute: number } | null;
    exact: number | null;
    remind: number | null;
  } = { date: null, time: null, exact: null, remind: null };

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
    found.date = !explicitYear && compare(candidate, today) < 0 ? { ...candidate, year: candidate.year + 1 } : candidate;
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
    if (minutes >= 24 * 60) found.date = addDays(today, Math.round(minutes / (24 * 60)));
    else found.exact = minutes;
  });
  take(new RegExp(`${LEAD}\\b(?:the\\s+)?day\\s+after\\s+tomorrow\\b`, "i"), () => {
    found.date = addDays(today, 2);
  });
  take(new RegExp(`${LEAD}\\b(today|tonight|tomorrow|tmrw|tmr)\\b`, "i"), (match) => {
    const word = match[1].toLowerCase();
    found.date = word === "today" || word === "tonight" ? today : addDays(today, 1);
    if (word === "tonight") found.time = found.time ?? { hour: 19, minute: 0 };
  });
  take(new RegExp(`${LEAD}\\b(?:end\\s+of\\s+(?:the\\s+)?week|eow)\\b`, "i"), () => {
    found.date = addDays(today, (5 - weekday(today) + 7) % 7);
    found.time = found.time ?? { hour: 17, minute: 0 };
  });
  take(new RegExp(`${LEAD}\\bnext\\s+week\\b`, "i"), () => {
    found.date = addDays(today, ((1 - weekday(today) + 7) % 7) || 7);
  });
  take(new RegExp(`${LEAD}\\b(?:this\\s+)?weekend\\b`, "i"), () => {
    found.date = addDays(today, ((6 - weekday(today) + 7) % 7) || 7);
  });
  take(new RegExp(`${LEAD}\\bnext\\s+month\\b`, "i"), () => {
    found.date = { year: today.month === 12 ? today.year + 1 : today.year, month: today.month === 12 ? 1 : today.month + 1, day: 1 };
  });
  take(new RegExp(`${LEAD}\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}\\b(?:\\s+(\\d{4}))?`, "i"), (match) =>
    setDate({ year: match[3] ? Number(match[3]) : today.year, month: monthIndex(match[2]) + 1, day: Number(match[1]) }, Boolean(match[3])),
  );
  take(new RegExp(`${LEAD}\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "i"), (match) =>
    setDate({ year: match[3] ? Number(match[3]) : today.year, month: monthIndex(match[1]) + 1, day: Number(match[2]) }, Boolean(match[3])),
  );
  take(new RegExp(`${LEAD}\\b(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?\\b`, "i"), (match) => {
    const year = match[3] ? (match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])) : today.year;
    return setDate({ year, month: Number(match[2]), day: Number(match[1]) }, Boolean(match[3]));
  });
  take(new RegExp(`${LEAD}\\b(?:(next|this|coming)\\s+)?${WEEKDAY}\\b`, "i"), (match) => {
    const target = weekdayIndex(match[2]);
    if (target < 0) return false;
    found.date = addDays(today, ((target - weekday(today) + 7) % 7) || 7);
  });
  take(/\b(?:at\s+)?(\d{1,2})(?::|\.)(\d{2})(?:\s*(am|pm))?\b/i, (match) => {
    const parsed = toHour(Number(match[1]), Number(match[2]), match[3]);
    if (!parsed) return false;
    found.time = parsed;
  });
  take(/\b(?:at\s+)?(\d{1,2})\s*(am|pm)\b/i, (match) => {
    const parsed = toHour(Number(match[1]), 0, match[2]);
    if (!parsed) return false;
    found.time = parsed;
  });
  take(/\b(?:at\s+)?(noon|midday|midnight)\b/i, (match) => {
    found.time = match[1].toLowerCase() === "midnight" ? { hour: 0, minute: 0 } : { hour: 12, minute: 0 };
  });
  take(/\b(?:in\s+the\s+|this\s+)?(morning|afternoon|evening)\b/i, (match) => {
    if (found.time) return false;
    const key = match[1].toLowerCase();
    found.time = key === "morning" ? { hour: 9, minute: 0 } : key === "afternoon" ? { hour: 14, minute: 0 } : { hour: 18, minute: 0 };
  });
  take(/\b(?:by\s+)?(?:eod|end\s+of\s+(?:the\s+)?day)\b/i, () => {
    found.date = found.date ?? today;
    found.time = found.time ?? { hour: 17, minute: 0 };
  });

  let due: string | null = null;
  if (found.exact !== null) {
    const parts = londonParts(new Date(now.getTime() + found.exact * 60_000));
    due = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
  } else if (found.date || found.time) {
    const time = found.time ?? { hour: DEFAULT_HOUR, minute: 0 };
    let day = found.date ?? today;
    if (!found.date && (time.hour < wall.hour || (time.hour === wall.hour && time.minute <= wall.minute))) {
      day = addDays(today, 1);
    }
    due = `${day.year}-${pad(day.month)}-${pad(day.day)}T${pad(time.hour)}:${pad(time.minute)}`;
  }

  const title = cleanTitle(text, spans);
  const marks = spans
    .filter((span) => span.kind === "when" || due)
    .map((span) => {
      const lead = /^[\s,;]*(?:(?:and|on|by|due|for|at|this)\s+)?/i.exec(text.slice(span.start, span.end))?.[0].length ?? 0;
      const tail = /\s*$/.exec(text.slice(span.start, span.end))?.[0].length ?? 0;
      return { start: span.start + lead, end: span.end - tail, kind: span.kind } as PadMark;
    })
    .filter((mark) => mark.end > mark.start)
    .sort((a, b) => a.start - b.start);
  return { title, due, remindMinutes: due ? found.remind : null, unsure: TEMPORAL.test(title), marks };
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

export function nameMarks(text: string, names: string[]): PadMark[] {
  const marks: PadMark[] = [];
  for (const name of names) {
    const clean = name.trim();
    if (clean.length < 2) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^\\p{L}\\p{N}])`, "giu");
    for (const match of text.matchAll(pattern)) {
      const start = (match.index ?? 0) + match[1].length;
      marks.push({ start, end: start + match[2].length, kind: "record" });
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
