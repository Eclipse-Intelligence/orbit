import { MENTION_KINDS, type Mention, type MentionKind } from "@/lib/mentions";
import { DOC_TAG_MAX, DOC_TITLE_MAX } from "@/lib/docs/types";

export type ParsedLink = {
  start: number;
  end: number;
  target: string;
  title: string;
  heading: string | null;
  label: string | null;
};

export type ParsedDoc = { links: ParsedLink[]; tags: string[]; mentions: Mention[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const WIKILINK = /\[\[([^[\]\n]{1,400}?)\]\]/g;
const MENTION = /@\[([^[\]\n]{1,200})\]\((contact|company|task|opportunity|proposal):([0-9a-f-]{36})\)/g;
const TAG = /#([\p{L}\p{N}_\-/]+)/gu;
const PARAGRAPH_BREAK = /\n[ \t]*\n/g;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const PLAIN_TEXT_MAX = 1_000_000;
const INLINE_MARKUP = /[[<]/;
export const TAG_BODY = /^#([\p{L}\p{N}_\-/]+)/u;
export const ENTRY_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?= |$)/;
const LETTER = /\p{L}/u;

function blank(text: string) {
  return text.includes("\n") ? text.replace(/[^\n]/g, " ") : " ".repeat(text.length);
}

function maskFences(content: string) {
  const lines = content.split("\n");
  let open: { char: string; size: number } | null = null;
  return lines
    .map((line) => {
      const fence = line.includes("```") || line.includes("~~~") ? FENCE.exec(line) : null;
      if (open) {
        if (fence && fence[1][0] === open.char && fence[1].length >= open.size && line.trim().replace(/[`~]/g, "") === "") open = null;
        return blank(line);
      }
      if (fence && !(fence[1][0] === "`" && line.slice(fence[0].length).includes("`"))) {
        open = { char: fence[1][0], size: fence[1].length };
        return blank(line);
      }
      return line;
    })
    .join("\n");
}

export function inlineCodeRanges(content: string): [number, number][] {
  const runs: { start: number; size: number }[] = [];
  for (let index = content.indexOf("`"); index >= 0; index = content.indexOf("`", index)) {
    let size = 0;
    while (content[index + size] === "`") size += 1;
    runs.push({ start: index, size });
    index += size;
  }
  if (runs.length < 2) return [];
  const nextSame = new Array<number>(runs.length).fill(-1);
  const latest = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    nextSame[index] = latest.get(runs[index].size) ?? -1;
    latest.set(runs[index].size, index);
  }
  const breaks: number[] = [];
  for (const match of content.matchAll(PARAGRAPH_BREAK)) breaks.push(match.index ?? 0);
  const ranges: [number, number][] = [];
  let breakAt = 0;
  let index = 0;
  while (index < runs.length) {
    const open = runs[index];
    const close = nextSame[index];
    const after = open.start + open.size;
    while (breakAt < breaks.length && breaks[breakAt] < after) breakAt += 1;
    if (close < 0 || (breakAt < breaks.length && breaks[breakAt] < runs[close].start)) {
      index += 1;
      continue;
    }
    ranges.push([open.start, runs[close].start + runs[close].size]);
    index = close + 1;
  }
  return ranges;
}

function blankRanges(content: string, ranges: [number, number][]) {
  if (ranges.length === 0) return content;
  let output = "";
  let last = 0;
  for (const [from, to] of ranges) {
    output += content.slice(last, from) + blank(content.slice(from, to));
    last = to;
  }
  return output + content.slice(last);
}

function maskInlineCode(content: string) {
  return blankRanges(content, inlineCodeRanges(content));
}

function indentWidth(line: string) {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

function maskIndentedCode(content: string) {
  const lines = content.split("\n");
  let previousBlank = true;
  let previousCode = false;
  let previousHeading = false;
  let inList = false;
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      previousBlank = true;
      continue;
    }
    const indent = indentWidth(line);
    if (indent >= 4 && !inList && (previousBlank || previousCode || previousHeading)) {
      lines[index] = blank(line);
      changed = true;
      previousCode = true;
      previousHeading = false;
      previousBlank = false;
      continue;
    }
    if (indent < 4) inList = LIST_ITEM.test(line) || (inList && !previousBlank);
    previousHeading = indent < 4 && ATX_HEADING.test(line);
    previousCode = false;
    previousBlank = false;
  }
  return changed ? lines.join("\n") : content;
}

function maskComments(content: string) {
  const ranges: [number, number][] = [];
  let from = content.indexOf("<!--");
  while (from >= 0) {
    const close = content.indexOf("-->", from + 4);
    if (close < 0) break;
    ranges.push([from, close + 3]);
    from = content.indexOf("<!--", close + 3);
  }
  return blankRanges(content, ranges);
}

export function maskCode(content: string) {
  return maskComments(maskInlineCode(maskIndentedCode(maskFences(content))));
}

export function cleanTitle(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, DOC_TITLE_MAX);
}

export function splitTarget(inner: string) {
  const bar = inner.indexOf("|");
  const target = cleanTitle(bar >= 0 ? inner.slice(0, bar) : inner);
  const label = bar >= 0 ? cleanTitle(inner.slice(bar + 1)) || null : null;
  const hash = target.indexOf("#");
  const title = hash >= 0 ? cleanTitle(target.slice(0, hash)) : target;
  const heading = hash >= 0 ? cleanTitle(target.slice(hash + 1)) || null : null;
  return { target, title, heading, label };
}

export function parseLinks(content: string, masked = maskCode(content)): ParsedLink[] {
  const links: ParsedLink[] = [];
  for (const match of masked.matchAll(WIKILINK)) {
    const start = match.index ?? 0;
    if (start > 0 && masked[start - 1] === "\\") continue;
    const parts = splitTarget(content.slice(start + 2, start + match[0].length - 2));
    if (!parts.target) continue;
    links.push({ start, end: start + match[0].length, ...parts });
  }
  return links;
}

export function parseMentions(content: string, masked = maskCode(content)): Mention[] {
  const seen = new Map<string, Mention>();
  for (const match of masked.matchAll(MENTION)) {
    const kind = match[2] as MentionKind;
    if (!(MENTION_KINDS as readonly string[]).includes(kind)) continue;
    const key = `${kind}:${match[3]}`;
    if (!seen.has(key)) seen.set(key, { kind, id: match[3], name: match[1].trim() || match[1] });
  }
  return [...seen.values()];
}

export function normaliseTag(value: string) {
  const tag = value
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|[-/]+$/g, "");
  if (!tag || tag.length > DOC_TAG_MAX) return null;
  if (!/^[\p{L}\p{N}_\-/]+$/u.test(tag)) return null;
  if (!LETTER.test(tag)) return null;
  return tag;
}

function maskForTags(masked: string) {
  return masked.replace(WIKILINK, (whole) => blank(whole)).replace(MENTION, (whole) => blank(whole));
}

export type TagMatch = { start: number; end: number; tag: string };

export function findTags(content: string, masked = maskCode(content)): TagMatch[] {
  const text = maskForTags(masked);
  const found: TagMatch[] = [];
  for (const match of text.matchAll(TAG)) {
    const start = match.index ?? 0;
    if (!isTagBoundary(start === 0 ? "" : content[start - 1])) continue;
    const body = match[1].replace(/[-/]+$/, "");
    const tag = body ? normaliseTag(body) : null;
    if (!tag) continue;
    found.push({ start, end: start + 1 + body.length, tag });
  }
  return found;
}

export function parseTags(content: string, masked = maskCode(content)) {
  return [...new Set(findTags(content, masked).map((match) => match.tag))];
}

export function parseDoc(content: string): ParsedDoc {
  const masked = maskCode(content);
  return { links: parseLinks(content, masked), tags: parseTags(content, masked), mentions: parseMentions(content, masked) };
}

export function linkKey(title: string) {
  return cleanTitle(title).toLowerCase();
}

export function rewriteLinkTitle(content: string, from: string, to: string) {
  const key = linkKey(from);
  const next = cleanTitle(to);
  if (!key || !next) return { content, count: 0 };
  let output = "";
  let last = 0;
  let count = 0;
  for (const link of parseLinks(content)) {
    const whole = linkKey(link.target) === key;
    const byTitle = !whole && link.heading !== null && linkKey(link.title) === key;
    if (!whole && !byTitle) continue;
    const target = whole ? next : `${next}#${link.heading}`;
    output += `${content.slice(last, link.start)}[[${target}${link.label ? `|${link.label}` : ""}]]`;
    last = link.end;
    count += 1;
  }
  return { content: count ? output + content.slice(last) : content, count };
}

function inlineText(segment: string) {
  if (!INLINE_MARKUP.test(segment)) return segment;
  return segment
    .replace(MENTION, (_whole, name: string) => name)
    .replace(WIKILINK, (_whole, inner: string) => {
      const parts = splitTarget(inner);
      return parts.label ?? parts.target;
    })
    .replace(/!\[([^[\]\n]*)\]\([^()\n]*\)/g, "$1")
    .replace(/\[([^[\]\n]*)\]\([^()\n]*\)/g, "$1")
    .replace(/<[^<>\n]+>/g, " ");
}

export function plainText(content: string) {
  const source = content.length > PLAIN_TEXT_MAX ? content.slice(0, PLAIN_TEXT_MAX) : content;
  const lines = maskFences(source)
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "");
  let text = "";
  let last = 0;
  for (const [from, to] of inlineCodeRanges(lines)) {
    text += inlineText(lines.slice(last, from)) + lines.slice(from, to);
    last = to;
  }
  text += inlineText(lines.slice(last));
  return text
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordCount(content: string) {
  return plainText(content)
    .split(" ")
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

export function excerptFrom(content: string, max = 200) {
  const text = plainText(content);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function lineAround(content: string, index: number, max = 240) {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const endAt = content.indexOf("\n", index);
  const line = plainText(content.slice(start, endAt < 0 ? content.length : endAt));
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function isTagBoundary(char: string) {
  return char === "" || /\s/.test(char);
}

export function tagAt(text: string) {
  const match = TAG_BODY.exec(text);
  if (!match) return null;
  const path = match[1].replace(/[-/]+$/, "");
  const tag = normaliseTag(path);
  return tag ? { tag, length: 1 + path.length } : null;
}

export function linkTitlesIn(content: string) {
  return [...new Set(parseLinks(content).map((link) => link.title || link.target))];
}

export type TagCount = { path: string; count: number };

export type TagTreeNode = { name: string; path: string; count: number; children: TagTreeNode[] };

export function tagTree(counts: TagCount[]): TagTreeNode[] {
  const root: TagTreeNode[] = [];
  const byPath = new Map<string, TagTreeNode>();
  for (const { path, count } of [...counts].sort((left, right) => left.path.localeCompare(right.path))) {
    const parts = path.split("/");
    const node: TagTreeNode = { name: parts[parts.length - 1], path, count, children: [] };
    byPath.set(path, node);
    const parent = parts.length > 1 ? byPath.get(parts.slice(0, -1).join("/")) : null;
    (parent ? parent.children : root).push(node);
  }
  return root;
}

export function tagPrefixCounts(pages: string[][]): TagCount[] {
  const counts = new Map<string, number>();
  for (const tags of pages) {
    const prefixes = new Set<string>();
    for (const tag of tags) {
      const parts = tag.split("/").filter(Boolean);
      for (let index = 1; index <= parts.length; index += 1) prefixes.add(parts.slice(0, index).join("/"));
    }
    for (const prefix of prefixes) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts].map(([path, count]) => ({ path, count }));
}

export type Trigger =
  | { kind: "link"; from: number; query: string }
  | { kind: "tag"; from: number; query: string }
  | { kind: "mention"; from: number; query: string };

export function triggerBefore(before: string): Trigger | null {
  const link = before.lastIndexOf("[[");
  if (link >= 0) {
    const query = before.slice(link + 2);
    if (!/[[\]\n]/.test(query) && query.length <= 120) return { kind: "link", from: link, query };
  }
  const tag = /(^|\s)#([\p{L}\p{N}_/-]+)$/u.exec(before);
  if (tag && /^\p{L}/u.test(tag[2])) return { kind: "tag", from: before.length - tag[2].length - 1, query: tag[2] };
  const at = before.lastIndexOf("@");
  if (at >= 0) {
    const query = before.slice(at + 1);
    const boundary = at === 0 || /[\s(]/.test(before[at - 1]);
    if (boundary && !/^\s|\s{2,}|\n|[[\]()@]/.test(query) && query.length <= 40 && query.split(" ").length <= 3) {
      return { kind: "mention", from: at, query };
    }
  }
  return null;
}

export function isTagChar(char: string) {
  return /^[\p{L}\p{N}_/-]$/u.test(char);
}

export type Heading = { level: number; text: string; line: number };

export function headingsIn(content: string): Heading[] {
  const found: Heading[] = [];
  maskFences(content)
    .split("\n")
    .forEach((line, index) => {
      const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (match) found.push({ level: match[1].length, text: plainText(match[2]), line: index });
    });
  return found;
}

export function entryCount(content: string) {
  return content.split("\n").filter((line) => ENTRY_TIME.test(line)).length;
}

export function toggleTaskMarker(line: string) {
  const match = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(line);
  if (!match) return null;
  const next = match[2] === " " ? "x" : " ";
  return `${match[1]}${next}${match[3]}${line.slice(match[0].length)}`;
}

export function highlightIn(snippet: string, wanted: string) {
  const index = wanted ? snippet.toLowerCase().indexOf(wanted.toLowerCase()) : -1;
  return index < 0 ? { matchFrom: 0, matchTo: 0 } : { matchFrom: index, matchTo: index + wanted.length };
}
