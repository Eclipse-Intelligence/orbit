import { codeRanges, fenceRangeAt, type FormatKind } from "@/lib/chat/markdown";
import type { Mention } from "@/lib/mentions";

export type TextEdit = { start: number; end: number; text: string; selectionStart: number; selectionEnd: number };

export type FormatAction = FormatKind;

const MARKERS: Partial<Record<FormatAction, string>> = { bold: "**", italic: "_", strike: "~~", code: "`" };

export const OPENING_MARKERS = /[*_~]/;

function trimmed(value: string, start: number, end: number) {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(value[from])) from += 1;
  while (to > from && /\s/.test(value[to - 1])) to -= 1;
  return from < to ? { from, to } : { from: start, to: end };
}

const LINE_START = /^\s*(?:(?:[-*•]|\d{1,9}[.)]|>)[ \t]+)?/;

function lineCore(line: string) {
  const lead = LINE_START.exec(line)![0].length;
  const tail = line.length - line.trimEnd().length;
  return { lead, tail, core: line.slice(lead, line.length - tail) };
}

function wrapLine(line: string, marker: string, remove: boolean) {
  const { lead, tail, core } = lineCore(line);
  if (!core) return line;
  const next = remove ? core.slice(marker.length, core.length - marker.length) : `${marker}${core}${marker}`;
  return `${line.slice(0, lead)}${next}${line.slice(line.length - tail)}`;
}

function wrapped(text: string, marker: string) {
  return text.length > marker.length * 2 && text.startsWith(marker) && text.endsWith(marker);
}

function wrapLines(value: string, from: number, to: number, marker: string): TextEdit {
  const lines = value.slice(from, to).split("\n");
  const filled = lines.filter((line) => lineCore(line).core);
  const remove = filled.every((line) => wrapped(lineCore(line).core, marker));
  const text = lines.map((line) => wrapLine(line, marker, remove)).join("\n");
  return { start: from, end: to, text, selectionStart: from, selectionEnd: from + text.length };
}

function wrap(value: string, start: number, end: number, marker: string): TextEdit {
  const { from, to } = trimmed(value, start, end);
  const size = marker.length;
  const selected = value.slice(from, to);
  if (selected.includes("\n") || lineCore(selected).lead > 0) return wrapLines(value, from, to, marker);
  if (wrapped(selected, marker)) {
    const inner = selected.slice(size, -size);
    return { start: from, end: to, text: inner, selectionStart: from, selectionEnd: from + inner.length };
  }
  if (from - size >= 0 && value.slice(from - size, from) === marker && value.slice(to, to + size) === marker) {
    return { start: from - size, end: to + size, text: selected, selectionStart: from - size, selectionEnd: from - size + selected.length };
  }
  return { start: from, end: to, text: `${marker}${selected}${marker}`, selectionStart: from + size, selectionEnd: to + size };
}

function link(value: string, start: number, end: number): TextEdit {
  const { from, to } = trimmed(value, start, end);
  const selected = value.slice(from, to);
  if (/^(?:https?:\/\/|mailto:)\S+$/i.test(selected)) {
    return { start: from, end: to, text: `[${selected}](${selected})`, selectionStart: from + 1, selectionEnd: from + 1 + selected.length };
  }
  const text = `[${selected}](https://)`;
  if (!selected) return { start: from, end: to, text, selectionStart: from + 1, selectionEnd: from + 1 };
  const caret = from + text.length - 1;
  return { start: from, end: to, text, selectionStart: caret, selectionEnd: caret };
}

function lineBounds(value: string, start: number, end: number) {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const next = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
  return { from, to: next < 0 ? value.length : next };
}

const LINE_PREFIX: Record<"bullets" | "numbers" | "quote", RegExp> = {
  bullets: /^[-*•][ \t]+/,
  numbers: /^\d{1,9}[.)][ \t]+/,
  quote: /^>[ \t]?/,
};

function prefixLines(value: string, start: number, end: number, kind: "bullets" | "numbers" | "quote"): TextEdit {
  const { from, to } = lineBounds(value, start, end);
  const lines = value.slice(from, to).split("\n");
  const pattern = LINE_PREFIX[kind];
  const filled = lines.filter((line) => line.trim() !== "");
  const remove = filled.length > 0 && filled.every((line) => pattern.test(line));
  let count = 0;
  const next = lines.map((line) => {
    if (remove) return line.replace(pattern, "");
    if (line.trim() === "" && lines.length > 1) return line;
    count += 1;
    const bare = line.replace(LINE_PREFIX.bullets, "").replace(LINE_PREFIX.numbers, "").replace(LINE_PREFIX.quote, "");
    if (kind === "bullets") return `- ${bare}`;
    if (kind === "numbers") return `${count}. ${bare}`;
    return `> ${line}`;
  });
  const text = next.join("\n");
  if (start === end) {
    const caret = Math.max(from, start + text.length - (to - from));
    return { start: from, end: to, text, selectionStart: caret, selectionEnd: caret };
  }
  return { start: from, end: to, text, selectionStart: from, selectionEnd: from + text.length };
}

function codeBlock(value: string, start: number, end: number): TextEdit {
  const fence = fenceRangeAt(value, start, end);
  if (fence) {
    const body = value.slice(fence.content.from, fence.content.to);
    const until = fence.closed ? fence.closeAt + 3 : fence.end;
    return { start: fence.open, end: until, text: body, selectionStart: fence.open, selectionEnd: fence.open + body.length };
  }
  const selected = value.slice(start, end);
  const before = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
  const after = end < value.length && value[end] !== "\n" ? "\n" : "";
  const body = selected.replace(/^\n+|\n+$/g, "");
  const text = `${before}\`\`\`\n${body}\n\`\`\`${after}`;
  const inner = start + before.length + 4;
  return { start, end, text, selectionStart: inner, selectionEnd: inner + body.length };
}

export function formatEdit(value: string, start: number, end: number, action: FormatAction): TextEdit {
  if (action === "link") return link(value, start, end);
  if (action === "bullets" || action === "numbers" || action === "quote") return prefixLines(value, start, end, action);
  if (action === "codeBlock" || (action === "code" && value.slice(start, end).includes("\n"))) return codeBlock(value, start, end);
  return wrap(value, start, end, MARKERS[action]!);
}

export function mentionEdit(value: string, start: number, end: number): TextEdit {
  let edge = start;
  while (edge > 0 && OPENING_MARKERS.test(value[edge - 1])) edge -= 1;
  const space = edge > 0 && !/\s/.test(value[edge - 1]) ? " " : "";
  const text = `${space}@`;
  const caret = start + text.length;
  return { start, end, text, selectionStart: caret, selectionEnd: caret };
}

function insideAny(ranges: { start: number; end: number }[], start: number, end: number) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function mentionToken(mention: Mention) {
  return `@[${mention.name.replace(/[[\]\n]/g, " ").trim()}](${mention.kind}:${mention.id})`;
}

export function encodeChatMentions(text: string, mentions: Mention[]) {
  const code = codeRanges(text);
  const claimed: { start: number; end: number; token: string }[] = [];
  const used = new Set<string>();
  for (const mention of [...mentions].sort((left, right) => right.name.length - left.name.length)) {
    const key = `${mention.kind}:${mention.id}`;
    if (used.has(key)) continue;
    const label = `@${mention.name}`;
    let index = text.indexOf(label);
    while (index >= 0 && (insideAny(code, index, index + label.length) || insideAny(claimed, index, index + label.length))) index = text.indexOf(label, index + 1);
    if (index < 0) continue;
    claimed.push({ start: index, end: index + label.length, token: mentionToken(mention) });
    used.add(key);
  }
  let output = text;
  for (const span of claimed.sort((left, right) => right.start - left.start)) output = `${output.slice(0, span.start)}${span.token}${output.slice(span.end)}`;
  return output;
}

export function applyEdit(value: string, edit: TextEdit) {
  return `${value.slice(0, edit.start)}${edit.text}${value.slice(edit.end)}`;
}

const SHORTCODE_TAIL = /(?:^|[\s([{"'])(:[a-z0-9_+-]{2,40})$/i;

export function shortcodeAt(text: string, caret: number): { start: number; end: number; query: string } | null {
  const found = SHORTCODE_TAIL.exec(text.slice(0, caret));
  if (!found) return null;
  const token = found[1];
  return { start: caret - token.length, end: caret, query: token.slice(1).toLowerCase() };
}
