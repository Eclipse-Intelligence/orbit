export type FormatSpan =
  | { kind: "bold" | "italic"; from: number; to: number; inner: [number, number]; spans: FormatSpan[] }
  | { kind: "link"; from: number; to: number; inner: [number, number]; href: string; external: boolean };

const EMPHASIS = /\*\*([^*\n]+?)\*\*|(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g;
const HEADING = /^(#{1,6}\s+)(?=\S)/;

export function headingMarker(line: string) {
  return HEADING.exec(line)?.[1].length ?? 0;
}

export function formatSpans(line: string, offset = 0): FormatSpan[] {
  const spans: FormatSpan[] = [];
  for (const match of line.matchAll(EMPHASIS)) {
    const from = offset + (match.index ?? 0);
    const to = from + match[0].length;
    if (match[1] !== undefined) {
      spans.push({ kind: "bold", from, to, inner: [from + 2, to - 2], spans: formatSpans(match[1], from + 2) });
    } else if (match[2] !== undefined) {
      spans.push({ kind: "italic", from, to, inner: [from + 1, to - 1], spans: formatSpans(match[2], from + 1) });
    } else {
      const labelEnd = from + 1 + match[3].length;
      spans.push({ kind: "link", from, to, inner: [from + 1, labelEnd], href: match[4], external: /^https?:\/\//.test(match[4]) });
    }
  }
  return spans;
}
