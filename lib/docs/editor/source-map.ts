import { flattenText, type FlatText } from "@/lib/docs/comment-anchor";
import { staticSourceBlocks } from "@/lib/docs/editor/static";

export type SourceSpan = { from: number; to: number };

export type SourceMap = { flat: FlatText; chars: (SourceSpan | null)[] };

function charsOf(text: string, from: number, cell: boolean) {
  const chars: SourceSpan[] = [];
  const out: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (cell && text[index] === "\\" && text[index + 1] === "|") {
      out.push("|");
      chars.push({ from: from + index, to: from + index + 2 });
      index += 1;
      continue;
    }
    out.push(text[index]);
    chars.push({ from: from + index, to: from + index + 1 });
  }
  return { text: out.join(""), chars };
}

export function sourceMap(body: string): SourceMap {
  const segments: { key: number; text: string }[] = [];
  const pieces: SourceSpan[][] = [];
  staticSourceBlocks(body).forEach((block, key) => {
    for (const range of block.ranges) {
      const segment = range.segment;
      if ("text" in segment) {
        const made = charsOf(segment.text, range.from, block.cell);
        if (made.text.length === 0) continue;
        segments.push({ key, text: made.text });
        pieces.push(made.chars);
        continue;
      }
      const widget = segment.widget;
      const label = widget.kind === "mention" ? widget.name : widget.kind === "entry" ? widget.time : "";
      if (!label) continue;
      segments.push({ key, text: label });
      pieces.push(Array.from({ length: label.length }, () => ({ from: range.from, to: range.to })));
    }
  });
  const flat = flattenText(segments);
  const chars: (SourceSpan | null)[] = new Array(flat.text.length).fill(null);
  flat.spans.forEach((span, index) => {
    pieces[index].forEach((char, offset) => {
      chars[span.start + offset] = char;
    });
  });
  return { flat, chars };
}

export function sourceRange(map: SourceMap, start: number, end: number): SourceSpan | null {
  let first: SourceSpan | null = null;
  let last: SourceSpan | null = null;
  for (let index = Math.max(0, start); index < Math.min(end, map.chars.length); index += 1) {
    const char = map.chars[index];
    if (!char) continue;
    first ??= char;
    last = char;
  }
  return first && last ? { from: first.from, to: last.to } : null;
}

export function renderedText(body: string) {
  return sourceMap(body).flat.text;
}
