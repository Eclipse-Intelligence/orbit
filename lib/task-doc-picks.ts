import type { DocPick } from "@/lib/docs/client-types";
import { orbitPath } from "@/lib/chat/task-text";
import { docQueryAt } from "@/lib/task-pad";

export function privateDocWarning(doc: Pick<DocPick, "folderPath">) {
  const folder = doc.folderPath?.split(" › ").pop() ?? "Top level";
  return `${folder}, private. Teammates will see "Doc" only`;
}

export function docPickHeading(query: string, docs: DocPick[] | null) {
  if (!docs) return "";
  if (!query.trim()) return docs.length > 0 ? "Recent" : "";
  return docs.length === 1 ? "1 match" : `${docs.length} matches`;
}

export function docPickNotice(query: string, docs: DocPick[] | null, failed: boolean) {
  if (failed) return "Couldn't search. Try again.";
  if (docs && docs.length === 0 && query.trim()) return "No docs match";
  return null;
}

export const WEB_ADDRESS = /\bhttps?:\/\//i;

const BIDI = /[‎‏‪-‮⁦-⁩]/;

export function sourceOffset(text: string, shown: number) {
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (BIDI.test(text[index])) continue;
    if (seen === shown) return index;
    seen += 1;
  }
  return text.length;
}

const DOC_REFERENCE = /\[\[([^[\]\n]+)\]\]/g;
const SPACE_END = /[ \t]$/;
const SPACE_START = /^[ \t]/;

export const PRIVATE_DOC_NOTE = "Linked. Private docs aren't named in the description.";

const ORBIT_LINK = /\[([^[\]\n]{1,80})\]\((\/[^\s()<>"\\[\]]{0,500})\)/g;

export function hasDocReference(text: string) {
  return new RegExp(DOC_REFERENCE.source).test(text);
}

export function hasOrbitLink(text: string) {
  for (const match of text.matchAll(ORBIT_LINK)) if (orbitPath(match[2])) return true;
  return false;
}

export function descriptionPreview(text: string | null | undefined) {
  const line = (text ?? "").trim().split("\n")[0]?.trim() ?? "";
  return line.replace(ORBIT_LINK, (whole, label: string, path: string) => (orbitPath(path) ? label : whole));
}

export function showsDescriptionLinks(text: string, layout: "panel" | "row", editing: boolean) {
  if (editing) return false;
  return hasDocReference(text) || hasOrbitLink(text) || (layout === "panel" && WEB_ADDRESS.test(text));
}

export function docReferenceTitle(title: string | null | undefined) {
  return (title ?? "").replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

type DocQuerySpan = { start: number; end: number };

function around(text: string, found: DocQuerySpan) {
  return { before: text.slice(0, found.start), after: text.slice(found.end).replace(/^\]\]/, "") };
}

export function removeDocQuery(text: string, found: DocQuerySpan) {
  const { before, after } = around(text, found);
  const rest = SPACE_END.test(before) && (SPACE_START.test(after) || !after) ? after.replace(/^[ \t]+/, "") : after;
  return { text: before + rest, caret: before.length };
}

const CLOSED_REFERENCE = /\[\[[^[\]\n]*\]\]/g;

function pastClosedReference(text: string, at: number) {
  for (const match of text.matchAll(CLOSED_REFERENCE)) {
    if (match.index <= at && at <= match.index + match[0].length) return match.index + match[0].length;
  }
  return at;
}

function pastWord(text: string, at: number) {
  let next = at;
  if (next > 0 && /\S/.test(text[next - 1] ?? "")) while (next < text.length && /\S/.test(text[next]) && !text.startsWith("[[", next)) next += 1;
  return next;
}

export function insertionPoint(text: string, caret: number) {
  const given = Math.min(Math.max(0, caret), text.length);
  const typed = text[given - 1] === "[" && text[given] === "[" ? given - 1 : given;
  const live = docQueryAt(text, typed);
  if (live && !text.startsWith("]]", live.end)) return live.start;
  let at = pastClosedReference(text, typed);
  for (let moved = true; moved; ) {
    const next = pastClosedReference(text, pastWord(text, at));
    moved = next !== at;
    at = next;
  }
  return at;
}

export function insertReferenceAt(text: string, caret: number, title: string | null | undefined) {
  const typed = Math.min(Math.max(0, caret), text.length);
  const at = insertionPoint(text, typed);
  const before = text.slice(0, at);
  const after = text.slice(at);
  const reference = `[[${docReferenceTitle(title)}]]`;
  const lead = before && !/[\s(]$/.test(before) ? " " : "";
  const trail = /^[\s.,;:!?)]/.test(after) ? "" : " ";
  const added = lead.length + reference.length + trail.length;
  return { text: before + lead + reference + trail + after, caret: at < typed ? typed + added : at + added };
}

export function insideClosedReference(text: string, found: DocQuerySpan) {
  return text.startsWith("]]", found.end);
}

export function textEdit(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  return { start, end: before.length - tail, insert: after.slice(start, after.length - tail) };
}

export type DescriptionPart =
  | { kind: "text"; text: string; start: number }
  | { kind: "doc"; id: string; label: string; start: number }
  | { kind: "link"; href: string; label: string; start: number; length: number };

type ReferenceDoc = { id: string; title: string | null; readable: boolean };

export function descriptionParts(text: string, docs: ReferenceDoc[]): DescriptionPart[] {
  const open = new Map<string, string>();
  for (const doc of docs) {
    const key = docReferenceTitle(doc.title).toLowerCase();
    if (doc.readable && !open.has(key)) open.set(key, doc.id);
  }
  const found: { start: number; length: number; part: DescriptionPart }[] = [];
  for (const match of text.matchAll(DOC_REFERENCE)) {
    const id = open.get(docReferenceTitle(match[1]).toLowerCase());
    if (id) found.push({ start: match.index, length: match[0].length, part: { kind: "doc", id, label: match[1], start: match.index } });
  }
  for (const match of text.matchAll(ORBIT_LINK)) {
    if (orbitPath(match[2])) found.push({ start: match.index, length: match[0].length, part: { kind: "link", href: match[2], label: match[1], start: match.index, length: match[0].length } });
  }
  found.sort((left, right) => left.start - right.start);
  const parts: DescriptionPart[] = [];
  let last = 0;
  for (const item of found) {
    if (item.start < last) continue;
    if (item.start > last) parts.push({ kind: "text", text: text.slice(last, item.start), start: last });
    parts.push(item.part);
    last = item.start + item.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last), start: last });
  return parts;
}

function shownLength(text: string) {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) if (!BIDI.test(text[index])) count += 1;
  return count;
}

export function partsSourceOffset(text: string, parts: DescriptionPart[], shown: number) {
  let seen = 0;
  for (const part of parts) {
    const length = part.kind === "text" ? shownLength(part.text) : part.label.length;
    if (shown <= seen + length) {
      if (part.kind === "text") return part.start + sourceOffset(part.text, shown - seen);
      const inside = shown - seen;
      if (part.kind === "link") return inside === 0 ? part.start : inside === length ? part.start + part.length : part.start + 1 + inside;
      return inside === 0 ? part.start : inside === length ? part.start + length + 4 : part.start + 2 + inside;
    }
    seen += length;
  }
  return text.length;
}
