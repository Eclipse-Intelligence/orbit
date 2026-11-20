import { baseType } from "@/lib/chat/files";
import { cleanFormat } from "@/lib/chat/markdown";
import { previewUrls } from "@/lib/chat/links";
import type { ChatLinkPreview } from "@/lib/chat/types";
import { withActor } from "@/lib/crm/context";
import { notFound, pgFailure } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { MEDIA_TYPES } from "@/lib/media-types";
import { siteOrigin } from "@/lib/site-url";
import { downloadPublic, type Lookup } from "@/lib/web-page";

export type PreviewTransport = { fetchImpl?: typeof fetch; lookup?: Lookup };

export type StoredPreview = { id: string; url: string; title: string | null; description: string | null; site: string | null; image_url: string | null };

export type FoundPreview = { url: string; title: string | null; description: string | null; site: string | null; image_url: string | null };

export const PAGE_MAX_BYTES = 512 * 1024;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 6_000;
const IMAGE_TIMEOUT_MS = 8_000;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 300;
const SITE_MAX = 80;
const IMAGE_URL_MAX = 2048;
const PAGE_TYPES = ["text/html", "application/xhtml+xml"];
const UNLABELLED_TYPES = ["", "application/octet-stream", "binary/octet-stream"];
const UNSEEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]/g;

const NAMED: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  laquo: "«",
  raquo: "»",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  aacute: "á",
  agrave: "à",
  acirc: "â",
  auml: "ä",
  aring: "å",
  atilde: "ã",
  ccedil: "ç",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  oacute: "ó",
  ocirc: "ô",
  ouml: "ö",
  oslash: "ø",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  szlig: "ß",
  Eacute: "É",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
};

function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
    }
    return NAMED[entity] ?? NAMED[entity.toLowerCase()] ?? match;
  });
}

function cleanText(value: string | null | undefined, max: number) {
  if (!value) return null;
  const text = decode(value).replace(UNSEEN, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

type Tag = { attributes: Map<string, string> };

const TAG_WINDOW = 4000;
const META_TAGS_MAX = 300;

function tagAt(html: string, start: number): Tag {
  const text = html.slice(start, start + TAG_WINDOW);
  const attributes = new Map<string, string>();
  let at = /^<[a-z][a-z0-9:-]*/i.exec(text)?.[0].length ?? text.length;
  while (at < text.length) {
    while (at < text.length && /[\s/]/.test(text[at])) at += 1;
    if (text[at] === ">") break;
    const named = /^[^\s=>/"']+/.exec(text.slice(at, at + 200));
    if (!named) {
      at += 1;
      continue;
    }
    const key = named[0].toLowerCase();
    at += named[0].length;
    while (at < text.length && /\s/.test(text[at])) at += 1;
    let value = "";
    if (text[at] === "=") {
      at += 1;
      while (at < text.length && /\s/.test(text[at])) at += 1;
      const quote = text[at];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, at + 1);
        if (close < 0) break;
        value = text.slice(at + 1, close);
        at = close + 1;
      } else {
        const bare = /^[^\s>]*/.exec(text.slice(at))![0];
        value = bare;
        at += bare.length;
      }
    }
    if (!attributes.has(key)) attributes.set(key, value);
  }
  return { attributes };
}

function withoutBlocks(html: string) {
  const opener = /<!--|<(script|style|template)\b/gi;
  let out = "";
  let from = 0;
  for (let found = opener.exec(html); found; found = opener.exec(html)) {
    out += html.slice(from, found.index);
    const closer = found[1] ? new RegExp(`</${found[1]}\\s*>`, "gi") : /-->/g;
    closer.lastIndex = found.index + found[0].length;
    const closed = closer.exec(html);
    if (!closed) return out;
    from = closed.index + closed[0].length;
    opener.lastIndex = from;
  }
  return out + html.slice(from);
}

function headOf(html: string) {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  return withoutBlocks(end >= 0 ? html.slice(0, end) : html);
}

function metaTags(head: string) {
  const found = new Map<string, string>();
  let seen = 0;
  for (const match of head.matchAll(/<meta(?=[\s/])/gi)) {
    seen += 1;
    if (seen > META_TAGS_MAX) break;
    const { attributes } = tagAt(head, match.index);
    const key = (attributes.get("property") ?? attributes.get("name") ?? "").trim().toLowerCase();
    const content = attributes.get("content");
    if (key && content !== undefined && !found.has(key)) found.set(key, content);
  }
  return found;
}

function pageTitle(head: string) {
  const open = /<title(?=[\s>])[^>]{0,200}>/i.exec(head);
  if (!open) return null;
  const closer = /<\/title\s*>/gi;
  closer.lastIndex = open.index + open[0].length;
  const close = closer.exec(head);
  return close ? head.slice(open.index + open[0].length, close.index) : null;
}

function imageUrl(candidates: (string | undefined)[], base: URL) {
  for (const candidate of candidates) {
    const text = candidate ? decode(candidate).trim() : "";
    if (!text) continue;
    try {
      const url = new URL(text, base);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && url.href.length <= IMAGE_URL_MAX) return url.href;
    } catch {
      continue;
    }
  }
  return null;
}

export function parsePreview(html: string, page: URL): Omit<FoundPreview, "url"> | null {
  const head = headOf(html);
  const meta = metaTags(head);
  const title = cleanText(meta.get("og:title") ?? meta.get("twitter:title"), TITLE_MAX) ?? cleanText(pageTitle(head), TITLE_MAX);
  const description = cleanText(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"), DESCRIPTION_MAX);
  if (!title && !description) return null;
  const site = cleanText(meta.get("og:site_name"), SITE_MAX) ?? cleanText(page.hostname.replace(/^www\./i, ""), SITE_MAX);
  const image = imageUrl([meta.get("og:image:secure_url"), meta.get("og:image:url"), meta.get("og:image"), meta.get("twitter:image"), meta.get("twitter:image:src")], page);
  return { title, description, site, image_url: image };
}

function pageText(bytes: Uint8Array, header: string | null) {
  const sniffed = /<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 4096)))?.[1];
  for (const label of [header, sniffed, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      continue;
    }
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchLinkPreview(url: string, transport: PreviewTransport = {}): Promise<FoundPreview | null> {
  let download;
  try {
    download = await downloadPublic(url, {
      fetchImpl: transport.fetchImpl,
      lookup: transport.lookup,
      maxBytes: PAGE_MAX_BYTES,
      timeoutMs: PAGE_TIMEOUT_MS,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      headers: { "user-agent": "Mozilla/5.0 (compatible; OrbitLinkPreview/1.0)", "accept-language": "en-GB,en;q=0.8" },
    });
  } catch {
    return null;
  }
  if (!PAGE_TYPES.includes(baseType(download.contentType))) return null;
  const found = parsePreview(pageText(download.bytes, download.charset), new URL(download.url));
  return found ? { url, ...found } : null;
}

export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (index: number) => bytes[index];
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => at(index) === byte)) return "image/png";
  const head = (length: number) => String.fromCharCode(...bytes.subarray(0, length));
  if (bytes.length >= 6 && (head(6) === "GIF87a" || head(6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && head(4) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

type SourceRow = { conversation_id: string; parent_id: string | null; body: string; format: string; eligible: boolean; known: string[] };

export type PreviewChange = { messageId: string; conversationId: string; parentId: string | null };

const REFRESH_ATTEMPTS = 3;

function readPreviewSource(messageId: string) {
  return query<SourceRow>("select * from private.chat_preview_source($1)", [messageId]).then((result) => result.rows[0]);
}

export async function refreshLinkPreviews(messageId: string, transport: PreviewTransport = {}): Promise<PreviewChange | null> {
  const fetched = new Map<string, FoundPreview | null>();
  let change: PreviewChange | null = null;
  for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt += 1) {
    const source = await readPreviewSource(messageId);
    if (!source?.eligible) return change;
    const wanted = previewUrls(source.body, cleanFormat(source.format), siteOrigin());
    const missing = wanted.filter((url) => !source.known.includes(url));
    const kept = wanted.filter((url) => source.known.includes(url));
    const inOrder = source.known.length === kept.length && source.known.every((url, index) => url === kept[index]);
    if (missing.length === 0 && inOrder) return change;
    const unseen = missing.filter((url) => !fetched.has(url));
    const pages = await Promise.all(unseen.map((url) => fetchLinkPreview(url, transport)));
    unseen.forEach((url, index) => fetched.set(url, pages[index]));
    const found = missing.map((url) => fetched.get(url)).filter((item): item is FoundPreview => Boolean(item));
    const stored = await query<{ changed: boolean }>("select private.chat_store_link_previews($1, $2, $3, $4::text[], $5::jsonb) as changed", [
      messageId,
      source.body,
      source.format,
      wanted,
      JSON.stringify(found),
    ]);
    if (stored.rows[0]?.changed) change = { messageId, conversationId: source.conversation_id, parentId: source.parent_id };
    const now = await readPreviewSource(messageId);
    if (!now || (now.body === source.body && now.format === source.format)) return change;
  }
  return change;
}

export function cleanPreviewId(id: unknown) {
  if (typeof id !== "string" || !isUuid(id)) throw notFound("preview");
  return id.toLowerCase();
}

export async function hideLinkPreview(actor: UserActor, id: unknown): Promise<PreviewChange> {
  const previewId = cleanPreviewId(id);
  try {
    const result = await query<{ message_id: string; conversation_id: string; parent_id: string | null }>("select * from private.chat_hide_link_preview($1, $2)", [actor.userId, previewId]);
    const row = result.rows[0];
    if (!row) throw notFound("preview");
    return { messageId: row.message_id, conversationId: row.conversation_id, parentId: row.parent_id };
  } catch (error) {
    throw pgFailure(error) ?? error;
  }
}

export type PreviewImage = { bytes: Uint8Array; contentType: string };

export async function linkPreviewImage(actor: UserActor, id: unknown, transport: PreviewTransport = {}): Promise<PreviewImage> {
  const previewId = cleanPreviewId(id);
  const row = await withActor(actor, async (db) => {
    const result = await db.query<{ image_url: string | null }>("select image_url from crm.chat_link_previews where id = $1", [previewId]);
    return result.rows[0];
  });
  if (!row?.image_url) throw notFound("image");
  let download;
  try {
    download = await downloadPublic(row.image_url, {
      fetchImpl: transport.fetchImpl,
      lookup: transport.lookup,
      maxBytes: IMAGE_MAX_BYTES,
      timeoutMs: IMAGE_TIMEOUT_MS,
      accept: MEDIA_TYPES.join(","),
      headers: { "user-agent": "Mozilla/5.0 (compatible; OrbitLinkPreview/1.0)" },
    });
  } catch {
    throw notFound("image");
  }
  const declared = baseType(download.contentType);
  const contentType = download.truncated || !(MEDIA_TYPES.includes(declared) || UNLABELLED_TYPES.includes(declared)) ? null : sniffImageType(download.bytes);
  if (!contentType || !MEDIA_TYPES.includes(contentType)) throw notFound("image");
  return { bytes: download.bytes, contentType };
}

export function previewImageResponse(image: PreviewImage) {
  return new Response(Buffer.from(image.bytes), {
    headers: {
      "content-type": image.contentType,
      "content-length": String(image.bytes.byteLength),
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "cache-control": "private, max-age=3600",
    },
  });
}

export function previewsOf(rows: StoredPreview[] | null, body: string, format: string | null): ChatLinkPreview[] {
  if (!rows || rows.length === 0) return [];
  const wanted = previewUrls(body, cleanFormat(format), siteOrigin());
  return wanted.flatMap((url) => {
    const row = rows.find((item) => item.url === url);
    return row ? [{ id: row.id, url: row.url, title: row.title, description: row.description, site: row.site, image: Boolean(row.image_url) }] : [];
  });
}
