export type FormatSpan =
  | { kind: "bold" | "italic"; from: number; to: number; inner: [number, number]; spans: FormatSpan[] }
  | { kind: "link"; from: number; to: number; inner: [number, number]; href: string; external: boolean };

const EMPHASIS = /\*\*\*([^*\n]+?)\*\*\*|\*\*((?:[^*\n]|\*(?!\*))+?)\*\*|(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g;
const HEADING = /^(#{1,6}\s+)(?=\S)/;

export function headingMarker(line: string) {
  return HEADING.exec(line)?.[1].length ?? 0;
}

export function formatSpans(line: string, offset = 0): FormatSpan[] {
  const spans: FormatSpan[] = [];
  for (const match of line.matchAll(EMPHASIS)) {
    const from = offset + (match.index ?? 0);
    const to = from + match[0].length;
    const bold = match[1] !== undefined ? `*${match[1]}*` : match[2];
    if (bold !== undefined) {
      spans.push({ kind: "bold", from, to, inner: [from + 2, to - 2], spans: formatSpans(bold, from + 2) });
    } else if (match[3] !== undefined) {
      spans.push({ kind: "italic", from, to, inner: [from + 1, to - 1], spans: formatSpans(match[3], from + 1) });
    } else {
      const labelEnd = from + 1 + match[4].length;
      spans.push({ kind: "link", from, to, inner: [from + 1, labelEnd], href: match[5], external: /^https?:\/\//.test(match[5]) });
    }
  }
  return spans;
}
