import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { htmlToText } from "@/lib/mail/text";

const TEXT_MAX = 24_000;
const BYTES_MAX = 3_000_000;
const TIMEOUT_MS = 12_000;
const REDIRECTS_MAX = 4;
const LINKS_MAX = 60;

export type Lookup = (hostname: string) => Promise<string[]>;

export type WebPage = {
  url: string;
  title: string | null;
  description: string | null;
  text: string;
  links: { text: string; url: string }[];
  truncated: boolean;
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

async function readBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BYTES_MAX) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
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

export async function readWebPage(raw: string, options: { fetchImpl?: typeof fetch; lookup?: Lookup } = {}): Promise<WebPage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? systemLookup;
  let url = await checkUrl(raw.trim(), lookup);
  let response: Response | null = null;
  for (let hop = 0; hop <= REDIRECTS_MAX; hop += 1) {
    try {
      response = await fetchImpl(url.href, {
        headers: { accept: "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5", "user-agent": "Mozilla/5.0 (compatible; OrbitAssistant/1.0)" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new WebPageError(`${url.hostname} didn't answer in time.`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = await checkUrl(new URL(response.headers.get("location")!, url).href, lookup);
      response = null;
      continue;
    }
    break;
  }
  if (!response) throw new WebPageError("That page redirected too many times.");
  if (!response.ok) throw new WebPageError(`${url.hostname} answered ${response.status}${response.status === 403 || response.status === 401 ? ", so the page is private or blocks automated reading" : ""}.`);
  const type = response.headers.get("content-type") ?? "";
  if (type && !/text\/|html|xml|json|markdown/i.test(type)) throw new WebPageError(`That address is a ${type.split(";")[0]} file, not a page Orbit can read.`);
  const body = await readBody(response);
  if (!/html|xml/i.test(type) && !/^\s*</.test(body.text)) {
    return { url: url.href, title: null, description: null, text: body.text.slice(0, TEXT_MAX), links: [], truncated: body.truncated || body.text.length > TEXT_MAX };
  }
  const html = body.text;
  const main = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
  const text = htmlToText(main.replace(/<\/?(b|strong|i|em|span|u|small|mark|code|abbr|time)\b[^>]*>/gi, ""));
  return {
    url: url.href,
    title: meta(html, /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) ?? meta(html, /<title[^>]*>([^<]*)<\/title>/i),
    description: meta(html, /<meta[^>]+name="description"[^>]+content="([^"]*)"/i) ?? meta(html, /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i),
    text: text.slice(0, TEXT_MAX),
    links: pageLinks(html, url),
    truncated: body.truncated || text.length > TEXT_MAX,
  };
}
