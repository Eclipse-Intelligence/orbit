import { formatSpans, headingMarker, type FormatSpan } from "@/lib/mail/inline-format";
import { textParts } from "@/lib/text-links";

const BLOCKED_BLOCKS = /<(script|iframe|object|frameset|applet|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCKED_TAGS = /<\/?(script|iframe|object|embed|form|frameset|frame|applet|base|link|noscript|animate|animatemotion|animatetransform|set|discard)\b(?:"[^"]*"|'[^']*'|[^>])*(?:>|$)/gi;
const META_TAGS = /<\/?meta\b(?:"[^"]*"|'[^']*'|[^>])*(?:>|$)/gi;
const EVENT_ATTRIBUTES = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const URL_ATTRIBUTES = /\s(href|src|action|formaction|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi;
const NAMED_ENTITIES: Record<string, string> = { colon: ":", tab: "", newline: "", nbsp: "", lpar: "(", rpar: ")" };
const CID_IMAGES = /<img\b[^>]*\bsrc\s*=\s*["']?cid:[^>]*>/gi;
const TRACKERS = /<img\b[^>]*\/api\/mail\/open\/[^>]*>/gi;
const TRACKING_ID = /\/api\/mail\/open\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export const TRACKING_PATH = "/api/mail/open/";

function stripTrackers(html: string) {
  return html.replace(TRACKERS, "");
}

export function trackingPixelUrl(origin: string | null | undefined, trackingId: string | null | undefined) {
  return origin && trackingId ? `${origin}${TRACKING_PATH}${trackingId}` : null;
}

export function trackingIdIn(html: string | null | undefined) {
  return html?.match(TRACKING_ID)?.[1]?.toLowerCase() ?? null;
}

const LINK_TAGS = /<(a|area)\b((?:"[^"]*"|'[^']*'|[^>])*)(?:>|$)/gi;
const ATTRIBUTE = /\s+([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

export function openLinksInNewTab(html: string) {
  return html.replace(LINK_TAGS, (_tag, name: string, attributes: string) => {
    const kept = [...attributes.matchAll(ATTRIBUTE)].filter((match) => match[1].toLowerCase() !== "target").map((match) => match[0]);
    return `<${name}${kept.join("")} target="_blank">`;
  });
}

function decodedUrl(value: string) {
  const bare = value.replace(/^["']|["']$/g, "");
  return bare
    .replace(/&#x([0-9a-f]+);?/gi, (_all, code: string) => String.fromCodePoint(Math.min(parseInt(code, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_all, code: string) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
    .replace(/&([a-z]+);?/gi, (all, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? all)
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, "")
    .toLowerCase();
}

function stripScriptUrls(html: string) {
  return html.replace(URL_ATTRIBUTES, (attribute: string, _name: string, value: string) =>
    /^(javascript|vbscript|data:text\/html)/.test(decodedUrl(value)) ? "" : attribute,
  );
}

export function cleanEmailHtml(html: string) {
  return openLinksInNewTab(
    stripScriptUrls(
      stripTrackers(html)
        .replace(BLOCKED_BLOCKS, "")
        .replace(BLOCKED_TAGS, "")
        .replace(META_TAGS, "")
        .replace(EVENT_ATTRIBUTES, ""),
    ).replace(CID_IMAGES, ""),
  );
}

export function richEmail(html: string) {
  return /bgcolor\s*=|background(-color|-image)?\s*:|<table\b[^>]*(width|style)\s*=/i.test(html);
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function linkify(text: string) {
  return textParts(text)
    .map((part) => (part.kind === "text" ? escapeHtml(part.text) : `<a href="${escapeHtml(part.href)}">${escapeHtml(part.text)}</a>`))
    .join("");
}

const IMAGE_MARKER = /\[Image: ([^\]\n]{1,200})\]/g;

export function imageMarkers(text: string) {
  return [...new Set([...text.matchAll(IMAGE_MARKER)].map((match) => match[1].trim()))];
}

function placeImages(escaped: string, inline: Record<string, string>) {
  return escaped.replace(/\[Image: ([^\]\n]{1,240})\]/g, (marker, name: string) => {
    const cid = Object.entries(inline).find(([key]) => escapeHtml(key) === name.trim())?.[1];
    return cid ? `<img src="cid:${escapeHtml(cid)}" alt="${name.trim()}" style="max-width:100%;height:auto;display:block;margin:0.5em 0">` : marker;
  });
}

function plainPart(text: string, inline: Record<string, string>) {
  return placeImages(linkify(text), inline);
}

function spansToHtml(line: string, spans: FormatSpan[], from: number, to: number, inline: Record<string, string>): string {
  let out = "";
  let last = from;
  for (const span of spans) {
    out += plainPart(line.slice(last, span.from), inline);
    const [innerFrom, innerTo] = span.inner;
    if (span.kind === "link") {
      const label = escapeHtml(line.slice(innerFrom, innerTo));
      out += span.external ? `<a href="${escapeHtml(span.href)}">${label}</a>` : label;
    } else {
      const tag = span.kind === "bold" ? "strong" : "em";
      out += `<${tag}>${spansToHtml(line, span.spans, innerFrom, innerTo, inline)}</${tag}>`;
    }
    last = span.to;
  }
  return out + plainPart(line.slice(last, to), inline);
}

function formatLine(line: string, inline: Record<string, string>) {
  const marker = headingMarker(line);
  const text = spansToHtml(line, formatSpans(line), marker, line.length, inline);
  return marker ? `<strong>${text}</strong>` : text;
}

const HARD_SPACE = "\u00a0";

function keepSpacing(line: string) {
  return line
    .replace(/\t/g, HARD_SPACE.repeat(4))
    .replace(/^ +/, (lead) => HARD_SPACE.repeat(lead.length))
    .replace(/ {2,}/g, (run) => `${HARD_SPACE.repeat(run.length - 1)} `);
}

function plainLine(line: string, inline: Record<string, string>) {
  return plainPart(keepSpacing(line), inline).replace(/\u00a0/g, "&nbsp;");
}

function paragraphHtml(paragraph: string, line: (value: string) => string, gap = 0) {
  return `<p style="margin:0 0 1em 0">${"<br>".repeat(gap)}${paragraph.split("\n").map(line).join("<br>")}</p>`;
}

function textToHtml(text: string, inline: Record<string, string> = {}, plain = false) {
  const normal = text.replace(/\r\n/g, "\n");
  if (!plain) {
    return normal
      .trim()
      .split(/\n{2,}/)
      .map((paragraph) => paragraphHtml(paragraph, (value) => formatLine(value, inline)))
      .join("");
  }
  const parts = normal.replace(/^\s*\n/, "").trimEnd().split(/(\n{2,})/);
  let html = "";
  for (let index = 0; index < parts.length; index += 2) {
    const gap = index > 0 ? parts[index - 1].length - 2 : 0;
    html += paragraphHtml(parts[index], (value) => plainLine(value, inline), gap);
  }
  return html;
}

export function composeEmailHtml(input: {
  body: string;
  signature?: string | null;
  pixel?: string | null;
  quote?: string | null;
  inline?: Record<string, string>;
  plain?: boolean;
}) {
  const signature = input.signature?.trim() ? `<div style="color:#555">${textToHtml(input.signature, {}, input.plain)}</div>` : "";
  const pixel = input.pixel
    ? `<img src="${escapeHtml(input.pixel)}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0;opacity:0">`
    : "";
  const own = `<div style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:11pt;color:#111">${textToHtml(input.body, input.inline, input.plain)}${signature}${pixel}</div>`;
  const quote = input.quote ? stripTrackers(input.quote) : "";
  if (!quote) return own;
  const body = quote.match(/<body\b[^>]*>/i);
  if (!body || body.index === undefined) return `${own}${quote}`;
  const at = body.index + body[0].length;
  return `${quote.slice(0, at)}${own}${quote.slice(at)}`;
}
