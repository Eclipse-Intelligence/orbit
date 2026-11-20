import { fenceRangeAt, markdownLayout } from "@/lib/chat/markdown";

export type InlineKind = "bold" | "italic" | "strike" | "code" | "link";

export type InlineSpan = {
  from: number;
  to: number;
  kind: InlineKind;
  href?: string;
};

export type LineKind = "text" | "bullets" | "numbers" | "quote" | "code";

export type RichLine = { kind: LineKind; start?: number; language?: string };

export type RichDoc = { text: string; lines: RichLine[]; spans: InlineSpan[] };

export const INLINE_ORDER: readonly InlineKind[] = ["link", "bold", "strike", "italic", "code"];

const EMPHASIS: readonly InlineKind[] = ["bold", "italic", "strike"];
const OPEN: Record<Exclude<InlineKind, "link">, string> = {
  bold: "**",
  strike: "~~",
  italic: "_",
  code: "`",
};
const BULLET = /^[-*•][ \t]+/;
const NUMBERED = /^(\d{1,9})[.)][ \t]+/;
const QUOTE = /^>[ \t]?/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const FENCE_LENGTH = 3;

type Format = { kinds: Set<InlineKind>; href?: string };

export function lineStarts(text: string) {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

export function emptyDoc(): RichDoc {
  return { text: "", lines: [{ kind: "text" }], spans: [] };
}

export function fromMarkdown(src: string): RichDoc {
  const layout = markdownLayout(src);
  const hidden = new Uint8Array(src.length);
  for (const mark of layout.marks) hidden.fill(1, mark.start, mark.end);
  const blocks = layout.spans.filter((span) => span.kind === "quote" || span.kind === "bullets" || span.kind === "numbers" || span.kind === "codeBlock");
  const position = new Int32Array(src.length + 1).fill(-1);
  const parts: string[] = [];
  const lines: RichLine[] = [];
  let length = 0;
  const push = (text: string, line: RichLine) => {
    if (parts.length) length += 1;
    parts.push(text);
    lines.push(line);
    length += text.length;
  };
  let start = 0;
  while (start <= src.length) {
    const newline = src.indexOf("\n", start);
    const end = newline < 0 ? src.length : newline;
    const fence = blocks.find((block) => block.kind === "codeBlock" && block.start === start);
    if (fence) {
      const range = fenceRangeAt(src, fence.start + FENCE_LENGTH);
      const body = range ? src.slice(range.content.from, range.content.to) : "";
      const language = range?.content.language ? src.slice(range.content.language.start, range.content.language.end).trim() : "";
      body.split("\n").forEach((part, index) => push(part, index === 0 && language ? { kind: "code", language } : { kind: "code" }));
      const after = src.indexOf("\n", fence.end);
      if (after < 0) break;
      start = after + 1;
      continue;
    }
    const lineText = src.slice(start, end);
    const block = blocks.find((candidate) => candidate.kind !== "codeBlock" && candidate.start <= start && start <= candidate.end);
    let prefix = 0;
    let line: RichLine = { kind: "text" };
    if (block?.kind === "bullets") {
      prefix = BULLET.exec(lineText)?.[0].length ?? 0;
      line = { kind: "bullets" };
    } else if (block?.kind === "numbers") {
      const found = NUMBERED.exec(lineText);
      prefix = found?.[0].length ?? 0;
      line = start === block.start && found && Number(found[1]) !== 1 ? { kind: "numbers", start: Number(found[1]) } : { kind: "numbers" };
    } else if (block?.kind === "quote") {
      prefix = QUOTE.exec(lineText)?.[0].length ?? 0;
      line = { kind: "quote" };
    }
    let visible = "";
    const offset = parts.length ? length + 1 : length;
    for (let index = start + prefix; index < end; index += 1) {
      if (hidden[index]) continue;
      position[index] = offset + visible.length;
      visible += src[index];
    }
    push(visible, line);
    if (newline < 0) break;
    start = newline + 1;
  }
  const spans: InlineSpan[] = [];
  for (const span of layout.spans) {
    if (span.kind !== "bold" && span.kind !== "italic" && span.kind !== "strike" && span.kind !== "code" && span.kind !== "link") continue;
    let from = -1;
    let to = -1;
    for (let index = span.start; index < span.end; index += 1) {
      if (position[index] < 0) continue;
      if (from < 0) from = position[index];
      to = position[index] + 1;
    }
    if (from < 0) continue;
    spans.push(span.kind === "link" ? { from, to, kind: "link", href: span.href } : { from, to, kind: span.kind });
  }
  const text = parts.join("\n");
  return { text, lines, spans: normalSpans(text, lines, spans) };
}

function formatKey(format: Format) {
  const kinds = INLINE_ORDER.filter((kind) => format.kinds.has(kind));
  return `${kinds.join(",")}${format.href ? `|${format.href}` : ""}`;
}

function charFormats(text: string, spans: InlineSpan[]) {
  const formats: Format[] = Array.from({ length: text.length }, () => ({
    kinds: new Set<InlineKind>(),
  }));
  for (const span of spans) {
    for (let index = Math.max(0, span.from); index < Math.min(text.length, span.to); index += 1) {
      formats[index].kinds.add(span.kind);
      if (span.kind === "link") formats[index].href = span.href;
    }
  }
  return formats;
}

function runsOf(formats: Format[], kind: InlineKind) {
  const runs: { from: number; to: number }[] = [];
  let index = 0;
  while (index < formats.length) {
    if (!formats[index].kinds.has(kind)) {
      index += 1;
      continue;
    }
    const from = index;
    while (index < formats.length && formats[index].kinds.has(kind) && (kind !== "link" || formats[index].href === formats[from].href)) index += 1;
    runs.push({ from, to: index });
  }
  return runs;
}

function drop(formats: Format[], kind: InlineKind, from: number, to: number) {
  for (let index = from; index < to; index += 1) {
    formats[index].kinds.delete(kind);
    if (kind === "link") formats[index].href = undefined;
  }
}

function writable(text: string, formats: Format[]) {
  for (const kind of [...EMPHASIS, "link"] as const) {
    for (const run of runsOf(formats, kind)) {
      let from = run.from;
      let to = run.to;
      while (from < to && SPACE.test(text[from])) from += 1;
      while (to > from && SPACE.test(text[to - 1])) to -= 1;
      drop(formats, kind, run.from, from);
      drop(formats, kind, to, run.to);
    }
  }
  for (const run of runsOf(formats, "italic")) {
    if (WORD.test(text[run.from - 1] ?? "") || WORD.test(text[run.to] ?? "")) drop(formats, "italic", run.from, run.to);
  }
  for (const run of runsOf(formats, "code")) {
    if (text.slice(run.from, run.to).includes("`")) drop(formats, "code", run.from, run.to);
  }
  for (const run of runsOf(formats, "link")) {
    const label = text.slice(run.from, run.to);
    if (/[[\]]/.test(label) || !formats[run.from].href) drop(formats, "link", run.from, run.to);
  }
}

function opener(kind: InlineKind) {
  return kind === "link" ? "[" : OPEN[kind];
}

function closer(kind: InlineKind, href: string | undefined) {
  return kind === "link" ? `](${href ?? ""})` : OPEN[kind];
}

export function inlineMarkdown(text: string, spans: InlineSpan[]) {
  if (!text) return "";
  const formats = charFormats(text, spans);
  writable(text, formats);
  let out = "";
  let stack: { kind: InlineKind; href?: string }[] = [];
  let index = 0;
  while (index < text.length) {
    const key = formatKey(formats[index]);
    let end = index + 1;
    while (end < text.length && formatKey(formats[end]) === key) end += 1;
    const format = formats[index];
    const wanted = INLINE_ORDER.filter((kind) => format.kinds.has(kind)).map((kind) => ({ kind, href: kind === "link" ? format.href : undefined }));
    let keep = 0;
    while (keep < stack.length && keep < wanted.length && stack[keep].kind === wanted[keep].kind && stack[keep].href === wanted[keep].href) keep += 1;
    for (let pop = stack.length - 1; pop >= keep; pop -= 1) out += closer(stack[pop].kind, stack[pop].href);
    stack = stack.slice(0, keep);
    for (const item of wanted.slice(keep)) {
      out += opener(item.kind);
      stack.push(item);
    }
    out += text.slice(index, end);
    index = end;
  }
  for (let pop = stack.length - 1; pop >= 0; pop -= 1) out += closer(stack[pop].kind, stack[pop].href);
  return out;
}

export function toMarkdown(doc: RichDoc): string {
  const parts = doc.text.split("\n");
  const starts = lineStarts(doc.text);
  const out: string[] = [];
  let number = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const line = doc.lines[index] ?? { kind: "text" };
    if (line.kind === "code") {
      let last = index;
      while (last + 1 < parts.length && doc.lines[last + 1]?.kind === "code") last += 1;
      out.push(`\`\`\`${line.language ?? ""}`, ...parts.slice(index, last + 1), "```");
      index = last;
      number = 0;
      continue;
    }
    const from = starts[index];
    const to = from + parts[index].length;
    const inline = inlineMarkdown(
      parts[index],
      doc.spans
        .filter((span) => span.from < to && span.to > from)
        .map((span) => ({
          ...span,
          from: Math.max(span.from, from) - from,
          to: Math.min(span.to, to) - from,
        })),
    );
    if (line.kind === "numbers") {
      number = doc.lines[index - 1]?.kind === "numbers" ? number + 1 : (line.start ?? 1);
      out.push(`${number}. ${inline}`);
      continue;
    }
    number = 0;
    if (line.kind === "bullets") out.push(`- ${inline}`);
    else if (line.kind === "quote") out.push(inline ? `> ${inline}` : ">");
    else out.push(inline);
  }
  return out.join("\n");
}

export function normalSpans(text: string, lines: RichLine[], spans: InlineSpan[]): InlineSpan[] {
  const starts = lineStarts(text);
  const pieces: InlineSpan[] = [];
  for (const span of spans) {
    const from = Math.max(0, Math.min(span.from, text.length));
    const to = Math.max(0, Math.min(span.to, text.length));
    if (to <= from) continue;
    for (let line = 0; line < starts.length; line += 1) {
      if (lines[line]?.kind === "code") continue;
      const lineFrom = starts[line];
      const lineTo = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
      const pieceFrom = Math.max(from, lineFrom);
      const pieceTo = Math.min(to, lineTo);
      if (pieceTo > pieceFrom) pieces.push({ ...span, from: pieceFrom, to: pieceTo });
    }
  }
  const merged: InlineSpan[] = [];
  for (const kind of INLINE_ORDER) {
    const ofKind = pieces.filter((span) => span.kind === kind).sort((left, right) => left.from - right.from || left.to - right.to);
    for (const span of ofKind) {
      const last = merged.length && merged[merged.length - 1].kind === kind ? merged[merged.length - 1] : null;
      if (last && span.from <= last.to && last.href === span.href) last.to = Math.max(last.to, span.to);
      else if (last && span.from < last.to) {
        last.to = span.from;
        if (last.to <= last.from) merged.pop();
        merged.push({ ...span });
      } else merged.push({ ...span });
    }
  }
  return merged.filter((span) => span.to > span.from).sort((left, right) => left.from - right.from || INLINE_ORDER.indexOf(left.kind) - INLINE_ORDER.indexOf(right.kind));
}

export function sameLook(left: RichDoc, right: RichDoc) {
  if (left.text !== right.text || left.lines.length !== right.lines.length) return false;
  if (left.lines.some((line, index) => line.kind !== right.lines[index].kind)) return false;
  const one = charFormats(left.text, left.spans);
  const two = charFormats(right.text, right.spans);
  for (let index = 0; index < left.text.length; index += 1) {
    if (SPACE.test(left.text[index])) continue;
    if (formatKey(one[index]) !== formatKey(two[index])) return false;
  }
  return true;
}

export function withRange(spans: InlineSpan[], from: number, to: number, kind: InlineKind, on: boolean, href?: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  for (const span of spans) {
    if (span.kind !== kind || span.to <= from || span.from >= to) {
      out.push(span);
      continue;
    }
    if (span.from < from) out.push({ ...span, to: from });
    if (span.to > to) out.push({ ...span, from: to });
  }
  if (on && to > from) out.push(kind === "link" ? { from, to, kind, href } : { from, to, kind });
  return out;
}

export function coveredBy(doc: Pick<RichDoc, "text" | "spans">, from: number, to: number, kind: InlineKind) {
  let any = false;
  for (let index = from; index < to; index += 1) {
    if (SPACE.test(doc.text[index])) continue;
    any = true;
    if (!doc.spans.some((span) => span.kind === kind && span.from <= index && index < span.to)) return false;
  }
  return any;
}

export function carriedAt(spans: InlineSpan[], pos: number): Set<InlineKind> {
  const kinds = new Set<InlineKind>();
  for (const span of spans) {
    if (span.kind === "link" ? span.from < pos && pos < span.to : span.from < pos && pos <= span.to) kinds.add(span.kind);
  }
  return kinds;
}

export function linkAt(spans: InlineSpan[], from: number, to = from): InlineSpan | null {
  return spans.find((span) => span.kind === "link" && span.from <= from && to <= span.to) ?? null;
}

export function tightenAt(text: string, pos: number, names: string[]) {
  if (!/^[,.;:!?]/.test(text.slice(pos)) || text[pos - 1] !== " ") return -1;
  const before = text.slice(0, pos - 1);
  return names.some((name) => before.endsWith(`@${name}`)) ? pos - 1 : -1;
}

export function cleanHref(input: string): string | null {
  const value = input.trim();
  if (!value || /\s/.test(value)) return null;
  const href = /^(?:https?:\/\/|mailto:)/i.test(value) ? value : /^[^@/]+@[^@/]+\.[^@/]+$/.test(value) ? `mailto:${value}` : `https://${value}`;
  let depth = 0;
  for (const char of href) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0 || depth > 1) return null;
  }
  if (depth !== 0 || /[<>"]/.test(href)) return null;
  return href;
}
