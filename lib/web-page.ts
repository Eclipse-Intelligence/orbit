import { lookup as dnsLookupEach, type LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as agentFetch } from "undici";
import { browserbaseConfigured, renderWithBrowserbase, type Renderer } from "@/lib/browserbase";
import { attachmentKind, readAttachmentText } from "@/lib/mail/attachment-text";
import { htmlToText } from "@/lib/mail/text";

const TEXT_MAX = 24_000;
const BYTES_MAX = 3_000_000;
const TIMEOUT_MS = 12_000;
const REDIRECTS_MAX = 4;
const LINKS_MAX = 60;
const DOCUMENT_MAX = 15_000_000;
const THIN_TEXT = 200;

export type Lookup = (hostname: string) => Promise<string[]>;

export type WebPage = {
  url: string;
  title: string | null;
  description: string | null;
  text: string;
  links: { text: string; url: string }[];
  truncated: boolean;
  via: "fetch" | "browser" | "file";
};

export class WebPageError extends Error {}

async function systemLookup(hostname: string) {
  return (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function privateV4(address: string) {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function privateAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return privateV4(address);
  if (version !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
}

const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookupEach(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    if (addresses.length === 0 || addresses.some((entry) => privateAddress(entry.address))) {
      return callback(Object.assign(new WebPageError("Private and local addresses can't be opened."), { code: "EPRIVATE" }), "", 0);
    }
    if (options.all) return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

const publicFetch = ((input: string, init?: RequestInit) =>
  agentFetch(input, { ...(init as object), dispatcher: publicOnly })) as unknown as typeof fetch;

function privateCause(error: unknown): WebPageError | null {
  for (let current = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if (current instanceof WebPageError) return current;
  }
  return null;
}

async function checkUrl(raw: string, lookup: Lookup) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebPageError("That isn't a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebPageError("Only http and https pages can be opened.");
  if (url.username || url.password) throw new WebPageError("Addresses with a username or password can't be opened.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.localhost|.*\.internal)$/i.test(host)) throw new WebPageError("Private and local addresses can't be opened.");
  const addresses = isIP(host) ? [host] : await lookup(host).catch(() => {
    throw new WebPageError(`${host} couldn't be found.`);
  });
  if (addresses.length === 0 || addresses.some(privateAddress)) throw new WebPageError("Private and local addresses can't be opened.");
  return url;
}

async function readBytes(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { bytes: new Uint8Array(Buffer.concat(chunks)), truncated };
}

function meta(html: string, pattern: RegExp) {
  const value = html.match(pattern)?.[1];
  return value ? htmlToText(value).trim() || null : null;
}

function pageLinks(html: string, base: URL) {
  const seen = new Set<string>();
  const links: { text: string; url: string }[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(match[1].replace(/&amp;/g, "&"), base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    url.hash = "";
    const text = htmlToText(match[2]).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!text || seen.has(url.href)) continue;
    seen.add(url.href);
    links.push({ text, url: url.href });
    if (links.length >= LINKS_MAX) break;
  }
  return links;
}

function fromHtml(html: string, url: URL, truncated: boolean, via: WebPage["via"], limit = TEXT_MAX): WebPage {
  const main = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
  const text = htmlToText(main.replace(/<\/?(b|strong|i|em|span|u|small|mark|code|abbr|time)\b[^>]*>/gi, ""));
  return {
    url: url.href,
    title: meta(html, /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) ?? meta(html, /<title[^>]*>([^<]*)<\/title>/i),
    description: meta(html, /<meta[^>]+name="description"[^>]+content="([^"]*)"/i) ?? meta(html, /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i),
    text: text.slice(0, limit),
    links: pageLinks(html, url),
    truncated: truncated || text.length > limit,
    via,
  };
}

type Fetched = { page: WebPage } | { blocked: string; proxies: boolean; fallback?: WebPage };

async function fetchDirect(url: URL, fetchImpl: typeof fetch, lookup: Lookup, limit = TEXT_MAX): Promise<Fetched> {
  let current = url;
  let response: Response | null = null;
  for (let hop = 0; hop <= REDIRECTS_MAX; hop += 1) {
    try {
      response = await fetchImpl(current.href, {
        headers: { accept: "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5", "user-agent": "Mozilla/5.0 (compatible; OrbitAssistant/1.0)" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const refused = privateCause(error);
      if (refused) throw refused;
      return { blocked: `${current.hostname} didn't answer in time.`, proxies: true };
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = await checkUrl(new URL(response.headers.get("location")!, current).href, lookup);
      response = null;
      continue;
    }
    break;
  }
  if (!response) throw new WebPageError("That page redirected too many times.");
  if (!response.ok) {
    const denied = [401, 403, 429, 503].includes(response.status);
    const message = `${current.hostname} answered ${response.status}${denied ? ", so the page is private or blocks automated reading" : ""}.`;
    if (denied) return { blocked: message, proxies: true };
    throw new WebPageError(message);
  }
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const name = decodeURIComponent(current.pathname.split("/").pop() || "document");
  if (attachmentKind(name, type) && !/html|xml|text\/|json|markdown/.test(type)) {
    const { bytes, truncated } = await readBytes(response, DOCUMENT_MAX);
    if (truncated) throw new WebPageError("That file is too big to read here.");
    const text = await readAttachmentText(bytes, name, type, limit).catch(() => null);
    if (!text) throw new WebPageError(`That ${type || "file"} has no text Orbit can read.`);
    return { page: { url: current.href, title: name, description: null, text: text.slice(0, limit), links: [], truncated: text.length > limit, via: "file" } };
  }
  if (type && !/text\/|html|xml|json|markdown/.test(type)) throw new WebPageError(`That address is a ${type} file, not a page Orbit can read.`);
  const body = await readBytes(response, BYTES_MAX);
  const raw = new TextDecoder().decode(body.bytes);
  if (!/html|xml/.test(type) && !/^\s*</.test(raw)) {
    return { page: { url: current.href, title: null, description: null, text: raw.slice(0, limit), links: [], truncated: body.truncated || raw.length > limit, via: "fetch" } };
  }
  const page = fromHtml(raw, current, body.truncated, "fetch", limit);
  if (page.text.length < THIN_TEXT) return { blocked: "The page has almost no text without JavaScript.", proxies: false, fallback: page };
  return { page };
}

export async function readWebPage(
  raw: string,
  options: { fetchImpl?: typeof fetch; lookup?: Lookup; render?: Renderer | null; textMax?: number } = {},
): Promise<WebPage> {
  const limit = options.textMax ?? TEXT_MAX;
  const fetchImpl = options.fetchImpl ?? publicFetch;
  const lookup = options.lookup ?? systemLookup;
  const url = await checkUrl(raw.trim(), lookup);
  const direct = await fetchDirect(url, fetchImpl, lookup, limit);
  if ("page" in direct) return direct.page;
  const render = options.render === undefined ? (browserbaseConfigured() ? (target: string, settings: { proxies: boolean }) => renderWithBrowserbase(target, settings) : null) : options.render;
  if (!render) {
    if (direct.fallback) return direct.fallback;
    throw new WebPageError(direct.blocked);
  }
  let rendered;
  try {
    rendered = await render(url.href, { proxies: direct.proxies });
  } catch (error) {
    if (direct.fallback) return direct.fallback;
    throw new WebPageError(`${direct.blocked} Opening it in a browser didn't work either${error instanceof Error && error.message ? ` (${error.message.slice(0, 160)})` : ""}.`);
  }
  const landed = await checkUrl(rendered.url, lookup).catch(() => url);
  return fromHtml(rendered.html.slice(0, BYTES_MAX), landed, rendered.html.length > BYTES_MAX, "browser", limit);
}
