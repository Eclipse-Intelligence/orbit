import { isInternalHref, parseBlocks } from "@/components/assistant/markdown";
import { siteOrigin } from "@/lib/site-url";

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
const BARE_URL = /https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]']/g;
const LEAD_IN = /(:|^\*\*[^*]+\*\*)$/;
const CELL = 'style="padding:4px 10px;border-bottom:1px solid #e5e5e5;text-align:left;vertical-align:top"';

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function absoluteHref(href: string, origin: string | null) {
  if (/^https?:\/\//i.test(href)) return href;
  if (origin && isInternalHref(href)) return `${origin}${href}`;
  return null;
}

function linkParts(token: string) {
  const close = token.indexOf("](");
  return { label: token.slice(1, close), href: token.slice(close + 2, -1) };
}

function plainSegment(text: string) {
  return escapeHtml(text).replace(BARE_URL, (url) => `<a href="${url}">${url}</a>`);
}

function inlineHtml(text: string, origin: string | null): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index ?? 0;
    out += plainSegment(text.slice(last, start));
    if (token.startsWith("**")) out += `<strong>${inlineHtml(token.slice(2, -2), origin)}</strong>`;
    else if (token.startsWith("`")) out += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    else if (token.startsWith("[")) {
      const { label, href } = linkParts(token);
      const url = absoluteHref(href, origin);
      out += url ? `<a href="${escapeHtml(url)}">${inlineHtml(label, origin)}</a>` : inlineHtml(label, origin);
    } else out += `<em>${inlineHtml(token.slice(1, -1), origin)}</em>`;
    last = start + token.length;
  }
  return out + plainSegment(text.slice(last));
}

function inlineText(text: string, origin: string | null): string {
  return text.replace(INLINE, (token) => {
    if (token.startsWith("**")) return inlineText(token.slice(2, -2), origin);
    if (token.startsWith("`")) return token.slice(1, -1);
    if (token.startsWith("[")) {
      const { label, href } = linkParts(token);
      const url = absoluteHref(href, origin);
      const plainLabel = inlineText(label, origin);
      return url && url !== plainLabel ? `${plainLabel} (${url})` : plainLabel;
    }
    return inlineText(token.slice(1, -1), origin);
  });
}

export function emailHtml(markdown: string, origin: string | null = siteOrigin()) {
  const blocks = parseBlocks(markdown.trim()).map((block) => {
    if (block.kind === "heading") return `<p><strong>${inlineHtml(block.text, origin)}</strong></p>`;
    if (block.kind === "rule") return "<hr>";
    if (block.kind === "code") return `<pre style="white-space:pre-wrap">${escapeHtml(block.text)}</pre>`;
    if (block.kind === "table") {
      const head = block.head.map((cell) => `<th ${CELL}>${inlineHtml(cell, origin)}</th>`).join("");
      const rows = block.rows.map((row) => `<tr>${row.map((cell) => `<td ${CELL}>${inlineHtml(cell, origin)}</td>`).join("")}</tr>`).join("");
      return `<table style="border-collapse:collapse"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    if (block.kind === "list") {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items.map((item) => `<li${item.depth > 0 ? ' style="margin-left:16px"' : ""}>${inlineHtml(item.text, origin)}</li>`).join("");
      return `<${tag}>${items}</${tag}>`;
    }
    return `<p>${block.text
      .split("\n")
      .map((line) => inlineHtml(line, origin))
      .join("<br>")}</p>`;
  });
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">${blocks.join("\n")}</div>`;
}

export function emailText(markdown: string, origin: string | null = siteOrigin()) {
  const blocks = parseBlocks(markdown.trim());
  const parts = blocks.map((block) => {
    if (block.kind === "heading") return inlineText(block.text, origin);
    if (block.kind === "rule") return "***";
    if (block.kind === "code") return block.text;
    if (block.kind === "table") return [block.head, ...block.rows].map((row) => row.map((cell) => inlineText(cell, origin)).join(" | ")).join("\n");
    if (block.kind === "list") {
      return block.items.map((item, index) => `${item.depth > 0 ? "  " : ""}${block.ordered ? `${index + 1}.` : "-"} ${inlineText(item.text, origin)}`).join("\n");
    }
    return block.text
      .split("\n")
      .map((line) => inlineText(line, origin))
      .join("\n");
  });
  return parts.reduce((text, part, index) => {
    if (index === 0) return part;
    const previous = blocks[index - 1];
    const leadIn = blocks[index].kind === "list" && (previous.kind === "paragraph" || previous.kind === "heading") && LEAD_IN.test(previous.text.trim());
    return `${text}${leadIn ? "\n" : "\n\n"}${part}`;
  }, "");
}
