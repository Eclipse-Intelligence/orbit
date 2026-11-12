import { companyHref, contactHref, dealHref } from "@/lib/crm/hrefs";
import type { Task } from "@/lib/crm/types";

export type TitleColleague = { id: string; name: string };

export type TitleTarget =
  | { kind: "contact" | "company" | "opportunity"; id: string; href: string; name: string }
  | { kind: "colleague"; id: string; name: string };

export type TitleSegment = { text: string; target: TitleTarget | null };

type Term = { text: string; target: TitleTarget; partial: boolean; rank: number };

type TitleTask = Pick<
  Task,
  "title" | "companyId" | "companyName" | "contactId" | "contactName" | "contactFirstName" | "contactLastName" | "opportunityId" | "opportunityName"
>;

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clean(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function firstWord(value: string) {
  return clean(value).split(" ")[0] ?? "";
}

function termsFor(task: TitleTask, colleagues: TitleColleague[], viewerId: string | null): Term[] {
  const terms: Term[] = [];
  const add = (text: string, target: TitleTarget, partial: boolean, rank: number) => {
    const value = clean(text);
    if (value.length < 2) return;
    terms.push({ text: value, target, partial, rank });
  };
  if (task.contactId && task.contactName) {
    const target: TitleTarget = { kind: "contact", id: task.contactId, href: contactHref(task.contactId), name: task.contactName };
    add(task.contactName, target, false, 0);
    if (task.contactFirstName && task.contactLastName) {
      add(`${task.contactFirstName} ${task.contactLastName}`, target, false, 0);
      add(task.contactFirstName, target, true, 0);
      add(task.contactLastName, target, true, 0);
    }
  }
  if (task.companyId && task.companyName) {
    add(task.companyName, { kind: "company", id: task.companyId, href: companyHref(task.companyId), name: task.companyName }, false, 0);
  }
  if (task.opportunityId && task.opportunityName) {
    add(task.opportunityName, { kind: "opportunity", id: task.opportunityId, href: dealHref(task.opportunityId), name: task.opportunityName }, false, 0);
  }
  const firsts = new Map<string, number>();
  for (const colleague of colleagues) {
    const first = firstWord(colleague.name).toLocaleLowerCase("en-GB");
    firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  for (const colleague of colleagues) {
    if (colleague.id === viewerId) continue;
    const target: TitleTarget = { kind: "colleague", id: colleague.id, name: colleague.name };
    add(colleague.name, target, false, 1);
    const first = firstWord(colleague.name);
    if (first !== clean(colleague.name) && firsts.get(first.toLocaleLowerCase("en-GB")) === 1) add(first, target, true, 1);
  }
  return terms;
}

const CALENDAR_WORDS = /^\s+(Mon(day)?|Tue(s|sday)?|Wed(nesday)?|Thu(rs|rsday)?|Fri(day)?|Sat(urday)?|Sun(day)?|Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|June?|July?|Aug(ust)?|Sep(t|tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?|Today|Tomorrow|Tonight|Next|This|Q[1-4])\b/;

function surnameFollows(rest: string) {
  return /^\s+\p{Lu}/u.test(rest) && !CALENDAR_WORDS.test(rest);
}

function startsUpper(value: string) {
  const first = value.charAt(0);
  return first !== first.toLocaleLowerCase("en-GB");
}

export type TitleHere = { kind: "contact" | "company" | "opportunity"; id: string };

export function taskTitleSegments(task: TitleTask, colleagues: TitleColleague[] = [], viewerId: string | null = null, here: TitleHere | null = null): TitleSegment[] {
  const title = task.title;
  const hits: { start: number; end: number; target: TitleTarget; rank: number }[] = [];
  for (const term of termsFor(task, colleagues, viewerId)) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}-])(${escape(term.text)})(?=$|[^\\p{L}\\p{N}-])`, "giu");
    for (const match of title.matchAll(pattern)) {
      const start = (match.index ?? 0) + match[1].length;
      const text = match[2];
      if (term.partial && !startsUpper(text)) continue;
      if (term.partial && term.target.kind === "colleague" && surnameFollows(title.slice(start + text.length))) continue;
      if (here && term.target.kind === here.kind && term.target.id === here.id) continue;
      hits.push({ start, end: start + text.length, target: term.target, rank: term.rank });
    }
  }
  hits.sort((left, right) => left.start - right.start || right.end - right.start - (left.end - left.start) || left.rank - right.rank);
  const chosen: typeof hits = [];
  for (const hit of hits) {
    const last = chosen[chosen.length - 1];
    if (last && hit.start < last.end) continue;
    chosen.push(hit);
  }
  const segments: TitleSegment[] = [];
  let at = 0;
  for (const hit of chosen) {
    if (hit.start > at) segments.push({ text: title.slice(at, hit.start), target: null });
    segments.push({ text: title.slice(hit.start, hit.end), target: hit.target });
    at = hit.end;
  }
  if (at < title.length) segments.push({ text: title.slice(at), target: null });
  return segments;
}
