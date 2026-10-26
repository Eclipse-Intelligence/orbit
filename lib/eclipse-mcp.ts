import { randomUUID } from "node:crypto";

const DEFAULT_URL = "https://app.geteclipse.co/api/mcp";
const LIST_TTL_MS = 10 * 60_000;
const RESULT_MAX = 30_000;

export type EclipseTool = { name: string; description: string; inputSchema: Record<string, unknown> };

export class EclipseMcpError extends Error {}

let listed: { at: number; tools: EclipseTool[] } | null = null;

export function eclipseMcpConfigured() {
  return Boolean(process.env.ECLIPSE_MCP_TOKEN?.trim());
}

export function clearEclipseToolCache() {
  listed = null;
  guide = null;
}

async function rpc(method: string, params: Record<string, unknown>, fetchImpl: typeof fetch) {
  if (!eclipseMcpConfigured()) throw new EclipseMcpError("Eclipse isn't connected. Add ECLIPSE_MCP_TOKEN in Vercel.");
  const response = await fetchImpl(process.env.ECLIPSE_MCP_URL?.trim() || DEFAULT_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.ECLIPSE_MCP_TOKEN!.trim()}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new EclipseMcpError("Eclipse refused the token. Check ECLIPSE_MCP_TOKEN.");
  if (!response.ok) throw new EclipseMcpError(`Eclipse answered ${response.status}.`);
  const json = text.trim().startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .pop() ?? "{}";
  const message = JSON.parse(json) as { result?: Record<string, unknown>; error?: { message?: string } };
  if (message.error) throw new EclipseMcpError(`Eclipse: ${message.error.message ?? "the call failed"}.`);
  return message.result ?? {};
}

let guide: { at: number; text: string } | null = null;

export async function eclipseGuide(options: { fetchImpl?: typeof fetch } = {}) {
  if (guide && Date.now() - guide.at < 60 * 60_000) return guide.text;
  const result = (await rpc(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "orbit", version: "1" } },
    options.fetchImpl ?? fetch,
  )) as { instructions?: string };
  const text = result.instructions?.trim() || "Eclipse didn't send a guide. Use eclipse_tools with query 'agent guide'.";
  guide = { at: Date.now(), text };
  return text;
}

export async function eclipseTools(options: { fetchImpl?: typeof fetch } = {}) {
  if (listed && Date.now() - listed.at < LIST_TTL_MS) return listed.tools;
  const tools: EclipseTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = (await rpc("tools/list", cursor ? { cursor } : {}, options.fetchImpl ?? fetch)) as { tools?: EclipseTool[]; nextCursor?: string };
    tools.push(...(result.tools ?? []));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  listed = { at: Date.now(), tools };
  return tools;
}

export function readOnly(tool: EclipseTool) {
  return /^(get|list|search|browse)_/.test(tool.name) || /^geo_(list_|overview|platforms|trends|tracking|profile_analytics|history|insights)/.test(tool.name) || /changes nothing/i.test(tool.description);
}

export function confirmGated(tool: EclipseTool) {
  const properties = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
  return "confirm" in properties;
}

export async function findEclipseTools(query: string, options: { fetchImpl?: typeof fetch; limit?: number } = {}) {
  const tools = await eclipseTools(options);
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
  const scored = tools
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      const score = words.reduce((sum, word) => sum + (name.includes(word) ? 3 : 0) + (description.includes(word) ? 1 : 0), 0);
      return { tool, score };
    })
    .filter((item) => words.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, Math.min(options.limit ?? 8, 20));
  return {
    total: tools.length,
    tools: scored.map(({ tool }) => ({
      name: tool.name,
      kind: readOnly(tool) ? "read" : confirmGated(tool) ? "needs approval (costs or consequences, can be previewed)" : "needs approval (changes data)",
      description: tool.description.slice(0, 1200),
      input: tool.inputSchema,
    })),
  };
}

function resultText(result: Record<string, unknown>) {
  const content = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]) : [];
  const text = content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  const body = text || JSON.stringify(result.structuredContent ?? result);
  return body.length > RESULT_MAX ? `${body.slice(0, RESULT_MAX)}\n[Cut at ${RESULT_MAX} characters. Ask for less, for example with a limit or filter.]` : body;
}

export async function callEclipseTool(
  name: string,
  args: Record<string, unknown>,
  mode: "read" | "action",
  options: { fetchImpl?: typeof fetch; idempotencyKey?: string } = {},
) {
  const tools = await eclipseTools(options);
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new EclipseMcpError(`Eclipse has no tool called ${name}. Use eclipse_tools to find the right one.`);
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "confirm" && key !== "idempotencyKey"));
  let params = rest;
  if (mode === "read") {
    if (!readOnly(tool) && !confirmGated(tool)) {
      throw new EclipseMcpError(`${name} changes data in Eclipse, so it needs the user's approval. Use eclipse_action.`);
    }
  } else if (confirmGated(tool)) {
    params = { ...rest, confirm: true, idempotencyKey: options.idempotencyKey ?? randomUUID() };
  }
  const result = await rpc("tools/call", { name, arguments: params }, options.fetchImpl ?? fetch);
  return {
    tool: name,
    preview: mode === "read" && confirmGated(tool) ? "This was a preview only. Nothing ran and nothing was charged. Use eclipse_action to run it after the user approves." : undefined,
    isError: result.isError === true,
    result: resultText(result),
  };
}
