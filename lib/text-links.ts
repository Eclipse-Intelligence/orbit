export const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"]+[^\s<>"'.,;:!?)\]]/g;
const EMAIL_IN_TEXT = /[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;

export type TextPart =
  | { kind: "text"; text: string }
  | { kind: "url"; text: string; href: string }
  | { kind: "email"; text: string; href: string };

type Options = { emails?: boolean; markdown?: boolean; balanced?: boolean };

const LOOSE_URL = /\bhttps?:\/\/[^\s<>"]+/gi;
const TRAILING = /[.,;:!?'"\u2018\u2019\u201c\u201d]$/;

function count(text: string, char: string) {
  return text.split(char).length - 1;
}

export function trimUrl(url: string) {
  let value = url;
  for (;;) {
    if (TRAILING.test(value)) value = value.slice(0, -1);
    else if (value.endsWith(")") && count(value, ")") > count(value, "(")) value = value.slice(0, -1);
    else if (value.endsWith("]") && count(value, "]") > count(value, "[")) value = value.slice(0, -1);
    else return value;
  }
}

const INVISIBLE_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function withoutBidi(text: string) {
  return text.replace(INVISIBLE_CONTROLS, "");
}

function splitEmails(text: string): TextPart[] {
  if (!text.includes("@")) return [{ kind: "text", text }];
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

export function textParts(text: string, options: Options = {}): TextPart[] {
  const plain = (value: string): TextPart[] =>
    value ? (options.emails ? splitEmails(value) : [{ kind: "text", text: value }]) : [];
  const parts: TextPart[] = [];
  let last = 0;
  for (const found of text.matchAll(options.balanced ? LOOSE_URL : URL_IN_TEXT)) {
    const whole = options.balanced ? trimUrl(found[0]) : found[0];
    if (!/^https?:\/\/./i.test(whole)) continue;
    parts.push(...plain(text.slice(last, found.index)));
    const cut = options.markdown ? whole.indexOf("](") : -1;
    if (cut > 0) {
      const url = whole.slice(0, cut);
      parts.push({ kind: "url", text: url, href: url });
      parts.push({ kind: "text", text: "](" });
      parts.push(...textParts(whole.slice(cut + 2), options));
    } else {
      parts.push({ kind: "url", text: whole, href: whole });
    }
    last = found.index + whole.length;
  }
  parts.push(...plain(text.slice(last)));
  return parts;
}
