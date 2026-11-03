import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UnsubscribeMethod } from "@/lib/mail/view";
import { privateAddress, publicFetch, WebPageError } from "@/lib/web-page";

export type Mailto = { address: string; subject: string; body: string };
export type ListUnsubscribe = { oneClick: boolean; https: string[]; pages: string[]; mailto: Mailto[] };
export type Lookup = (hostname: string) => Promise<string[]>;

const POST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const REDIRECTS_MAX = 3;
const URI_MAX = 2000;
const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata|metadata\.google\.internal|instance-data)$/i;

export class UnsubscribeRefused extends Error {}

function headerValue(headers: { name: string; value: string }[], name: string) {
  const wanted = name.toLowerCase();
  const found = headers.filter((header) => header.name.trim().toLowerCase() === wanted).map((header) => header.value);
  return found.length ? found.join(", ") : null;
}

function readMailto(uri: string): Mailto | null {
  const rest = uri.slice("mailto:".length);
  const [path, query = ""] = rest.split("?", 2);
  let first: string;
  try {
    first = decodeURIComponent(path.split(",")[0] ?? "");
  } catch {
    return null;
  }
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    const [key, value = ""] = pair.split("=", 2);
    if (!key) continue;
    try {
      params.set(decodeURIComponent(key).toLowerCase(), decodeURIComponent(value.replace(/\+/g, " ")));
    } catch {
      continue;
    }
  }
  const address = canonicalEmail(first || params.get("to") || "");
  if (!address) return null;
  const subject = (params.get("subject") ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || "unsubscribe";
  const body = (params.get("body") ?? "").replace(/\r\n/g, "\n").trim().slice(0, 2000) || "unsubscribe";
  return { address, subject, body };
}

export function parseListUnsubscribe(header: string | null | undefined, post?: string | null): ListUnsubscribe {
  const parsed: ListUnsubscribe = { oneClick: false, https: [], pages: [], mailto: [] };
  const text = (header ?? "").replace(/\r?\n[ \t]+/g, "").trim();
  if (!text) return parsed;
  const bracketed = [...text.matchAll(/<([^>]*)>/g)].map((match) => match[1]);
  const uris = (bracketed.length ? bracketed : text.split(",")).map((uri) => uri.replace(/\s+/g, "").trim()).filter(Boolean);
  for (const uri of uris) {
    if (uri.length > URI_MAX) continue;
    if (/^mailto:/i.test(uri)) {
      const mailto = readMailto(`mailto:${uri.slice(7)}`);
      if (mailto) parsed.mailto.push(mailto);
      continue;
    }
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      continue;
    }
    if (url.username || url.password) continue;
    if (url.protocol === "https:") {
      parsed.https.push(url.href);
      parsed.pages.push(url.href);
    } else if (url.protocol === "http:") {
      parsed.pages.push(url.href);
    }
  }
  parsed.oneClick = parsed.https.length > 0 && /(^|[\s;,])List-Unsubscribe\s*=\s*One-Click(\s|$|[;,])/i.test(post ?? "");
  return parsed;
}

export function listUnsubscribeFrom(headers: { name: string; value: string }[]) {
  const raw = headerValue(headers, "List-Unsubscribe");
  return { raw: raw?.slice(0, URI_MAX) ?? null, parsed: parseListUnsubscribe(raw, headerValue(headers, "List-Unsubscribe-Post")) };
}

export function chooseMethod(parsed: ListUnsubscribe): UnsubscribeMethod {
  if (parsed.oneClick) return "one_click";
  if (parsed.mailto.length) return "mailto";
  if (parsed.pages.length) return "page";
  return "none";
}

async function systemLookup(hostname: string) {
  return (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

async function checkTarget(raw: string, lookup: Lookup) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsubscribeRefused("The unsubscribe link isn't a web address.");
  }
  if (url.protocol !== "https:") throw new UnsubscribeRefused("Orbit only unsubscribes over https.");
  if (url.username || url.password) throw new UnsubscribeRefused("The unsubscribe link has a username or password in it.");
  if (url.port && url.port !== "443") throw new UnsubscribeRefused("The unsubscribe link uses an unusual port.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || BLOCKED_HOSTS.test(host)) throw new UnsubscribeRefused("The unsubscribe link points at a private address.");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new UnsubscribeRefused(`${host} couldn't be found.`);
    }
  }
  if (addresses.length === 0 || addresses.some(privateAddress)) throw new UnsubscribeRefused("The unsubscribe link points at a private address.");
  return url;
}

function refusedCause(error: unknown) {
  for (let current = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if (current instanceof WebPageError || current instanceof UnsubscribeRefused || (current as { code?: unknown }).code === "EPRIVATE") return true;
  }
  return false;
}

async function drain(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size >= RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } catch {
    await reader.cancel().catch(() => undefined);
  }
}

export async function postOneClick(
  raw: string,
  options: { fetchImpl?: typeof fetch; lookup?: Lookup; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; host: string }> {
  const fetchImpl = options.fetchImpl ?? publicFetch;
  const lookup = options.lookup ?? systemLookup;
  const signal = AbortSignal.timeout(Math.min(options.timeoutMs ?? POST_TIMEOUT_MS, POST_TIMEOUT_MS));
  let current = await checkTarget(raw, lookup);
  let method: "POST" | "GET" = "POST";
  for (let hop = 0; hop <= REDIRECTS_MAX; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current.href, {
        method,
        body: method === "POST" ? "List-Unsubscribe=One-Click" : undefined,
        headers: method === "POST" ? { "content-type": "application/x-www-form-urlencoded", "user-agent": "Orbit-Unsubscribe/1.0" } : { "user-agent": "Orbit-Unsubscribe/1.0" },
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (refusedCause(error)) throw new UnsubscribeRefused("The unsubscribe link points at a private address.");
      throw new Error(signal.aborted ? `${current.hostname} didn't answer in time.` : `Couldn't reach ${current.hostname}.`);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new UnsubscribeRefused("The unsubscribe link redirected somewhere Orbit can't follow.");
      }
      current = await checkTarget(next.href, lookup);
      if (response.status !== 307 && response.status !== 308) method = "GET";
      continue;
    }
    await drain(response);
    return { ok: response.ok, status: response.status, host: current.hostname };
  }
  throw new UnsubscribeRefused("The unsubscribe link redirected too many times.");
}
