import { londonParts, parseTaskText } from "@/lib/task-pad";

export type PadActivityType = "call" | "email" | "meeting" | "note";

export type ActivityMark = { start: number; end: number; kind: "type" | "when" | "followup" };

export type ActivityParse = {
  type: PadActivityType;
  typeFound: boolean;
  when: string | null;
  followUp: { due: string } | null;
  marks: ActivityMark[];
};

const TYPE_PATTERNS: { type: PadActivityType; pattern: RegExp }[] = [
  { type: "call", pattern: /\b(called|rang|phoned|phone call|had a call|on a call|quick call|call with|spoke (?:to|with))\b/i },
  { type: "email", pattern: /\b(emailed|e-mailed|sent (?:an? )?(?:email|e-mail)|email(?:ed)? (?:to|from)|replied to|got an email)\b/i },
  { type: "meeting", pattern: /\b(met|meeting|met with|catch[- ]?up|coffee with|lunch with|dinner with|demo(?:ed)? (?:to|with)|workshop|visited|video call|teams call|zoom)\b/i },
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)";
const FOLLOW_WHEN =
  "((?:next\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|end of (?:the )?(?:day|week|month)|eod|eow|next week|next month|in \\d+ (?:days?|weeks?)|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\s+\\d{1,2}(?:st|nd|rd|th)?)";
const FOLLOW_PATTERN = new RegExp(
  `\\b(?:by|before|due|follow(?:ing)?[- ]?up(?:\\s+(?:on|with \\S+))?|chase(?:\\s+(?:up|her|him|them))?|get back to (?:her|him|them)|send (?:it|them|that)?)\\s+${FOLLOW_WHEN}\\b`,
  "i",
);

type Day = { year: number; month: number; day: number };

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function shift(day: Day, days: number): Day {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayOf(day: Day) {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

function weekdayIndex(word: string) {
  const lower = word.toLowerCase();
  return WEEKDAYS.findIndex((name) => name.startsWith(lower.slice(0, 3)));
}

function overlaps(marks: ActivityMark[], start: number, end: number) {
  return marks.some((mark) => start < mark.end && end > mark.start);
}

export function parseActivityText(text: string, now = new Date()): ActivityParse {
  const marks: ActivityMark[] = [];
  const wall = londonParts(now);
  const today: Day = { year: wall.year, month: wall.month, day: wall.day };

  let followUp: ActivityParse["followUp"] = null;
  const follow = FOLLOW_PATTERN.exec(text);
  if (follow) {
    const due = parseTaskText(follow[1], now).due;
    if (due) {
      followUp = { due };
      marks.push({ start: follow.index, end: follow.index + follow[0].length, kind: "followup" });
    }
  }

  let type: PadActivityType = "note";
  let typeFound = false;
  let earliest = Number.POSITIVE_INFINITY;
  for (const candidate of TYPE_PATTERNS) {
    const match = candidate.pattern.exec(text);
    if (match && match.index < earliest && !overlaps(marks, match.index, match.index + match[0].length)) {
      earliest = match.index;
      type = candidate.type;
      typeFound = true;
      marks.push({ start: match.index, end: match.index + match[0].length, kind: "type" });
    }
  }
  const typeMarks = marks.filter((mark) => mark.kind === "type");
  if (typeMarks.length > 1) {
    const keep = typeMarks.reduce((first, mark) => (mark.start < first.start ? mark : first));
    for (const mark of typeMarks) if (mark !== keep) marks.splice(marks.indexOf(mark), 1);
  }

  let date: Day | null = null;
  let time: { hour: number; minute: number } | null = null;
  const take = (pattern: RegExp, handle: (match: RegExpExecArray) => boolean | void) => {
    const global = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
    for (let match = global.exec(text); match; match = global.exec(text)) {
      if (overlaps(marks, match.index, match.index + match[0].length)) continue;
      if (handle(match) === false) continue;
      marks.push({ start: match.index, end: match.index + match[0].length, kind: "when" });
      return;
    }
  };

  take(/\byesterday(?:\s+(morning|afternoon|evening|night))?\b/i, (match) => {
    date = shift(today, -1);
    if (match[1]) time = partOfDay(match[1]);
  });
  if (!date) {
    take(/\b(?:this|earlier this)\s+(morning|afternoon|evening)\b/i, (match) => {
      date = today;
      time = partOfDay(match[1]);
    });
  }
  if (!date) {
    take(new RegExp(`\\b(?:on|last)\\s+${WEEKDAY}\\b`, "i"), (match) => {
      const target = weekdayIndex(match[1]);
      if (target < 0) return false;
      const back = (weekdayOf(today) - target + 7) % 7 || (/^last/i.test(match[0]) ? 7 : 0);
      date = shift(today, -back);
    });
  }
  if (!date) {
    take(/\b(\d{1,2}) days? ago\b/i, (match) => {
      date = shift(today, -Number(match[1]));
    });
  }
  if (!date) {
    take(/\blast week\b/i, () => {
      date = shift(today, -7);
    });
  }
  if (!date) take(/\b(?:earlier )?today\b/i, () => {
    date = today;
  });
  take(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b|\b(?:at\s+)?(\d{1,2})[:.](\d{2})\b/i, (match) => {
    let hour = Number(match[1] ?? match[4]);
    const minute = Number(match[2] ?? match[5] ?? 0);
    const meridiem = match[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return false;
    time = { hour, minute };
  });

  let when: string | null = null;
  const chosenDate = date as Day | null;
  const chosenTime = time as { hour: number; minute: number } | null;
  if (chosenDate || chosenTime) {
    const day = chosenDate ?? today;
    const clock = chosenTime ?? (chosenDate && (chosenDate.year !== today.year || chosenDate.month !== today.month || chosenDate.day !== today.day) ? { hour: 12, minute: 0 } : { hour: wall.hour, minute: wall.minute });
    when = `${day.year}-${pad(day.month)}-${pad(day.day)}T${pad(clock.hour)}:${pad(clock.minute)}`;
  }

  return { type, typeFound, when, followUp, marks: marks.sort((left, right) => left.start - right.start) };
}

function partOfDay(word: string) {
  const lower = word.toLowerCase();
  if (lower === "morning") return { hour: 9, minute: 30 };
  if (lower === "afternoon") return { hour: 14, minute: 0 };
  return { hour: 18, minute: 0 };
}

export function activityHeadline(text: string, max = 120) {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  const base = sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
  return base.replace(/[.!?]$/, "");
}
