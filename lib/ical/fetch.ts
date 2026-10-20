import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { appSecret } from "@/lib/auth/config";

export const FEED_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type Address = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<Address[]>;

type FeedResult =
  | { status: "not_modified" }
  | { status: "ok"; text: string; etag: string | null; lastModified: string | null };

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    if (new URL(`http://[${address}]`).hostname.startsWith("[::")) return false;
  }
  return !BLOCKED.check(address, family === 6 ? "ipv6" : "ipv4");
}

export function normalizeFeedUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) throw new FeedError("Paste the calendar's iCal link.");
  if (trimmed.length > 2000) throw new FeedError("That link is too long.");
  const rewritten = trimmed.replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(rewritten);
  } catch {
    throw new FeedError("That doesn't look like a link. Paste the full https:// or webcal:// address.");
  }
  if (url.protocol !== "https:") throw new FeedError("Use an https:// or webcal:// calendar link.");
  if (url.username || url.password) throw new FeedError("Calendar links with a username or password aren't supported.");
  if (!url.hostname) throw new FeedError("That link has no host.");
  url.hash = "";
  return url;
}

export function feedHost(url: URL) {
  return url.hostname.toLowerCase().slice(0, 253);
}

export function maskFeedUrl(host: string) {
  return `${host}/…`;
}

export function feedUrlHash(url: URL) {
  return createHmac("sha256", appSecret()).update(`calendar-feed:${url.toString()}`).digest("base64url");
}

function bareHost(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

const systemLookup: Lookup = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });

function blockedHost(host: string) {
  return new FeedError(`Orbit can't read calendars from ${host}. Use a public calendar link.`);
}

export async function assertPublicHost(hostname: string, lookup: Lookup = systemLookup) {
  const host = bareHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) throw blockedHost(host);
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw blockedHost(host);
    return [{ address: host, family: isIP(host) }];
  }
  let addresses: Address[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new FeedError(`Couldn't find ${host}. Check the link.`);
  }
  if (addresses.length === 0) throw new FeedError(`Couldn't find ${host}. Check the link.`);
  if (addresses.some((entry) => !isPublicAddress(entry.address))) throw blockedHost(host);
  return addresses;
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  systemLookup(hostname).then(
    (addresses) => {
      const safe = addresses.filter((entry) => isPublicAddress(entry.address));
      if (safe.length === 0 || safe.length !== addresses.length) {
        callback(blockedHost(bareHost(hostname)) as NodeJS.ErrnoException, "", 4);
        return;
      }
      if (options.all) callback(null, safe);
      else callback(null, safe[0].address, safe[0].family);
    },
    (error: NodeJS.ErrnoException) => callback(error, "", 4),
  );
};

export const secureFeedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(String(input));
    if (url.protocol !== "https:") {
      reject(new FeedError("Use an https:// or webcal:// calendar link."));
      return;
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const request = httpsRequest(
      url,
      { method: "GET", headers, lookup: guardedLookup, agent: false, signal: init?.signal ?? undefined },
      (response) => {
        const status = response.statusCode ?? 500;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
          else if (typeof value === "string") responseHeaders.set(key, value);
        }
        const empty = status === 204 || status === 304 || status < 200 || status > 599;
        if (empty) response.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
            status: status < 200 || status > 599 ? 502 : status,
            headers: responseHeaders,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  })) as typeof fetch;

async function readBody(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > FEED_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new FeedError("That calendar is larger than 10 MB.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FEED_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new FeedError("That calendar is larger than 10 MB.");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(joined);
}

function statusError(status: number) {
  if (status === 401 || status === 403 || status === 404 || status === 410) {
    return new FeedError(
      `The calendar link stopped working (HTTP ${status}). Copy the secret address again and add it again.`,
    );
  }
  return new FeedError(`The calendar server answered with HTTP ${status}. Orbit will try again later.`);
}

export async function fetchFeed(
  url: URL,
  options: {
    etag?: string | null;
    lastModified?: string | null;
    fetchImpl?: typeof fetch;
    lookup?: Lookup;
    timeoutMs?: number;
  } = {},
): Promise<FeedResult> {
  const fetchImpl = options.fetchImpl ?? secureFeedFetch;
  const signal = AbortSignal.timeout(Math.max(1000, Math.min(options.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS)));
  const headers: Record<string, string> = {
    accept: "text/calendar, text/plain;q=0.9, */*;q=0.1",
    "user-agent": "Orbit-CRM-Calendar/1.0",
  };
  if (options.etag) headers["if-none-match"] = options.etag;
  if (options.lastModified) headers["if-modified-since"] = options.lastModified;
  let current = url;
  for (let hop = 0; ; hop += 1) {
    const host = bareHost(current.hostname);
    await assertPublicHost(current.hostname, options.lookup);
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), { method: "GET", headers, redirect: "manual", signal });
    } catch (error) {
      if (error instanceof FeedError) throw error;
      if (signal.aborted) throw new FeedError(`${host} took too long to send the calendar.`);
      throw new FeedError(`Couldn't reach ${host}. Orbit will try again later.`);
    }
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS) throw new FeedError("The calendar link redirected too many times.");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new FeedError("The calendar link redirected somewhere Orbit can't follow.");
      }
      if (next.protocol !== "https:") throw new FeedError("The calendar link redirected away from https.");
      current = next;
      continue;
    }
    if (response.status === 304) {
      await response.body?.cancel().catch(() => {});
      return { status: "not_modified" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw statusError(response.status);
    }
    let text: string;
    try {
      text = await readBody(response);
    } catch (error) {
      if (error instanceof FeedError) throw error;
      throw new FeedError(`Couldn't download the calendar from ${host}.`);
    }
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) {
      throw new FeedError("That link didn't return a calendar (iCal) file.");
    }
    return {
      status: "ok",
      text,
      etag: response.headers.get("etag")?.slice(0, 500) ?? null,
      lastModified: response.headers.get("last-modified")?.slice(0, 100) ?? null,
    };
  }
}
