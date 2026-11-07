import { AsyncLocalStorage } from "node:async_hooks";
import { clearEclipseToolCache } from "@/lib/eclipse-mcp";
import { resetLinearCache } from "@/lib/linear";
import { normalUrl } from "./world";
import type { EclipseCall, OutboundRecord, World } from "./types";

const ECLIPSE_MCP_URL = "https://eclipse-mcp.eval.test/api/mcp";
const LINEAR_URL = "https://linear.eval.test/graphql";
const PUBLIC_ADDRESS = "93.184.216.34";
export const TRUSTED_HOSTS = new Set(["eclipse-mcp.eval.test", "linear.eval.test"]);

export type GatewayCall = { url: string; init?: RequestInit; body: Record<string, unknown>; world: World; round: number };

export type GatewayHandler = (call: GatewayCall) => Response | Promise<Response>;

export type RunContext = {
  world: World;
  model: GatewayHandler;
  judge: GatewayHandler;
  passthrough: typeof fetch;
  outbound: OutboundRecord[];
  eclipseCalls: EclipseCall[];
  offeredTools: Set<string>;
  gatewayErrors: string[];
  rounds: number;
};

const store = new AsyncLocalStorage<RunContext>();

export const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

function gatewayBase() {
  return (process.env.LLM_API_BASE_URL?.trim() || "https://api.llmapi.ai/v1").replace(/\/+$/, "");
}

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

function eclipse(context: RunContext, request: Record<string, unknown>) {
  const id = request.id;
  const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  if (request.method === "initialize") {
    return rpcResult(id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "eclipse", version: "1" }, instructions: "Each brand is a client. Pass clientId on every call." });
  }
  if (request.method === "tools/list") return rpcResult(id, { tools: ECLIPSE_TOOLS });
  if (request.method !== "tools/call") return rpcResult(id, {});
  const args = params.arguments ?? {};
  context.eclipseCalls.push({ tool: params.name ?? "", args });
  const clients = context.world.eclipseClients;
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

export const outsideFetch: typeof fetch = async (input, init) => {
  const context = store.getStore();
  const url = urlOf(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const base = gatewayBase();
  if (!context) {
    if (url.startsWith(base)) return realFetch(input, init);
    return new Response("Outside requests are blocked while evaluations run.", { status: 503 });
  }
  if (url.startsWith(base)) {
    const path = url.slice(base.length);
    if (path.startsWith("/chat/completions") || path.startsWith("/responses")) {
      const parsed = parse(body);
      const tools = Array.isArray(parsed.tools) ? (parsed.tools as { name?: string; function?: { name?: string } }[]) : [];
      if (tools.length === 0) return context.judge({ url, init, body: parsed, world: context.world, round: 0 });
      for (const tool of tools) {
        const name = tool.function?.name ?? tool.name;
        if (name) context.offeredTools.add(name);
      }
      context.rounds += 1;
      const response = await context.model({ url, init, body: parsed, world: context.world, round: context.rounds });
      if (!response.ok) context.gatewayErrors.push(`The gateway answered ${response.status}.`);
      return response;
    }
    return context.passthrough(input, init);
  }
  context.outbound.push({ url, method, body });
  if (url.startsWith(ECLIPSE_MCP_URL)) return eclipse(context, parse(body));
  if (url.startsWith(LINEAR_URL)) return Response.json({ data: { issues: { nodes: [] }, teams: { nodes: [] } } });
  const page = method === "GET" ? context.world.web.get(normalUrl(url)) : undefined;
  if (page !== undefined) return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
};

export const outsideLookup = async () => [PUBLIC_ADDRESS];

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

export function installOutside() {
  const saved = Object.fromEntries(Object.keys(FAKE_ENV).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(FAKE_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const previous = globalThis.fetch;
  globalThis.fetch = outsideFetch;
  return () => {
    globalThis.fetch = previous;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export async function withOutside<T>(context: Omit<RunContext, "outbound" | "eclipseCalls" | "offeredTools" | "gatewayErrors" | "rounds">, work: (context: RunContext) => Promise<T>) {
  clearEclipseToolCache();
  resetLinearCache();
  const full: RunContext = { ...context, outbound: [], eclipseCalls: [], offeredTools: new Set(), gatewayErrors: [], rounds: 0 };
  return store.run(full, () => work(full));
}

export function hostOf(raw: string) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}
