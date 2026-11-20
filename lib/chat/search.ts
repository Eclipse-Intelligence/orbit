import type { ChatFormat } from "@/lib/chat/markdown";
import { CHAT_SEARCH_MIN, CHAT_SEARCH_TEXT_MAX, type ChatSearchQuery } from "@/lib/chat/types";
import { plainMentions } from "@/lib/mentions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW = 200;
const LEAD = 60;
const SNAP = 20;

export const EMPTY_SEARCH: ChatSearchQuery = { q: "", in: null, from: null, file: false, after: null, before: null };

export function searchLength(text: string) {
  return Array.from(text.trim()).length;
}

export function searchReady(text: string) {
  return searchLength(text) >= CHAT_SEARCH_MIN;
}

function idValue(value: string | null) {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

function dayValue(value: string | null) {
  return value && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}

export function readSearchQuery(params: URLSearchParams): ChatSearchQuery {
  return {
    q: (params.get("q") ?? "").slice(0, CHAT_SEARCH_TEXT_MAX),
    in: idValue(params.get("in")),
    from: idValue(params.get("from")),
    file: params.get("file") === "1",
    after: dayValue(params.get("after")),
    before: dayValue(params.get("before")),
  };
}

export function writeSearchQuery(query: ChatSearchQuery, params = new URLSearchParams()) {
  if (query.q) params.set("q", query.q);
  if (query.in) params.set("in", query.in);
  if (query.from) params.set("from", query.from);
  if (query.file) params.set("file", "1");
  if (query.after) params.set("after", query.after);
  if (query.before) params.set("before", query.before);
  return params;
}

export function sameSearch(left: ChatSearchQuery, right: ChatSearchQuery) {
  return left.q === right.q && left.in === right.in && left.from === right.from && left.file === right.file && left.after === right.after && left.before === right.before;
}

export function searchFilterCount(query: ChatSearchQuery) {
  return [query.in, query.from, query.file, query.after, query.before].filter(Boolean).length;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readable(body: string, format: ChatFormat) {
  let text = plainMentions(body);
  if (format === "markdown") {
    text = text
      .replace(/^```[^\n]*\n?/gm, "")
      .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1")
      .replace(/^\s{0,3}(?:>|#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(/(^|[\s(])([*_])(\S(?:[^\n]*?\S)?)\2(?=$|[\s).,;:!?])/g, "$1$3");
  }
  return text.replace(/\s+/g, " ").trim();
}

export function searchExcerpt(body: string, format: ChatFormat, text: string) {
  const plain = readable(body, format);
  if (plain.length <= WINDOW) return plain;
  const needle = text.trim();
  const found = needle ? new RegExp(escapeRegExp(needle), "i").exec(plain) : null;
  let start = found ? Math.max(0, found.index - LEAD) : 0;
  if (start > 0) {
    const space = plain.indexOf(" ", start);
    if (space >= 0 && space - start < SNAP) start = space + 1;
  }
  let end = Math.min(plain.length, start + WINDOW);
  if (end < plain.length) {
    const space = plain.lastIndexOf(" ", end);
    if (space > end - SNAP && space > start) end = space;
  }
  return `${start > 0 ? "…" : ""}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
}

export type SearchPart = { text: string; match: boolean };

export function searchParts(text: string, needle: string): SearchPart[] {
  const wanted = needle.trim();
  if (!wanted || !text) return [{ text, match: false }];
  const parts: SearchPart[] = [];
  let last = 0;
  for (const found of text.matchAll(new RegExp(escapeRegExp(wanted), "gi"))) {
    const at = found.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at), match: false });
    parts.push({ text: found[0], match: true });
    last = at + found[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts.length > 0 ? parts : [{ text, match: false }];
}
