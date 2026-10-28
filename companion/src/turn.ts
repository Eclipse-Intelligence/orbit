import { randomUUID } from "node:crypto";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type * as AgentSdk from "@anthropic-ai/claude-agent-sdk";
import type {
  CompanionCall,
  CompanionRequest,
  CompanionResult,
  CompanionSource,
  CompanionStep,
  CompanionToolResult,
} from "./protocol";
import { shapeFor } from "./schema";

export type Sdk = Pick<typeof AgentSdk, "query" | "createSdkMcpServer" | "tool">;

type TurnDeps = {
  sdk: Sdk;
  callTool: (call: CompanionCall) => Promise<CompanionToolResult>;
  cwd: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  onTool?: (name: string) => void;
  onDraft?: (text: string) => void;
};

const SERVER = "orbit";
const PREFIX = `mcp__${SERVER}__`;
const MAX_TURNS = 40;
const MCP_OUTPUT_TOKENS = "60000";

export const STOPPED = "I've stopped after a lot of steps. Ask again more narrowly, or say \"carry on\".";

export const PROPOSED =
  "Proposed. Orbit will show this change to the user for approval. It has not happened yet. Do not call this tool again for the same change. When you have proposed everything, say in one or two sentences what you proposed and stop.";

const STRIPPED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

export function cleanEnv(env: Record<string, string | undefined>) {
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !STRIPPED_ENV.includes(key)) copy[key] = value;
  }
  return copy;
}

function turnOptions(request: CompanionRequest, server: Options["mcpServers"], deps: Pick<TurnDeps, "cwd" | "env">, abort: AbortController): Options {
  const web = request.webSearch ? ["WebSearch"] : [];
  return {
    model: request.model,
    effort: request.effort,
    systemPrompt: request.system,
    tools: web,
    allowedTools: [...request.tools.map((tool) => `${PREFIX}${tool.name}`), ...web],
    mcpServers: server,
    strictMcpConfig: true,
    settingSources: [],
    cwd: deps.cwd,
    permissionMode: "dontAsk",
    persistSession: false,
    includePartialMessages: true,
    maxTurns: MAX_TURNS,
    env: { ...cleanEnv(deps.env), MAX_MCP_OUTPUT_TOKENS: MCP_OUTPUT_TOKENS },
    abortController: abort,
  };
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("");
}

function collectSources(value: unknown, into: Map<string, CompanionSource>, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6 || into.size >= 30) return;
  if (Array.isArray(value)) {
    for (const item of value) collectSources(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.url === "string" && /^https?:\/\//.test(record.url) && !into.has(record.url)) {
    into.set(record.url, { url: record.url, title: typeof record.title === "string" ? record.title : null });
  }
  for (const nested of Object.values(record)) collectSources(nested, into, depth + 1);
}

export async function runTurn(request: CompanionRequest, deps: TurnDeps): Promise<CompanionResult> {
  const server = deps.sdk.createSdkMcpServer({
    name: SERVER,
    version: "1.0.0",
    tools: request.tools.map((definition) =>
      deps.sdk.tool(definition.name, definition.description, shapeFor(definition.parameters), async (args) => {
        if (definition.write) return { content: [{ type: "text" as const, text: PROPOSED }] };
        deps.onTool?.(definition.name);
        const result = await deps.callTool({ id: randomUUID(), name: definition.name, arguments: JSON.stringify(args ?? {}) });
        return { content: [{ type: "text" as const, text: result.content }], isError: result.isError };
      }),
    ),
  });

  const abort = new AbortController();
  deps.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const steps = new Map<string, CompanionStep>();
  const results: Record<string, CompanionToolResult> = {};
  const sources = new Map<string, CompanionSource>();
  const webCalls = new Set<string>();
  let model: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let failure: string | null = null;
  let stopped = false;

  let draft = "";
  const stream = deps.sdk.query({ prompt: request.prompt, options: turnOptions(request, { [SERVER]: server }, deps, abort) });
  for await (const message of stream as AsyncIterable<SDKMessage>) {
    if (message.type === "stream_event") {
      if (message.parent_tool_use_id) continue;
      const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
      if (event.type === "message_start") draft = "";
      else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        draft += event.delta.text;
        deps.onDraft?.(draft);
      }
    } else if (message.type === "assistant") {
      if (message.parent_tool_use_id) continue;
      const id = message.message.id ?? message.uuid;
      const step = steps.get(id) ?? { text: "", calls: [] };
      steps.set(id, step);
      model = message.message.model ?? model;
      for (const block of message.message.content ?? []) {
        if (block.type === "text" && block.text) {
          step.text = step.text ? `${step.text}\n\n${block.text}` : block.text;
        } else if (block.type === "tool_use") {
          if (block.name.startsWith(PREFIX)) {
            step.calls.push({ id: block.id, name: block.name.slice(PREFIX.length), arguments: JSON.stringify(block.input ?? {}) });
          } else if (block.name === "WebSearch") {
            webCalls.add(block.id);
          }
        }
      }
    } else if (message.type === "user") {
      if (message.parent_tool_use_id) continue;
      const content = message.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        if (webCalls.has(block.tool_use_id)) {
          collectSources(message.tool_use_result, sources);
          continue;
        }
        results[block.tool_use_id] = { content: text(block.content), isError: block.is_error === true };
      }
    } else if (message.type === "result") {
      usage = (message.usage as unknown as Record<string, unknown>) ?? null;
      if (message.subtype === "error_max_turns") stopped = true;
      else if (message.subtype !== "success") failure = message.errors.join(" ") || "Claude Code stopped before finishing.";
      else if (message.is_error) failure = message.result || "Claude Code couldn't answer.";
    }
  }
  if (failure) throw new Error(failure);
  const finished = stopped ? [...steps.values(), { text: STOPPED, calls: [] }] : [...steps.values()];
  return { steps: finished, results, sources: [...sources.values()], model, usage };
}
