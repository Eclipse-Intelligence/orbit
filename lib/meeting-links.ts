import { htmlToText } from "@/lib/mail/text";
import { URL_IN_TEXT } from "@/lib/text-links";

type Provider = { host: RegExp; path: RegExp };

const ANY_ROOM = /^\/[^/]/;

const PROVIDERS: Provider[] = [
  { host: /^teams\.(microsoft\.com|live\.com|cloud\.microsoft)$/, path: /^\/(l\/meetup-join|meet|v2|dl\/launcher)\b/i },
  { host: /(^|\.)zoom(gov)?\.(us|com)$/, path: /^\/(j|my|w|wc)\//i },
  { host: /^meet\.google\.com$/, path: ANY_ROOM },
  { host: /(^|\.)whereby\.com$/, path: ANY_ROOM },
  { host: /(^|\.)webex\.com$/, path: /(\/j\.php|\/meet\/|\/join\/|\/wbxmjs\/joinservice\/)/i },
  { host: /^(meet\.goto\.com|gotomeet\.me|(global|app|www)\.gotomeeting\.com)$/, path: ANY_ROOM },
  { host: /^(meet\.jit\.si|8x8\.vc)$/, path: ANY_ROOM },
  { host: /(^|\.)around\.co$/, path: ANY_ROOM },
  { host: /(^|\.)chime\.aws$/, path: ANY_ROOM },
];

const SAFE_LINKS = /(^|\.)safelinks\.protection\.outlook\.com$/i;
const URL_MAX = 2000;

function parse(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function unwrapSafeLink(value: string) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const url = parse(current);
    if (!url || !SAFE_LINKS.test(url.hostname)) return current;
    const inner = url.searchParams.get("url");
    if (!inner) return current;
    current = inner;
  }
  return current;
}

export function safeUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const url = parse(unwrapSafeLink(trimmed));
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const text = url.toString();
  return text.length > URL_MAX ? null : text;
}

function ownPrefix(own: string | null | undefined) {
  const url = parse(own?.trim() ?? "");
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  return `${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
}

function recognised(url: URL, own: string | null) {
  if (own) {
    const here = `${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
    if (here === own || here.startsWith(`${own}/`)) return true;
  }
  const host = url.hostname.toLowerCase();
  return PROVIDERS.some((provider) => provider.host.test(host) && provider.path.test(url.pathname));
}

export function findMeetingLink(texts: (string | null | undefined)[], options: { own?: string | null } = {}) {
  const own = ownPrefix(options.own);
  for (const text of texts) {
    for (const match of text?.matchAll(URL_IN_TEXT) ?? []) {
      const candidate = safeUrl(match[0]);
      const url = candidate ? parse(candidate) : null;
      if (!url || !recognised(url, own)) continue;
      url.protocol = "https:";
      return url.toString();
    }
  }
  return null;
}

export function meetingLink(...texts: (string | null | undefined)[]) {
  return findMeetingLink(texts);
}

export function joinLink(input: {
  provided?: (string | null | undefined)[];
  location?: string | null;
  notes?: string | null;
  own?: string | null;
}) {
  for (const value of input.provided ?? []) {
    const url = safeUrl(value);
    if (url) return url;
  }
  return findMeetingLink([input.location, input.notes], { own: input.own });
}

export function unwrapSafeLinksIn(text: string) {
  return text.replace(URL_IN_TEXT, (match) => {
    const url = parse(match);
    if (!url || !SAFE_LINKS.test(url.hostname)) return match;
    return safeUrl(match) ?? match;
  });
}

export const NOTES_MAX = 8000;

const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
const LOOKS_HTML = /<(a|br|p|div|span|b|i|u|ul|ol|li|table|html|body)\b[^>]*>/i;

function linksAsText(html: string) {
  return html.replace(ANCHOR, (whole, _quote: string, href: string, label: string) => {
    const target = href.trim();
    if (!/^https?:\/\//i.test(target)) return whole;
    const shown = htmlToText(label);
    return shown && shown !== htmlToText(target) ? `${label} &lt;${target}&gt;` : target;
  });
}

export function eventBodyText(content: string | null | undefined, kind: "html" | "text" | "auto" = "auto") {
  if (!content?.trim()) return null;
  const html = kind === "html" || (kind === "auto" && LOOKS_HTML.test(content));
  const text = html ? htmlToText(linksAsText(content)) : content;
  const cleaned = unwrapSafeLinksIn(
    text
      .replace(/\r\n?/g, "\n")
      .replace(/(?![\n\t])\p{Cc}/gu, "")
      .replace(/[ \t ]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  return cleaned || null;
}

export function clipNotes(text: string | null) {
  if (!text) return null;
  if (text.length <= NOTES_MAX) return text;
  return `${text.slice(0, NOTES_MAX - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
}
