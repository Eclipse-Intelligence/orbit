import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, Completion, Source, ToolCall } from "@/lib/assistant/gateway";
import { ProviderError, REFUSED_NOTICE, replayContent, type FunctionTool } from "@/lib/assistant/providers/shared";

export const ANTHROPIC_STATE = "anthropic";
export const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const PAUSE_RESUMES = 3;
const MIN_STEP_MS = 5_000;
const THINKING = new Set(["thinking", "redacted_thinking"]);
const REFUSED_REPLY = "The model declined to answer that. Try rephrasing it, or pick another model.";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const SIGNATURE_REJECTED = /Invalid `signature` in `thinking` block|bound to a different conversation/i;
const BINDING_REJECTED = /block_binding|thinking-binding-controls|anthropic-beta/i;

export class MessagesRefusedError extends ProviderError {}
export class ThinkingRejectedError extends ProviderError {}
export class BindingRejectedError extends ProviderError {}
export class ModelTimeoutError extends ProviderError {}

export type AnthropicInput = {
  modelId: string;
  apiModel: string;
  reasoning: string;
  messages: ChatMessage[];
  webSearch: boolean;
  tools: FunctionTool[];
  maxTokens: number;
  binding?: boolean;
};

export type AnthropicRoute = { baseURL: string; apiKey?: string; authToken?: string };

type Block = Anthropic.ContentBlockParam;

function toolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function assistantBlocks(message: Extract<ChatMessage, { role: "assistant" }>, input: AnthropicInput): Block[] {
  const calls = new Map((message.tool_calls ?? []).map((call) => [call.id, call]));
  const state = message.state;
  if (!state?.refused && state?.format === ANTHROPIC_STATE && state.model === input.modelId && Array.isArray(state.content)) {
    const kept = (state.content as Block[]).filter((block) => block.type !== "tool_use" || calls.has(block.id));
    const covered = new Set(kept.flatMap((block) => (block.type === "tool_use" ? [block.id] : [])));
    if ([...calls.keys()].every((id) => covered.has(id)) && kept.some((block) => !THINKING.has(block.type))) return kept;
  }
  const blocks: Block[] = [];
  const text = replayContent(message);
  if (text?.trim()) blocks.push({ type: "text", text });
  for (const call of calls.values()) blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: toolInput(call.function.arguments) });
  return blocks;
}

function webSearchTool(apiModel: string): Anthropic.ToolUnion {
  return apiModel.startsWith("claude-haiku")
    ? { type: "web_search_20250305", name: "web_search" }
    : { type: "web_search_20260209", name: "web_search" };
}

export function anthropicRequest(input: AnthropicInput): Anthropic.MessageStreamParams {
  const system = input.messages
    .flatMap((message) => (message.role === "system" ? [message.content] : []))
    .join("\n\n");
  const messages: Anthropic.MessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const message of input.messages) {
    if (message.role === "assistant") push("assistant", assistantBlocks(message, input));
    else if (message.role === "tool") push("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content || "{}" }]);
    else if (message.role === "user") push("user", [{ type: "text", text: message.content.trim() ? message.content : "(empty message)" }]);
  }
  const effort = EFFORTS.find((level) => level === input.reasoning) ?? "medium";
  const tools: Anthropic.ToolUnion[] = [
    ...input.tools.map(
      (tool): Anthropic.Tool => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: (tool.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
      }),
    ),
    ...(input.webSearch ? [webSearchTool(input.apiModel)] : []),
  ];
  const thinking = input.binding === false ? { type: "adaptive" as const } : ({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } } as unknown as Anthropic.ThinkingConfigParam);
  return {
    model: input.apiModel,
    max_tokens: input.maxTokens,
    ...(system ? { system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }] } : {}),
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: { type: "auto" as const } } : {}),
    thinking,
    output_config: { effort },
    cache_control: { type: "ephemeral" },
  };
}

function readSources(blocks: Anthropic.ContentBlock[]) {
  const found = new Map<string, Source>();
  const add = (url: unknown, title: unknown) => {
    if (typeof url === "string" && /^https?:\/\//.test(url) && !found.has(url)) found.set(url, { url, title: typeof title === "string" ? title : null });
  };
  for (const block of blocks) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) for (const result of block.content) add(result.url, result.title);
    if (block.type === "text") for (const citation of block.citations ?? []) if (citation.type === "web_search_result_location") add(citation.url, citation.title);
  }
  return [...found.values()].slice(0, 30);
}

function answeredServerTools(blocks: Anthropic.ContentBlock[]) {
  const answered = new Set(blocks.flatMap((block) => ("tool_use_id" in block && typeof block.tool_use_id === "string" ? [block.tool_use_id] : [])));
  return blocks.filter((block) => block.type !== "server_tool_use" || answered.has(block.id));
}

export function readMessage(message: Pick<Anthropic.Message, "content" | "stop_reason" | "usage" | "model">, modelId: string): Completion {
  const content = answeredServerTools(message.content);
  const text = content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  const toolCalls: ToolCall[] = content.flatMap((block) =>
    block.type === "tool_use" ? [{ id: block.id, type: "function" as const, function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }] : [],
  );
  const refused = message.stop_reason === "refusal";
  return {
    content: refused ? (text ? `${text}\n\n${REFUSED_NOTICE}` : REFUSED_REPLY) : text,
    toolCalls: refused ? [] : toolCalls,
    sources: readSources(content),
    model: message.model || modelId,
    usage: message.usage ? (message.usage as unknown as Record<string, unknown>) : null,
    state: { model: modelId, format: ANTHROPIC_STATE, content, ...(refused ? { refused: true } : {}) },
    cutOff: message.stop_reason === "max_tokens",
    contextFull: message.stop_reason === "model_context_window_exceeded",
  };
}

function failure(error: unknown, outer: AbortSignal | undefined): never {
  if (error instanceof Anthropic.APIUserAbortError) {
    if (outer?.aborted) throw error;
    throw new ModelTimeoutError("The model took too long to reply. Try again, or pick a lower reasoning level.");
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) throw new ModelTimeoutError("The model took too long to reply. Try again, or pick a lower reasoning level.");
  if (error instanceof Anthropic.APIConnectionError) throw new ProviderError("Could not reach the model API.");
  if (error instanceof Anthropic.APIError) {
    const detail = (error.message || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (typeof error.status !== "number") throw new ProviderError(`The model stopped: ${detail || "unknown error"}`);
    const message = `The model API returned ${error.status}${detail ? `: ${detail}` : "."}`;
    if (error.status === 400 && SIGNATURE_REJECTED.test(detail)) throw new ThinkingRejectedError(message);
    if (error.status === 400 && BINDING_REJECTED.test(detail)) throw new BindingRejectedError(message);
    if ([400, 404, 405, 415, 422].includes(error.status)) throw new MessagesRefusedError(message);
    throw new ProviderError(message);
  }
  throw error;
}

export function withoutThinking(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || message.state?.format !== ANTHROPIC_STATE) return message;
    return { ...message, state: { ...message.state, content: (message.state.content as Block[]).filter((block) => !THINKING.has(block.type)) } };
  });
}

export async function completeAnthropic(
  input: AnthropicInput & { route: AnthropicRoute; timeoutMs: number; fetchImpl?: typeof fetch; signal?: AbortSignal; onText?: (text: string) => void },
): Promise<Completion> {
  const until = Date.now() + input.timeoutMs;
  const client = new Anthropic({
    apiKey: input.route.apiKey ?? null,
    authToken: input.route.authToken ?? null,
    baseURL: input.route.baseURL,
    maxRetries: 1,
    timeout: input.timeoutMs,
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
  });
  const binding = input.binding !== false;
  let params = anthropicRequest(input);
  const content: Anthropic.ContentBlock[] = [];
  let streamed = "";
  let last: Anthropic.Message | null = null;
  try {
    for (let step = 0; step <= PAUSE_RESUMES; step += 1) {
      const left = until - Date.now();
      if (left < MIN_STEP_MS) {
        if (last) break;
        throw new ModelTimeoutError("The model took too long to reply. Try again, or pick a lower reasoning level.");
      }
      const limit = AbortSignal.timeout(left);
      const signal = input.signal ? AbortSignal.any([input.signal, limit]) : limit;
      const stream = client.messages.stream(params, { signal, timeout: left, ...(binding ? { headers: { "anthropic-beta": BINDING_BETA } } : {}) });
      stream.on("text", (delta) => {
        streamed += delta;
        input.onText?.(streamed);
      });
      last = await stream.finalMessage();
      content.push(...last.content);
      if (last.stop_reason !== "pause_turn") break;
      params = { ...params, messages: [...params.messages, { role: "assistant", content: last.content as Block[] }] };
    }
  } catch (error) {
    failure(error, input.signal);
  }
  if (!last) throw new ProviderError("The model sent nothing back.");
  return readMessage({ ...last, content }, input.modelId);
}
