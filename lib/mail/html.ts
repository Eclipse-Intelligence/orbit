const BLOCKED_BLOCKS = /<(script|iframe|object|frameset|applet|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCKED_TAGS = /<\/?(script|iframe|object|embed|form|frameset|frame|applet|base|link|noscript)\b[^>]*>/gi;
const EVENT_ATTRIBUTES = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const SCRIPT_URLS = /\s(href|src|action|formaction|xlink:href)\s*=\s*("\s*(javascript|vbscript|data:text\/html)[^"]*"|'\s*(javascript|vbscript|data:text\/html)[^']*'|(javascript|vbscript):[^\s>]*)/gi;
const REFRESH = /<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi;
const CID_IMAGES = /<img\b[^>]*\bsrc\s*=\s*["']?cid:[^>]*>/gi;
const TRACKERS = /<img\b[^>]*\/api\/mail\/open\/[^>]*>/gi;
const TRACKING_ID = /\/api\/mail\/open\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export const TRACKING_PATH = "/api/mail/open/";

function stripTrackers(html: string) {
  return html.replace(TRACKERS, "");
}

export function trackingIdIn(html: string | null | undefined) {
  return html?.match(TRACKING_ID)?.[1]?.toLowerCase() ?? null;
}

export function cleanEmailHtml(html: string) {
  return stripTrackers(html)
    .replace(BLOCKED_BLOCKS, "")
    .replace(BLOCKED_TAGS, "")
    .replace(REFRESH, "")
    .replace(EVENT_ATTRIBUTES, "")
    .replace(SCRIPT_URLS, "")
    .replace(CID_IMAGES, "");
}

export function richEmail(html: string) {
  return /bgcolor\s*=|background(-color|-image)?\s*:|<table\b[^>]*(width|style)\s*=/i.test(html);
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function linkify(escaped: string) {
  return escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`);
}

function textToHtml(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 1em 0">${linkify(escapeHtml(paragraph)).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function composeEmailHtml(input: { body: string; signature?: string | null; pixel?: string | null; quote?: string | null }) {
  const signature = input.signature?.trim() ? `<div style="color:#555">${textToHtml(input.signature)}</div>` : "";
  const pixel = input.pixel
    ? `<img src="${escapeHtml(input.pixel)}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0;opacity:0">`
    : "";
  const own = `<div style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:11pt;color:#111">${textToHtml(input.body)}${signature}${pixel}</div>`;
  const quote = input.quote ? stripTrackers(input.quote) : "";
  if (!quote) return own;
  const body = quote.match(/<body\b[^>]*>/i);
  if (!body || body.index === undefined) return `${own}${quote}`;
  const at = body.index + body[0].length;
  return `${quote.slice(0, at)}${own}${quote.slice(at)}`;
}
