import { randomBytes } from "node:crypto";

export function untrustedToken() {
  return randomBytes(6).toString("hex");
}

const FORGED_MARKER = /<<\s*\/?\s*untrusted\b[^>]*>>/gi;
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
const ORBIT_KEYS = new Set(["notice", "note", "error", "warning", "hint", "href", "url", "link", "id", "type", "kind", "status", "role", "scope", "field", "source", "workspace"]);
const ORBIT_SUFFIX = /(?:Id|Ids|Url|Href|At|Note|Notice)$/;
const LONG_TEXT = 160;

export function fenceText(text: string, token: string) {
  return `<<untrusted-${token}>>${text.replace(FORGED_MARKER, "[marker removed]")}<</untrusted-${token}>>`;
}

function orbitKey(key: string) {
  return ORBIT_KEYS.has(key) || ORBIT_SUFFIX.test(key);
}

function fenced(value: string, key: string | null) {
  if (!/\s/.test(value.trim())) return false;
  if (/^https?:\/\/\S+$/.test(value.trim())) return false;
  return (key !== null && TEXT_KEYS.has(key)) || value.length >= LONG_TEXT;
}

function walk(value: unknown, token: string, key: string | null): unknown {
  if (typeof value === "string") return fenced(value, key) ? fenceText(value, token) : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, token, key));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, orbitKey(name) ? item : walk(item, token, name)]));
}

export function fenceUntrusted(output: unknown, token: string) {
  return walk(output, token, null);
}
