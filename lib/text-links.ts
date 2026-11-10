export const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"]+[^\s<>"'.,;:!?)\]]/g;
const EMAIL_IN_TEXT = /[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;

export type TextPart =
  | { kind: "text"; text: string }
  | { kind: "url"; text: string; href: string }
  | { kind: "email"; text: string; href: string };

function splitEmails(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(EMAIL_IN_TEXT)) {
    const address = match[0].replace(/^[.+-]+/, "");
    const start = match.index + match[0].length - address.length;
    if (start > last) parts.push({ kind: "text", text: text.slice(last, start) });
    parts.push({ kind: "email", text: address, href: `mailto:${address}` });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

export function textParts(text: string, options: { emails?: boolean } = {}): TextPart[] {
  const plain = (value: string): TextPart[] =>
    value ? (options.emails ? splitEmails(value) : [{ kind: "text", text: value }]) : [];
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    parts.push(...plain(text.slice(last, match.index)));
    parts.push({ kind: "url", text: match[0], href: match[0] });
    last = match.index + match[0].length;
  }
  parts.push(...plain(text.slice(last)));
  return parts;
}
