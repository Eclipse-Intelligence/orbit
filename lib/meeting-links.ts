import { decodeEntities } from "@/lib/mail/text";
import { URL_IN_TEXT } from "@/lib/text-links";

const ANY_URL = new RegExp(URL_IN_TEXT.source, "gi");
const URL_MAX = 2000;
export const BODY_SCAN_MAX = 200_000;
export const NOTES_MAX = 8000;

const NOT_ROOMS = new Set([
  "about",
  "account",
  "apps",
  "blog",
  "contact",
  "download",
  "downloads",
  "features",
  "help",
  "home",
  "information",
  "install",
  "integrations",
  "legal",
  "login",
  "meet-now",
  "org",
  "pricing",
  "privacy",
  "settings",
  "signin",
  "signup",
  "static",
  "support",
  "tel",
  "terms",
  "tos",
  "user",
]);

type Room = (segments: string[], url: URL) => boolean;

const room = (segment: string | undefined) => Boolean(segment) && !NOT_ROOMS.has(segment!.toLowerCase());
const oneRoom = (segments: string[]) => segments.length === 1 && room(segments[0]);

const PROVIDERS: { host: RegExp; room: Room }[] = [
  {
    host: /^teams\.(microsoft\.com|live\.com|cloud\.microsoft)$/,
    room: (segments, url) =>
      (segments[0] === "l" && segments[1] === "meetup-join" && segments.length > 2) ||
      (segments[0] === "meet" && room(segments[1])) ||
      (segments[0] === "dl" && segments[1] === "launcher" && /meetup-join/i.test(decoded(url.search))),
  },
  { host: /(^|\.)zoom(gov)?\.(us|com)$/, room: (segments) => ["j", "my", "w", "wc"].includes(segments[0]) && room(segments[1]) },
  { host: /^meet\.google\.com$/, room: (segments) => /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(segments[0] ?? "") || (segments[0] === "lookup" && room(segments[1])) },
  { host: /(^|\.)whereby\.com$/, room: oneRoom },
  {
    host: /(^|\.)webex\.com$/,
    room: (segments, url) =>
      !/^(help|www)\./i.test(url.hostname) &&
      (segments.includes("j.php") ||
        (["meet", "join"].includes(segments.at(-2) ?? "") && room(segments.at(-1))) ||
        (segments[0] === "wbxmjs" && segments[1] === "joinservice")),
  },
  { host: /^meet\.goto\.com$/, room: (segments) => oneRoom(segments) },
  { host: /(^|\.)gotomeeting\.com$/, room: (segments) => segments[0] === "join" && room(segments[1]) },
  { host: /(^|\.)gotomeet\.me$/, room: oneRoom },
  { host: /^meet\.jit\.si$/, room: oneRoom },
  { host: /^8x8\.vc$/, room: (segments) => segments.length >= 1 && segments.length <= 2 && segments.every(room) },
  { host: /(^|\.)around\.co$/, room: (segments) => (segments[0] === "r" && room(segments[1])) || oneRoom(segments) },
  { host: /(^|\.)chime\.aws$/, room: (segments) => /^\d{10}$/.test(segments[0] ?? "") || (segments[0] === "meetings" && room(segments[1])) },
];

function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parse(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function param(url: URL, name: string) {
  for (const [key, value] of new URLSearchParams(url.search.replace(/&amp;/gi, "&"))) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

function unwrapOnce(url: URL) {
  const host = url.hostname.toLowerCase();
  if (/(^|\.)safelinks\.protection\.outlook\.com$/.test(host)) return param(url, "url");
  if (/^(www\.)?google\.[a-z.]+$/.test(host) && url.pathname === "/url") return param(url, "q") ?? param(url, "url");
  if (host === "urldefense.com" || host === "urldefense.proofpoint.com") {
    const wrapped = /^\/v3\/__(.+?)__;/.exec(url.pathname + url.search);
    if (wrapped) return wrapped[1];
    return param(url, "u")?.replace(/-/g, "%").replace(/_/g, "/") ?? null;
  }
  return null;
}

export function unwrapSafeLink(value: string) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const url = parse(current);
    const inner = url ? unwrapOnce(url) : null;
    if (!inner) return current;
    current = inner.startsWith("http") || !/%3a/i.test(inner) ? inner : decoded(inner);
  }
  return current;
}

function web(url: URL | null) {
  return url !== null && (url.protocol === "https:" || url.protocol === "http:");
}

export function safeUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const url = parse(unwrapSafeLink(trimmed));
  if (!url || !web(url)) return null;
  const text = url.toString();
  return text.length > URL_MAX ? null : text;
}

type Own = { host: string; path: string; search: string };

function ownLink(own: string | null | undefined): Own | null {
  const url = parse(own?.trim() ?? "");
  if (!url || !web(url)) return null;
  return { host: url.host.toLowerCase(), path: url.pathname.replace(/\/+$/, "").toLowerCase(), search: url.search };
}

function isOwn(url: URL, own: Own | null) {
  if (!own || url.host.toLowerCase() !== own.host) return false;
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  if (own.search && url.search !== own.search) return false;
  if (!own.path) return path === "";
  return path === own.path || path.startsWith(`${own.path}/`);
}

function recognised(url: URL, own: Own | null) {
  if (isOwn(url, own)) return true;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
  return PROVIDERS.some((provider) => provider.host.test(host) && provider.room(segments, url));
}

function candidateText(match: string) {
  const markdown = match.indexOf("](");
  return markdown > 0 ? match.slice(0, markdown) : match;
}

export function findMeetingLink(texts: (string | null | undefined)[], options: { own?: string | null } = {}) {
  const own = ownLink(options.own);
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.slice(0, BODY_SCAN_MAX).matchAll(ANY_URL)) {
      const raw = candidateText(match[0]);
      const unwrapped = unwrapSafeLink(`${raw.slice(0, raw.indexOf(":")).toLowerCase()}${raw.slice(raw.indexOf(":"))}`);
      const url = parse(unwrapped);
      if (!url || !web(url) || !recognised(url, own)) continue;
      url.protocol = "https:";
      const link = url.toString();
      if (link.length <= URL_MAX) return link;
    }
  }
  return null;
}

export function meetingLink(...texts: (string | null | undefined)[]) {
  return findMeetingLink(texts);
}

export type JoinLink = { url: string; source: "provider" | "location" | "notes" };

export function joinLink(input: {
  provided?: (string | null | undefined)[];
  location?: string | null;
  notes?: string | null;
  own?: string | null;
}): JoinLink | null {
  for (const value of input.provided ?? []) {
    const url = safeUrl(value);
    if (url) return { url, source: "provider" };
  }
  const fromLocation = findMeetingLink([input.location], { own: input.own });
  if (fromLocation) return { url: fromLocation, source: "location" };
  const fromNotes = findMeetingLink([input.notes], { own: input.own });
  return fromNotes ? { url: fromNotes, source: "notes" } : null;
}

export function unwrapSafeLinksIn(text: string) {
  return text.replace(URL_IN_TEXT, (match) => {
    const url = parse(match);
    if (!url || !unwrapOnce(url)) return match;
    return safeUrl(match) ?? match;
  });
}

const TAG_NAME = /^(\/?)([a-z][a-z0-9]{0,15})(?=[\s/>]|$)/i;
const HREF = /\bhref\s*=\s*(?:"([^"]{0,2000})"|'([^']{0,2000})'|([^\s"'>]{1,2000}))/i;
const SKIPPED = new Set(["head", "style", "script", "title", "noscript", "template"]);
const LINE_BREAKS = new Set(["br"]);
const BLOCKS = new Set(["p", "div", "li", "tr", "table", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "section", "article", "header", "footer"]);
const INLINE = new Set(["a", "b", "i", "u", "s", "em", "strong", "span", "font", "small", "big", "sub", "sup", "code", "mark", "abbr"]);
const TAG_MAX = 4000;
const LOOKS_HTML = /<(br|p|div)\s*\/?>|<\/(a|p|div|span|b|i|u|li|ul|ol|table|td|tr|body|html|font|strong|em)\s*>|<a\s[^<>]{0,2000}\bhref\s*=/i;

export function htmlBodyText(html: string) {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let length = 0;
  let tail = "\n";
  const push = (text: string) => {
    parts.push(text);
    length += text.length;
    if (text) tail = text[text.length - 1];
  };
  let anchor: { href: string; start: number; startLength: number } | null = null;
  let index = 0;
  let close = -1;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) {
      push(html.slice(index));
      break;
    }
    push(html.slice(index, open));
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end < 0) break;
      index = end + 3;
      continue;
    }
    if (close <= open) close = html.indexOf(">", open + 1);
    if (close < 0) {
      push(html.slice(open));
      break;
    }
    const name = close - open > TAG_MAX ? null : TAG_NAME.exec(html.slice(open + 1, open + 20));
    if (!name) {
      push("<");
      index = open + 1;
      continue;
    }
    const inside = html.slice(open + 1, close);
    index = close + 1;
    const tag = name[2].toLowerCase();
    const closing = name[1] === "/";
    if (!closing && SKIPPED.has(tag)) {
      const end = lower.indexOf(`</${tag}`, index);
      if (end < 0) break;
      const after = html.indexOf(">", end);
      if (after < 0) break;
      index = after + 1;
      continue;
    }
    if (tag === "a") {
      if (!closing) {
        const found = HREF.exec(inside);
        const href = decodeEntities(found?.[1] ?? found?.[2] ?? found?.[3] ?? "").trim();
        anchor = /^https?:\/\//i.test(href) ? { href, start: parts.length, startLength: length } : null;
      } else if (anchor) {
        const label = decodeEntities(parts.slice(anchor.start).join("")).replace(/\s+/g, " ").trim();
        if (!label || label === anchor.href) {
          parts.length = anchor.start;
          length = anchor.startLength;
          tail = parts.at(-1)?.at(-1) ?? "\n";
          push(anchor.href.replace(/&/g, "&amp;"));
        } else {
          push(` &lt;${anchor.href.replace(/&/g, "&amp;")}&gt;`);
        }
        anchor = null;
      }
      continue;
    }
    if (LINE_BREAKS.has(tag)) push("\n");
    else if (tag === "li" && !closing) push(tail === "\n" ? "- " : "\n- ");
    else if (BLOCKS.has(tag)) {
      if (closing || tail !== "\n") push("\n");
    }
    else if (!INLINE.has(tag)) push(" ");
  }
  return decodeEntities(parts.join(""));
}

function tidy(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[‪-‮⁦-⁩‎‏]/g, "")
    .replace(/(?![\n\t])\p{Cc}/gu, "")
    .split("\n")
    .map((line) => line.replace(/ /g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function eventBodyText(content: string | null | undefined, kind: "html" | "text" | "auto" = "auto") {
  if (!content?.trim()) return null;
  const bounded = content.slice(0, BODY_SCAN_MAX);
  const html = kind === "html" || (kind === "auto" && LOOKS_HTML.test(bounded));
  const cleaned = unwrapSafeLinksIn(tidy(html ? htmlBodyText(bounded) : bounded));
  return cleaned || null;
}

export function clipNotes(text: string | null) {
  if (!text) return null;
  if (text.length <= NOTES_MAX) return text;
  return `${text.slice(0, NOTES_MAX - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
}
