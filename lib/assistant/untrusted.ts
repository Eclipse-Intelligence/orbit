import { randomBytes } from "node:crypto";

export function untrustedToken() {
  return randomBytes(6).toString("hex");
}

const FORGED_MARKER = /<<\s*\/?\s*untrusted\b[^>]*>>/gi;
const OUR_MARKER = /<<\/?untrusted-[0-9a-f]{12}>>/g;
const TEXT_KEYS = new Set([
  "text",
  "body",
  "content",
  "snippet",
  "summary",
  "description",
  "notes",
  "transcript",
  "markdown",
  "excerpt",
  "excerpts",
  "passage",
  "passages",
  "preview",
  "highlight",
  "highlights",
  "subject",
  "title",
  "headline",
  "about",
  "comment",
  "comments",
  "answer",
  "reason",
  "detail",
  "details",
  "message",
  "quote",
  "chunk",
  "chunks",
  "guide",
  "index",
  "result",
  "results",
  "posts",
  "keyPoints",
  "actionItems",
  "signature",
]);
const NAME_KEYS = new Set([
  "name",
  "names",
  "fromName",
  "senderName",
  "displayName",
  "firstName",
  "lastName",
  "fullName",
  "location",
  "company",
  "companyName",
  "contactName",
  "jobTitle",
  "organizer",
  "organiser",
  "industry",
  "tags",
  "labels",
  "hashtags",
]);
const ORBIT_KEYS = new Set(["notice", "note", "error", "warning", "hint", "href", "url", "link", "id", "type", "kind", "status", "role", "scope", "field", "source", "workspace"]);
const ORBIT_SUFFIX = /(?:Id|Ids|Url|Href|At|Note|Notice)$/;
const LONG_TEXT = 160;
const PLAIN_VALUE = /^(?:https?:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[\d\s.,:+\-/%£$€]*)$/i;

export function fenceText(text: string, token: string) {
  return `<<untrusted-${token}>>${text.replace(FORGED_MARKER, "[marker removed]")}<</untrusted-${token}>>`;
}

export function withoutMarkers<T>(value: T): T {
  if (typeof value === "string") return value.replace(OUR_MARKER, "") as T;
  if (Array.isArray(value)) return value.map((item) => withoutMarkers(item)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, withoutMarkers(item)])) as T;
}

function orbitKey(key: string | null) {
  return key !== null && (ORBIT_KEYS.has(key) || ORBIT_SUFFIX.test(key));
}

function fenced(value: string, key: string | null) {
  const trimmed = value.trim();
  if (!trimmed || orbitKey(key) || PLAIN_VALUE.test(trimmed)) return false;
  if (key !== null && NAME_KEYS.has(key)) return true;
  if (!/\s/.test(trimmed)) return false;
  return (key !== null && TEXT_KEYS.has(key)) || value.length >= LONG_TEXT;
}

function walk(value: unknown, token: string, key: string | null, own: ReadonlySet<string>): unknown {
  if (typeof value === "string") return fenced(value, key) ? fenceText(value, token) : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, token, key, own));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, own.has(name) ? item : walk(item, token, name, own)]));
}

export function fenceUntrusted(output: unknown, token: string, own: ReadonlySet<string> = new Set()) {
  return walk(output, token, null, own);
}
