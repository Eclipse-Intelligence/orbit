import { mentionsIn, type Mention, type MentionKind } from "@/lib/mentions";
import { trimUrl } from "@/lib/text-links";

export type ChatFormat = "plain" | "markdown";

export const CHAT_FORMATS: readonly ChatFormat[] = ["plain", "markdown"];

export type Inline =
  | { type: "text"; text: string }
  | { type: "mention"; mention: Mention }
  | { type: "code"; text: string }
  | { type: "url"; href: string; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "bold" | "italic" | "strike"; children: Inline[] };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "quote"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] };

export type MarkRange = { start: number; end: number };

type Marks = MarkRange[] | null;

const MENTION = /@\[([^\]\n]{1,200})\]\((contact|company|task|opportunity|proposal|member):([0-9a-f-]{36})\)/y;
const URL_AT = /https?:\/\/[^\s<>"]+/iy;
const LINK_AT = /\[([^[\]\n]{1,500})\]\(((?:https?:\/\/|mailto:)[^\s()<>"]+)\)/iy;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const FENCE = "```";
const LANGUAGE = /^[A-Za-z0-9+#.-]{1,20}$/;
const BULLET = /^([-*•])[ \t]+/;
const NUMBERED = /^(\d{1,9})[.)][ \t]+/;
const QUOTE = /^>(?:[ \t]|$)/;

function isWord(char: string | undefined) {
  return char !== undefined && WORD.test(char);
}

function isSpace(char: string | undefined) {
  return char === undefined || SPACE.test(char);
}

function stickyMatch(pattern: RegExp, src: string, at: number) {
  pattern.lastIndex = at;
  return pattern.exec(src);
}

function mentionAt(src: string, at: number, to: number) {
  const found = stickyMatch(MENTION, src, at);
  if (!found || at + found[0].length > to) return null;
  return { end: at + found[0].length, mention: { name: found[1], kind: found[2] as MentionKind, id: found[3] } };
}

function codeSpanAt(src: string, at: number, to: number) {
  const close = src.indexOf("`", at + 1);
  if (close <= at + 1 || close >= to) return -1;
  if (src.slice(at + 1, close).includes("\n")) return -1;
  return close;
}

function urlAt(src: string, at: number, from: number, to: number) {
  if (at > from && (isWord(src[at - 1]) || src[at - 1] === "/")) return null;
  const found = stickyMatch(URL_AT, src, at);
  if (!found) return null;
  const url = trimUrl(src.slice(at, Math.min(at + found[0].length, to)));
  if (!/^https?:\/\/./i.test(url)) return null;
  return url;
}

function markerAt(src: string, at: number) {
  if (src.startsWith("**", at)) return "**";
  if (src.startsWith("~~", at)) return "~~";
  if (src[at] === "*" || src[at] === "_") return src[at];
  return null;
}

function opens(src: string, at: number, from: number, marker: string) {
  const next = src[at + marker.length];
  if (isSpace(next)) return false;
  if (marker.length === 1 && (next === marker || (at > from && isWord(src[at - 1])))) return false;
  return true;
}

function closes(src: string, at: number, to: number, marker: string) {
  if (isSpace(src[at - 1])) return false;
  const after = at + marker.length < to ? src[at + marker.length] : undefined;
  if (marker.length === 1 && (isWord(after) || after === marker || src[at - 1] === marker)) return false;
  return true;
}

function findCloser(src: string, start: number, to: number, from: number, marker: string) {
  let at = start;
  while (at < to) {
    const char = src[at];
    if (char === "\n") return -1;
    if (char === "`") {
      const close = codeSpanAt(src, at, to);
      if (close > 0) {
        at = close + 1;
        continue;
      }
    }
    if (char === "@") {
      const mention = mentionAt(src, at, to);
      if (mention) {
        at = mention.end;
        continue;
      }
    }
    if (char === "h" || char === "H") {
      const url = urlAt(src, at, from, to);
      if (url) {
        at += url.length;
        continue;
      }
    }
    if (marker === "*" && src.startsWith("**", at)) {
      at += 2;
      continue;
    }
    if (src.startsWith(marker, at) && at > start && closes(src, at, to, marker)) return at;
    at += 1;
  }
  return -1;
}

const EMPHASIS: Record<string, "bold" | "italic" | "strike"> = { "**": "bold", "~~": "strike", "*": "italic", _: "italic" };

function parseInline(src: string, from: number, to: number, marks: Marks): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  let at = from;
  while (at < to) {
    const char = src[at];
    if (char === "@") {
      const mention = mentionAt(src, at, to);
      if (mention) {
        flush();
        out.push({ type: "mention", mention: mention.mention });
        at = mention.end;
        continue;
      }
    }
    if (char === "`") {
      const close = codeSpanAt(src, at, to);
      if (close > 0) {
        flush();
        out.push({ type: "code", text: src.slice(at + 1, close) });
        marks?.push({ start: at, end: at + 1 }, { start: close, end: close + 1 });
        at = close + 1;
        continue;
      }
    }
    if (char === "h" || char === "H") {
      const url = urlAt(src, at, from, to);
      if (url) {
        flush();
        out.push({ type: "url", href: url, text: url });
        at += url.length;
        continue;
      }
    }
    if (char === "[") {
      const link = stickyMatch(LINK_AT, src, at);
      if (link && at + link[0].length <= to) {
        flush();
        const labelEnd = at + 1 + link[1].length;
        out.push({ type: "link", href: link[2], children: parseInline(src, at + 1, labelEnd, marks) });
        marks?.push({ start: at, end: at + 1 }, { start: labelEnd, end: at + link[0].length });
        at += link[0].length;
        continue;
      }
    }
    const marker = markerAt(src, at);
    if (marker && opens(src, at, from, marker)) {
      const close = findCloser(src, at + marker.length, to, from, marker);
      if (close > 0) {
        flush();
        out.push({ type: EMPHASIS[marker], children: parseInline(src, at + marker.length, close, marks) });
        marks?.push({ start: at, end: at + marker.length }, { start: close, end: close + marker.length });
        at = close + marker.length;
        continue;
      }
    }
    text += char;
    at += 1;
  }
  flush();
  return out;
}

type Line = { start: number; end: number; text: string };

function splitLines(src: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const end = src.indexOf("\n", start);
    if (end < 0) {
      lines.push({ start, end: src.length, text: src.slice(start) });
      return lines;
    }
    lines.push({ start, end, text: src.slice(start, end) });
    start = end + 1;
  }
}

function fenceAt(src: string, start: number) {
  if (!src.startsWith(FENCE, start)) return null;
  let search = start + FENCE.length;
  for (;;) {
    const close = src.indexOf(FENCE, search);
    if (close < 0) return null;
    let after = close + FENCE.length;
    while (src[after] === "`") after += 1;
    const tail = src.indexOf("\n", after);
    const lineEnd = tail < 0 ? src.length : tail;
    if (src.slice(after, lineEnd).trim() === "") {
      const closeAt = after - FENCE.length;
      return { open: start, closeAt, end: lineEnd };
    }
    search = close + 1;
  }
}

function fenceText(src: string, open: number, closeAt: number, marks: Marks) {
  let from = open + FENCE.length;
  const newline = src.indexOf("\n", from);
  if (newline >= 0 && newline < closeAt) {
    const first = src.slice(from, newline).trim();
    if (first === "" || LANGUAGE.test(first)) {
      marks?.push({ start: from, end: newline });
      from = newline + 1;
    }
  }
  let to = closeAt;
  if (to > from && src[to - 1] === "\n") to -= 1;
  return src.slice(from, to);
}

function parseBlocks(src: string, marks: Marks): Block[] {
  const blocks: Block[] = [];
  const lines = splitLines(src);
  let paragraph: Line[] = [];
  const flushParagraph = () => {
    while (paragraph.length && paragraph[0].text.trim() === "") paragraph.shift();
    while (paragraph.length && paragraph[paragraph.length - 1].text.trim() === "") paragraph.pop();
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(src, paragraph[0].start, paragraph[paragraph.length - 1].end, marks) });
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = fenceAt(src, line.start);
    if (fence) {
      flushParagraph();
      marks?.push({ start: fence.open, end: fence.open + FENCE.length }, { start: fence.closeAt, end: fence.closeAt + FENCE.length });
      blocks.push({ type: "code", text: fenceText(src, fence.open, fence.closeAt, marks) });
      while (index < lines.length && lines[index].start <= fence.end) index += 1;
      continue;
    }
    if (QUOTE.test(line.text)) {
      flushParagraph();
      const children: Inline[] = [];
      while (index < lines.length && QUOTE.test(lines[index].text) && !src.startsWith(FENCE, lines[index].start)) {
        const current = lines[index];
        const prefix = QUOTE.exec(current.text)![0].length;
        marks?.push({ start: current.start, end: current.start + 1 });
        if (children.length) children.push({ type: "text", text: "\n" });
        children.push(...parseInline(src, current.start + prefix, current.end, marks));
        index += 1;
      }
      blocks.push({ type: "quote", children });
      continue;
    }
    const bullet = BULLET.exec(line.text);
    const numbered = bullet ? null : NUMBERED.exec(line.text);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: Inline[][] = [];
      const start = numbered ? Number(numbered[1]) : 1;
      while (index < lines.length) {
        const found = pattern.exec(lines[index].text);
        if (!found) break;
        items.push(parseInline(src, lines[index].start + found[0].length, lines[index].end, marks));
        index += 1;
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src, null);
}

export function markdownMarks(src: string): MarkRange[] {
  const marks: MarkRange[] = [];
  parseBlocks(src, marks);
  return marks.filter((mark) => mark.end > mark.start).sort((left, right) => left.start - right.start);
}

function inlineMentions(nodes: Inline[], found: Mention[]) {
  for (const node of nodes) {
    if (node.type === "mention") found.push(node.mention);
    else if (node.type === "bold" || node.type === "italic" || node.type === "strike" || node.type === "link") inlineMentions(node.children, found);
  }
}

export function formatMentions(body: string, format: ChatFormat): Mention[] {
  if (format !== "markdown") return mentionsIn(body);
  const found: Mention[] = [];
  for (const block of parseMarkdown(body)) {
    if (block.type === "paragraph" || block.type === "quote") inlineMentions(block.children, found);
    else if (block.type === "list") for (const item of block.items) inlineMentions(item, found);
  }
  return found;
}

export function cleanFormat(value: unknown, fallback: ChatFormat = "plain"): ChatFormat {
  return value === "markdown" || value === "plain" ? value : fallback;
}

export function insideCodeFence(text: string, caret: number) {
  let count = 0;
  let at = text.indexOf(FENCE);
  while (at >= 0 && at < caret) {
    count += 1;
    at = text.indexOf(FENCE, at + FENCE.length);
  }
  return count % 2 === 1;
}
