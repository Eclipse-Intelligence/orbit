import type { DocPick } from "@/lib/docs/client-types";

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

export function hasDocReference(text: string) {
  return new RegExp(DOC_REFERENCE.source).test(text);
}

export function showsDescriptionLinks(text: string, layout: "panel" | "row", editing: boolean) {
  if (editing) return false;
  return hasDocReference(text) || (layout === "panel" && WEB_ADDRESS.test(text));
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

export function insertDocReference(text: string, found: DocQuerySpan, title: string | null | undefined) {
  const { before, after } = around(text, found);
  const reference = `[[${docReferenceTitle(title)}]]`;
  const spacer = /^[\s.,;:!?)]/.test(after) ? "" : " ";
  return { text: before + reference + spacer + after, caret: before.length + reference.length + spacer.length };
}

export function pickIntoDescription(text: string, found: DocQuerySpan, doc: { title: string | null; shared: boolean }) {
  if (doc.shared) return { ...insertDocReference(text, found, doc.title), note: null };
  return { ...removeDocQuery(text, found), note: PRIVATE_DOC_NOTE };
}

export type DescriptionPart = { kind: "text"; text: string; start: number } | { kind: "doc"; id: string; label: string; start: number };

type ReferenceDoc = { id: string; title: string | null; readable: boolean };

export function descriptionParts(text: string, docs: ReferenceDoc[]): DescriptionPart[] {
  const open = new Map(docs.filter((doc) => doc.readable).map((doc) => [docReferenceTitle(doc.title).toLowerCase(), doc.id] as const));
  const parts: DescriptionPart[] = [];
  let last = 0;
  for (const match of text.matchAll(DOC_REFERENCE)) {
    const id = open.get(docReferenceTitle(match[1]).toLowerCase());
    if (!id) continue;
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index), start: last });
    parts.push({ kind: "doc", id, label: match[1], start: match.index });
    last = match.index + match[0].length;
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
    const length = part.kind === "doc" ? part.label.length : shownLength(part.text);
    if (shown <= seen + length) return part.kind === "doc" ? part.start + 2 + (shown - seen) : part.start + sourceOffset(part.text, shown - seen);
    seen += length;
  }
  return text.length;
}
