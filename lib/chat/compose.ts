export type TextEdit = { start: number; end: number; text: string; selectionStart: number; selectionEnd: number };

export type FormatAction = "bold" | "italic" | "strike" | "link" | "bullets" | "numbers" | "code" | "codeBlock" | "quote";

const MARKERS: Partial<Record<FormatAction, string>> = { bold: "**", italic: "_", strike: "~~", code: "`" };

function trimmed(value: string, start: number, end: number) {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(value[from])) from += 1;
  while (to > from && /\s/.test(value[to - 1])) to -= 1;
  return from < to ? { from, to } : { from: start, to: end };
}

function wrap(value: string, start: number, end: number, marker: string): TextEdit {
  const { from, to } = trimmed(value, start, end);
  const size = marker.length;
  const selected = value.slice(from, to);
  if (selected.length > size * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(size, -size);
    return { start: from, end: to, text: inner, selectionStart: from, selectionEnd: from + inner.length };
  }
  if (value.slice(from - size, from) === marker && value.slice(to, to + size) === marker && from - size >= 0) {
    return { start: from - size, end: to + size, text: selected, selectionStart: from - size, selectionEnd: from - size + selected.length };
  }
  return { start: from, end: to, text: `${marker}${selected}${marker}`, selectionStart: from + size, selectionEnd: to + size };
}

function link(value: string, start: number, end: number): TextEdit {
  const { from, to } = trimmed(value, start, end);
  const selected = value.slice(from, to);
  if (/^(?:https?:\/\/|mailto:)\S+$/i.test(selected)) {
    return { start: from, end: to, text: `[](${selected})`, selectionStart: from + 1, selectionEnd: from + 1 };
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
    const caret = from + text.length;
    return { start: from, end: to, text, selectionStart: caret, selectionEnd: caret };
  }
  return { start: from, end: to, text, selectionStart: from, selectionEnd: from + text.length };
}

function codeBlock(value: string, start: number, end: number): TextEdit {
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
  const space = start > 0 && !/\s/.test(value[start - 1]) ? " " : "";
  const text = `${space}@`;
  const caret = start + text.length;
  return { start, end, text, selectionStart: caret, selectionEnd: caret };
}

export function applyEdit(value: string, edit: TextEdit) {
  return `${value.slice(0, edit.start)}${edit.text}${value.slice(edit.end)}`;
}
