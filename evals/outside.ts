import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns";
import net from "node:net";
import { clearEclipseToolCache } from "@/lib/eclipse-mcp";
import { clearEclipseSourceCache } from "@/lib/eclipse-sources";
import { resetLinearCache } from "@/lib/linear";
import { routeOutsideWeb } from "@/lib/web-page";
import { normalUrl } from "./world";
import type { EclipseCall, OutboundRecord, Usage, World } from "./types";

const ECLIPSE_MCP_URL = "https://eclipse-mcp.eval.test/api/mcp";
const LINEAR_URL = "https://linear.eval.test/graphql";
const PUBLIC_ADDRESS = "93.184.216.34";
const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
export const TRUSTED_HOSTS = new Set(["eclipse-mcp.eval.test", "linear.eval.test", "storage.eval.test"]);
export const SERVICE_HOSTS = new Set(["api.mindcase.co", "api.parallel.ai"]);

export type GatewayCall = { url: string; init?: RequestInit; body: Record<string, unknown>; world: World; round: number };

export type GatewayHandler = (call: GatewayCall) => Response | Promise<Response>;

export type GatewayUsage = Usage & { model: string; kind: "assistant" | "other" };

export type RunContext = {
  world: World | null;
  model: GatewayHandler;
  judge: GatewayHandler;
  passthrough: typeof fetch;
  outbound: OutboundRecord[];
  eclipseCalls: EclipseCall[];
  offeredTools: Set<string>;
  lastGatewayError: string | null;
  lastModelRequest: string;
  usage: GatewayUsage[];
  reading: Promise<unknown>[];
  rounds: number;
};

const store = new AsyncLocalStorage<RunContext>();

export const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

function gatewayBase() {
  return new URL((process.env.LLM_API_BASE_URL?.trim() || "https://api.llmapi.ai/v1").replace(/\/+$/, ""));
}

function under(url: URL, base: URL) {
  if (url.origin !== base.origin) return false;
  const root = base.pathname.replace(/\/+$/, "");
  return root === "" || url.pathname === root || url.pathname.startsWith(`${root}/`);
}

export function gatewayPath(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin === ANTHROPIC_ORIGIN) return url.pathname;
  const base = gatewayBase();
  if (!under(url, base)) return null;
  return url.pathname.slice(base.pathname.replace(/\/+$/, "").length);
}

const MODEL_PATHS = ["/chat/completions", "/responses", "/messages", "/v1/messages"];

const ECLIPSE_TOOLS = [
  { name: "list_clients", description: "List every Eclipse client (brand) with its id and name.", inputSchema: { type: "object", properties: {} } },
  {
    name: "get_geo_results",
    description: "GEO results for one client: how often AI answers mention the brand, by prompt.",
    inputSchema: { type: "object", properties: { clientId: { type: "string" } }, required: ["clientId"] },
  },
  {
    name: "list_articles",
    description: "Published articles for one client, with titles and links.",
    inputSchema: { type: "object", properties: { clientId: { type: "string" } }, required: ["clientId"] },
  },
];

function parse(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function eclipse(context: RunContext, world: World, request: Record<string, unknown>) {
  const id = request.id;
  const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  if (request.method === "initialize") {
    return rpcResult(id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "eclipse", version: "1" }, instructions: "Each brand is a client. Pass clientId on every call." });
  }
  if (request.method === "tools/list") return rpcResult(id, { tools: ECLIPSE_TOOLS });
  if (request.method !== "tools/call") return rpcResult(id, {});
  const args = params.arguments ?? {};
  context.eclipseCalls.push({ tool: params.name ?? "", args });
  const clients = world.eclipseClients;
  const text = (value: unknown) => rpcResult(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
  if (params.name === "list_clients") return text({ clients: clients.map((client) => ({ id: client.id, name: client.name })) });
  const client = clients.find((item) => item.id === args.clientId);
  if (!client) return text({ error: "Pass the clientId of an Eclipse client." });
  if (params.name === "get_geo_results") return text({ client: client.name, results: client.geo });
  return text({ client: client.name, articles: [] });
}

function urlOf(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageFrom(raw: Record<string, unknown>): Usage {
  const details = (raw.prompt_tokens_details ?? raw.input_tokens_details ?? {}) as Record<string, unknown>;
  const cacheRead = count(raw.cache_read_input_tokens);
  const cacheWrite = count(raw.cache_creation_input_tokens);
  if ("cache_read_input_tokens" in raw || "cache_creation_input_tokens" in raw) {
    return { input: count(raw.input_tokens) + cacheRead + cacheWrite, output: count(raw.output_tokens), cached: cacheRead, cacheWrite };
  }
  return {
    input: count(raw.prompt_tokens) || count(raw.input_tokens),
    output: count(raw.completion_tokens) || count(raw.output_tokens),
    cached: count(details.cached_tokens),
    cacheWrite: 0,
  };
}

function usageObjects(value: unknown, found: Record<string, unknown>[] = []) {
  if (!value || typeof value !== "object") return found;
  const record = value as Record<string, unknown>;
  if (record.usage && typeof record.usage === "object") found.push(record.usage as Record<string, unknown>);
  for (const key of ["message", "response"]) if (record[key] && typeof record[key] === "object") usageObjects(record[key], found);
  return found;
}

function mergeUsage(objects: Record<string, unknown>[]): Usage {
  const merged: Usage = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
  for (const object of objects) {
    const usage = usageFrom(object);
    merged.input = Math.max(merged.input, usage.input);
    merged.output = Math.max(merged.output, usage.output);
    merged.cached = Math.max(merged.cached, usage.cached);
    merged.cacheWrite = Math.max(merged.cacheWrite, usage.cacheWrite);
  }
  return merged;
}

async function readUsage(response: Response, model: string, kind: GatewayUsage["kind"], context: RunContext) {
  const text = await response.text().catch(() => "");
  const chunks = text.trim().startsWith("{")
    ? [parse(text)]
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => parse(line.slice(5).trim()));
  const usage = mergeUsage(chunks.flatMap((chunk) => usageObjects(chunk)));
  if (usage.input || usage.output) context.usage.push({ ...usage, model, kind });
}

function blocked() {
  return new Response("Outside requests are blocked while evaluations run.", { status: 503 });
}

async function gateway(context: RunContext, path: string, input: RequestInfo | URL, init?: RequestInit) {
  const url = urlOf(input);
  if (!context.world) return blocked();
  if (!MODEL_PATHS.some((item) => path === item || path.endsWith(item))) return context.passthrough(input, init);
  const body = parse(typeof init?.body === "string" ? init.body : "");
  const model = typeof body.model === "string" ? body.model : "unknown";
  const tools = Array.isArray(body.tools) ? (body.tools as { name?: string; function?: { name?: string } }[]) : [];
  let response: Response;
  if (tools.length === 0) response = await context.judge({ url, init, body, world: context.world, round: 0 });
  else {
    for (const tool of tools) {
      const name = tool.function?.name ?? tool.name;
      if (name) context.offeredTools.add(name);
    }
    context.rounds += 1;
    context.lastModelRequest = typeof init?.body === "string" ? init.body : "";
    response = await context.model({ url, init, body, world: context.world, round: context.rounds });
    context.lastGatewayError = response.ok ? null : `The gateway answered ${response.status}.`;
  }
  if (response.ok) context.reading.push(readUsage(response.clone(), model, tools.length > 0 ? "assistant" : "other", context));
  return response;
}

function serveWeb(context: RunContext, url: string, method: string) {
  const page = method === "GET" && context.world ? context.world.web.get(normalUrl(url)) : undefined;
  if (page !== undefined) return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
}

function record(context: RunContext, input: RequestInfo | URL, init?: RequestInit) {
  const url = urlOf(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  context.outbound.push({ url, method, body });
  return { url, method, body };
}

export const outsideFetch: typeof fetch = async (input, init) => {
  const context = store.getStore();
  const path = gatewayPath(urlOf(input));
  if (!context) return path !== null ? realFetch(input, init) : blocked();
  if (path !== null) return gateway(context, path, input, init);
  if (!context.world) return blocked();
  const { url, method, body } = record(context, input, init);
  if (url.startsWith(ECLIPSE_MCP_URL)) return eclipse(context, context.world, parse(body));
  if (url.startsWith(LINEAR_URL)) return Response.json({ data: { issues: { nodes: [] }, teams: { nodes: [] } } });
  return serveWeb(context, url, method);
};

const outsideWebFetch: typeof fetch = async (input, init) => {
  const context = store.getStore();
  if (!context?.world) return blocked();
  const { url, method } = record(context, input, init);
  return serveWeb(context, url, method);
};

export const outsideLookup = async (hostname: string) => {
  const world = store.getStore()?.world;
  return [world?.dns.get(hostname.toLowerCase()) ?? PUBLIC_ADDRESS];
};

const FAKE_ENV: Record<string, string | undefined> = {
  ECLIPSE_MCP_TOKEN: "eval-eclipse-token",
  ECLIPSE_MCP_URL,
  LINEAR_API_KEY: "eval-linear-key",
  LINEAR_API_URL: LINEAR_URL,
  PARALLEL_API_KEY: "eval-parallel-key",
  MINDCASE_API_KEY: "eval-mindcase-key",
  BROWSERBASE_API_KEY: undefined,
  BROWSERBASE_PROJECT_ID: undefined,
  NEXT_PUBLIC_SUPABASE_URL: "https://storage.eval.test",
  SUPABASE_SERVICE_ROLE_KEY: "eval-storage-key",
  SUPABASE_SECRET_KEY: undefined,
  SITE_URL: "https://orbit.eval.test",
  NEXT_PUBLIC_SITE_URL: undefined,
  READWISE_TOKEN: undefined,
  VERCEL: undefined,
};

export type Breach = { host: string; port: number | null; how: "connect" | "lookup" };

export const breaches: Breach[] = [];

type ConnectArgs = Parameters<net.Socket["connect"]>;

function target(args: unknown[]): { host: string; port: number | null; path: string | null } {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first && typeof first === "object") {
    const options = first as { host?: string; port?: number | string; path?: string };
    return { host: options.host ?? "localhost", port: options.port === undefined ? null : Number(options.port), path: options.path ?? null };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return { host: "", port: null, path: first };
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first === undefined ? null : Number(first), path: null };
}

function installTripwire(allowed: (host: string, port: number | null) => boolean) {
  const connect = net.Socket.prototype.connect;
  const lookup = dns.lookup;
  const promiseLookup = dns.promises.lookup;
  const allowName = (host: string) => allowed(host.toLowerCase(), null);
  net.Socket.prototype.connect = function guarded(this: net.Socket, ...args: unknown[]) {
    const where = target(args);
    if (where.path !== null || allowed(where.host.toLowerCase(), where.port)) return connect.apply(this, args as ConnectArgs);
    breaches.push({ host: where.host, port: where.port, how: "connect" });
    process.nextTick(() => this.destroy(new Error(`The evaluation tripwire blocked a connection to ${where.host}.`)));
    return this;
  } as net.Socket["connect"];
  dns.lookup = function guarded(hostname: string, ...rest: unknown[]) {
    if (allowName(hostname)) return (lookup as (...args: unknown[]) => unknown)(hostname, ...rest);
    breaches.push({ host: hostname, port: null, how: "lookup" });
    const callback = rest.find((item) => typeof item === "function") as ((error: Error) => void) | undefined;
    process.nextTick(() => callback?.(Object.assign(new Error(`The evaluation tripwire blocked a lookup of ${hostname}.`), { code: "ENOTFOUND" })));
  } as typeof dns.lookup;
  dns.promises.lookup = async function guarded(hostname: string, ...rest: unknown[]) {
    if (allowName(hostname)) return (promiseLookup as (...args: unknown[]) => Promise<unknown>)(hostname, ...rest);
    breaches.push({ host: hostname, port: null, how: "lookup" });
    throw Object.assign(new Error(`The evaluation tripwire blocked a lookup of ${hostname}.`), { code: "ENOTFOUND" });
  } as typeof dns.promises.lookup;
  return () => {
    net.Socket.prototype.connect = connect;
    dns.lookup = lookup;
    dns.promises.lookup = promiseLookup;
  };
}

function databaseHosts() {
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const raw of [process.env.DATABASE_URL, process.env.DATABASE_ADMIN_URL]) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase());
    } catch {
      continue;
    }
  }
  return hosts;
}

export function installOutside(options: { realGateway: boolean }) {
  const saved = Object.fromEntries(Object.keys(FAKE_ENV).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(FAKE_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const previous = globalThis.fetch;
  globalThis.fetch = outsideFetch;
  routeOutsideWeb({ fetchImpl: outsideWebFetch, lookup: outsideLookup });
  const local = databaseHosts();
  const gatewayHosts = options.realGateway ? new Set([gatewayBase().hostname.toLowerCase(), new URL(ANTHROPIC_ORIGIN).hostname]) : new Set<string>();
  const removeTripwire = installTripwire((host) => local.has(host) || gatewayHosts.has(host));
  return () => {
    removeTripwire();
    routeOutsideWeb(null);
    globalThis.fetch = previous;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export function newContext(options: Pick<RunContext, "model" | "judge" | "passthrough">): RunContext {
  return { ...options, world: null, outbound: [], eclipseCalls: [], offeredTools: new Set(), lastGatewayError: null, lastModelRequest: "", usage: [], reading: [], rounds: 0 };
}

export function inContext<T>(context: RunContext, work: () => Promise<T>) {
  clearEclipseToolCache();
  clearEclipseSourceCache();
  resetLinearCache();
  return store.run(context, work);
}

export function hostOf(raw: string) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}
