import { randomUUID } from "node:crypto";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type * as AgentSdk from "@anthropic-ai/claude-agent-sdk";
import type {
  CompanionCall,
  CompanionRequest,
  CompanionResult,
  CompanionSource,
  CompanionSteer,
  CompanionSteered,
  CompanionStep,
  CompanionToolResult,
} from "./protocol";
import { PROPOSED } from "./protocol";
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
  steers?: () => Promise<CompanionSteer[]>;
  steerEveryMs?: number;
};

const SERVER = "orbit";
const PREFIX = `mcp__${SERVER}__`;
const MAX_TURNS = 40;
const MCP_OUTPUT_TOKENS = "60000";
const STEER_EVERY_MS = 3_000;

export const STOPPED = "Stopped after a lot of steps. Say \"carry on\" or narrow the question.";
export const CUT_OFF = "The answer was cut off. Ask me to continue.";

export { PROPOSED };

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

function userMessage(id: string, text: string, composed = false): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: id as SDKUserMessage["uuid"],
    ...(composed ? { client_composed: true as const } : {}),
  };
}

function echoedIds(message: unknown) {
  const ids = (message as { user_message_uuids?: unknown }).user_message_uuids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function inbox(first: SDKUserMessage) {
  const queue: SDKUserMessage[] = [first];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  }
  return {
    messages,
    push(message: SDKUserMessage) {
      if (closed) return false;
      queue.push(message);
      wake?.();
      return true;
    },
    close() {
      closed = true;
      wake?.();
    },
    get closed() {
      return closed;
    },
  };
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
  let cutOff = false;
  let turnCut = false;

  let draft = "";
  const input = deps.steers ? inbox(userMessage(randomUUID(), request.prompt)) : null;
  const pushed: CompanionSteered[] = [];
  const seenSteers = new Set<string>();
  const consumed = new Set<string>();
  let started = 0;
  let polling = false;
  const poll = async () => {
    if (!deps.steers || !input || input.closed || polling) return;
    polling = true;
    try {
      for (const steer of await deps.steers()) {
        if (seenSteers.has(steer.id) || input.closed) continue;
        seenSteers.add(steer.id);
        if (input.push(userMessage(steer.id, steer.text, true))) pushed.push({ id: steer.id, step: started });
      }
    } catch {
      return;
    } finally {
      polling = false;
    }
  };
  const timer = input ? setInterval(() => void poll(), deps.steerEveryMs ?? STEER_EVERY_MS) : null;
  abort.signal.addEventListener("abort", () => input?.close(), { once: true });
  const stream = deps.sdk.query({ prompt: input ? input.messages() : request.prompt, options: turnOptions(request, { [SERVER]: server }, deps, abort) });
  try {
    for await (const message of stream as AsyncIterable<SDKMessage>) {
      if (message.type === "stream_event") {
        if (message.parent_tool_use_id) continue;
        const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === "message_start") {
          draft = "";
          started += 1;
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          draft += event.delta.text;
          deps.onDraft?.(draft);
        }
      } else if (message.type === "assistant") {
        if (message.parent_tool_use_id) continue;
        const id = message.message.id ?? message.uuid;
        const step = steps.get(id) ?? { text: "", calls: [] };
        steps.set(id, step);
        model = message.message.model ?? model;
        if (message.error === "max_output_tokens") turnCut = true;
        for (const echoed of echoedIds(message)) {
          const entry = pushed.find((item) => item.id === echoed);
          if (entry && !consumed.has(echoed)) entry.step = [...steps.keys()].indexOf(id);
          consumed.add(echoed);
        }
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
        cutOff = turnCut || message.stop_reason === "max_tokens";
        turnCut = false;
        stopped = message.subtype === "error_max_turns";
        failure = null;
        if (stopped) failure = null;
        else if (message.subtype !== "success") failure = message.errors.join(" ") || "Claude Code stopped before finishing.";
        else if (message.is_error && !cutOff) failure = message.result || "Claude Code couldn't answer.";
        for (const echoed of echoedIds(message)) consumed.add(echoed);
        const queued = (message as { queued_turn_count?: unknown }).queued_turn_count;
        if (!(typeof queued === "number" && queued > 0)) input?.close();
      }
    }
  } finally {
    if (timer) clearInterval(timer);
    input?.close();
  }
  if (failure) throw new Error(failure);
  const ending = stopped ? STOPPED : cutOff ? CUT_OFF : null;
  const finished = ending ? [...steps.values(), { text: ending, calls: [] }] : [...steps.values()];
  const steered = pushed.filter((entry) => consumed.has(entry.id));
  return { steps: finished, results, sources: [...sources.values()], model, usage, ...(steered.length > 0 ? { steered } : {}) };
}
