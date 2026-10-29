import { namedMentions, splitMentions, type Mention } from "@/lib/mentions";
import type { TagNode } from "@/lib/docs/client-types";

export type WikiTarget = { target: string; heading: string | null; label: string | null };

export type WikiLinkMatch = WikiTarget & { from: number; to: number };

export type TagMatch = { from: number; to: number; path: string };

export type Trigger =
  | { kind: "link"; from: number; query: string }
  | { kind: "tag"; from: number; query: string }
  | { kind: "mention"; from: number; query: string };

const WIKI_LINK = /\[\[([^[\]\n]{1,200})\]\]/g;
const TAG = /(^|[^\p{L}\p{N}_#&/\\[])#(\p{L}[\p{L}\p{N}_-]*(?:\/[\p{L}\p{N}_-]+)*)/gu;
export const ENTRY_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?= |$)/;
const TAG_CHAR = /^[\p{L}\p{N}_/-]$/u;

export function parseWikiTarget(inner: string): WikiTarget {
  const pipe = inner.indexOf("|");
  const label = pipe >= 0 ? inner.slice(pipe + 1).trim() || null : null;
  const link = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  const hash = link.indexOf("#");
  if (hash < 0) return { target: link, heading: null, label };
  return { target: link.slice(0, hash).trim(), heading: link.slice(hash + 1).trim() || null, label };
}

export function findWikiLinks(text: string): WikiLinkMatch[] {
  const found: WikiLinkMatch[] = [];
  for (const match of text.matchAll(WIKI_LINK)) {
    const from = match.index ?? 0;
    const parsed = parseWikiTarget(match[1]);
    if (!parsed.target) continue;
    found.push({ from, to: from + match[0].length, ...parsed });
  }
  return found;
}

export function wikiLabel(link: WikiTarget) {
  if (link.label) return link.label;
  return link.heading ? `${link.target} › ${link.heading}` : link.target;
}

export function findTags(text: string): TagMatch[] {
  const found: TagMatch[] = [];
  for (const match of text.matchAll(TAG)) {
    const from = (match.index ?? 0) + match[1].length;
    const path = match[2].replace(/[-/]+$/, "");
    found.push({ from, to: from + 1 + path.length, path });
  }
  return found;
}

export function normaliseTag(path: string) {
  return path
    .trim()
    .replace(/^#+/, "")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "")
    .toLowerCase();
}

export function tagsIn(body: string) {
  const outside = stripCode(body);
  return [...new Set(findTags(outside).map((tag) => normaliseTag(tag.path)))];
}

export function linkTitlesIn(body: string) {
  return [...new Set(findWikiLinks(stripCode(body)).map((link) => link.target))];
}

export function mentionsInBody(body: string): Mention[] {
  const seen = new Set<string>();
  const found: Mention[] = [];
  for (const piece of splitMentions(body)) {
    if (!("mention" in piece)) continue;
    const key = `${piece.mention.kind}:${piece.mention.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(piece.mention);
  }
  return found;
}

function stripCode(body: string) {
  return body.replace(/```[\s\S]*?(```|$)/g, (block) => " ".repeat(block.length)).replace(/`[^`\n]*`/g, (code) => " ".repeat(code.length));
}

export function tagMatches(tags: string[], path: string) {
  const wanted = normaliseTag(path);
  return tags.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`));
}

export function buildTagTree(pages: string[][]): TagNode[] {
  const counts = new Map<string, number>();
  for (const tags of pages) {
    const prefixes = new Set<string>();
    for (const tag of tags) {
      const parts = normaliseTag(tag).split("/").filter(Boolean);
      for (let index = 1; index <= parts.length; index += 1) prefixes.add(parts.slice(0, index).join("/"));
    }
    for (const prefix of prefixes) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const root: TagNode[] = [];
  const byPath = new Map<string, TagNode>();
  for (const path of [...counts.keys()].sort()) {
    const parts = path.split("/");
    const node: TagNode = { name: parts[parts.length - 1], path, count: counts.get(path) ?? 0, children: [] };
    byPath.set(path, node);
    const parent = parts.length > 1 ? byPath.get(parts.slice(0, -1).join("/")) : null;
    (parent ? parent.children : root).push(node);
  }
  return root;
}

export function triggerBefore(before: string): Trigger | null {
  const link = before.lastIndexOf("[[");
  if (link >= 0) {
    const query = before.slice(link + 2);
    if (!/[[\]\n]/.test(query) && query.length <= 120) return { kind: "link", from: link, query };
  }
  const tag = /(^|[\s(])#([\p{L}\p{N}_/-]+)$/u.exec(before);
  if (tag && /^\p{L}/u.test(tag[2])) return { kind: "tag", from: before.length - tag[2].length - 1, query: tag[2] };
  const at = before.lastIndexOf("@");
  if (at >= 0) {
    const query = before.slice(at + 1);
    const boundary = at === 0 || /[\s(]/.test(before[at - 1]);
    if (boundary && !/\s{2,}|\n|[[\]()@]/.test(query) && query.length <= 40 && query.split(" ").length <= 3) {
      return { kind: "mention", from: at, query };
    }
  }
  return null;
}

export function isTagChar(char: string) {
  return TAG_CHAR.test(char);
}

export function plainText(body: string) {
  return namedMentions(body)
    .replace(/^```.*$/gm, "")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/\[\[([^[\]\n]+)\]\]/g, (_whole, inner: string) => wikiLabel(parseWikiTarget(inner)))
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?!\w)/g, "$1$2")
    .replace(/`([^`\n]*)`/g, "$1");
}

export function wordCount(body: string) {
  const words = plainText(body).match(/[\p{L}\p{N}][\p{L}\p{N}'’.,%£$-]*/gu);
  return words ? words.length : 0;
}

export function snippetOf(body: string, length = 180) {
  const lines = body.split("\n");
  const prose: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s{0,3}#{1,6}\s/.test(line) || !line.trim()) continue;
    prose.push(plainText(line.replace(ENTRY_TIME, "")).trim());
    if (prose.join(" ").length >= length) break;
  }
  const text = prose.join(" ").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

export type Heading = { level: number; text: string; line: number };

export function headingsIn(body: string): Heading[] {
  const found: Heading[] = [];
  let fenced = false;
  body.split("\n").forEach((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) found.push({ level: match[1].length, text: plainText(match[2]).trim(), line: index });
  });
  return found;
}

export function contextAround(text: string, from: number, to: number, radius = 90) {
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const lineEndRaw = text.indexOf("\n", to);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  let start = Math.max(lineStart, from - radius);
  let end = Math.min(lineEnd, to + radius);
  if (start > lineStart) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < from) start = space + 1;
  }
  if (end < lineEnd) {
    const space = text.lastIndexOf(" ", end);
    if (space > to) end = space;
  }
  const raw = text.slice(start, end);
  const leading = raw.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*|#{1,6}\s+)?/, "");
  const trimmed = raw.length - leading.length;
  const prefix = start > lineStart ? "…" : "";
  const suffix = end < lineEnd ? "…" : "";
  return {
    text: `${prefix}${leading}${suffix}`,
    matchFrom: prefix.length + from - start - trimmed,
    matchTo: prefix.length + to - start - trimmed,
  };
}

export function renameWikiLinks(body: string, oldTitle: string, newTitle: string) {
  const wanted = oldTitle.trim().toLowerCase();
  return body.replace(WIKI_LINK, (whole, inner: string) => {
    const parsed = parseWikiTarget(inner);
    if (parsed.target.toLowerCase() !== wanted) return whole;
    const heading = parsed.heading ? `#${parsed.heading}` : "";
    const label = parsed.label ? `|${parsed.label}` : "";
    return `[[${newTitle}${heading}${label}]]`;
  });
}

export function unlinkedMatches(body: string, title: string) {
  const clean = title.trim();
  if (clean.length < 3) return [];
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}[])(${escaped})(?![\\p{L}\\p{N}\\]])`, "giu");
  const linked = findWikiLinks(body);
  const found: { from: number; to: number }[] = [];
  for (const match of body.matchAll(pattern)) {
    const from = (match.index ?? 0) + match[1].length;
    const to = from + match[2].length;
    if (linked.some((link) => from >= link.from && to <= link.to)) continue;
    found.push({ from, to });
  }
  return found;
}

export function entryCount(body: string) {
  return body.split("\n").filter((line) => ENTRY_TIME.test(line)).length;
}

export function entryTime(date: Date, timeZone = "Europe/London") {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
}

export function appendEntry(body: string, time: string, text: string) {
  const clean = text.trim();
  if (!clean) return body;
  const base = body.replace(/\s+$/, "");
  return base ? `${base}\n\n${time} ${clean}` : `${time} ${clean}`;
}

export function toggleTaskMarker(line: string) {
  const match = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(line);
  if (!match) return null;
  const next = match[2] === " " ? "x" : " ";
  return `${match[1]}${next}${match[3]}${line.slice(match[0].length)}`;
}
