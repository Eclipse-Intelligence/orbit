const BLOCKED_BLOCKS = /<(script|iframe|object|frameset|applet|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCKED_TAGS = /<\/?(script|iframe|object|embed|form|frameset|frame|applet|base|link|noscript)\b[^>]*>/gi;
const EVENT_ATTRIBUTES = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const SCRIPT_URLS = /\s(href|src|action|formaction|xlink:href)\s*=\s*("\s*(javascript|vbscript|data:text\/html)[^"]*"|'\s*(javascript|vbscript|data:text\/html)[^']*'|(javascript|vbscript):[^\s>]*)/gi;
const REFRESH = /<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi;
const CID_IMAGES = /<img\b[^>]*\bsrc\s*=\s*["']?cid:[^>]*>/gi;

export function cleanEmailHtml(html: string) {
  return html
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
