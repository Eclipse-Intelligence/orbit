import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, Completion, Source, ToolCall } from "@/lib/assistant/gateway";
import { ProviderError, type FunctionTool } from "@/lib/assistant/providers/shared";

export const ANTHROPIC_STATE = "anthropic";
const PAUSE_LIMIT = 3;
const THINKING = new Set(["thinking", "redacted_thinking"]);
const CUT_OFF = new Set(["max_tokens", "model_context_window_exceeded"]);
const REFUSED_REPLY = "The model declined to answer that. Try rephrasing it, or pick another model.";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export class MessagesRefusedError extends ProviderError {}
export class ThinkingRejectedError extends ProviderError {}

export type AnthropicInput = {
  modelId: string;
  apiModel: string;
  reasoning: string;
  messages: ChatMessage[];
  webSearch: boolean;
  tools: FunctionTool[];
  maxTokens: number;
  keepThinking: boolean;
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

function assistantBlocks(message: Extract<ChatMessage, { role: "assistant" }>, input: AnthropicInput, keepThinking: boolean): Block[] {
  const calls = new Map((message.tool_calls ?? []).map((call) => [call.id, call]));
  const state = message.state;
  if (state?.format === ANTHROPIC_STATE && state.model === input.modelId && Array.isArray(state.content)) {
    const stored = state.content as Block[];
    const kept = stored.filter((block) => {
      if (THINKING.has(block.type)) return keepThinking;
      if (block.type === "tool_use") return calls.has(block.id);
      return true;
    });
    const covered = new Set(kept.flatMap((block) => (block.type === "tool_use" ? [block.id] : [])));
    if ([...calls.keys()].every((id) => covered.has(id)) && kept.some((block) => !THINKING.has(block.type))) return kept;
  }
  const blocks: Block[] = [];
  if (message.content?.trim()) blocks.push({ type: "text", text: message.content });
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
  const turn = input.messages.map((message) => message.role).lastIndexOf("user");
  const messages: Anthropic.MessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  input.messages.forEach((message, index) => {
    if (message.role === "assistant") push("assistant", assistantBlocks(message, input, input.keepThinking && index > turn));
    else if (message.role === "tool") push("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content || "{}" }]);
    else if (message.role === "user") push("user", [{ type: "text", text: message.content.trim() ? message.content : "(empty message)" }]);
  });
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
  return {
    model: input.apiModel,
    max_tokens: input.maxTokens,
    ...(system ? { system } : {}),
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: { type: "auto" as const } } : {}),
    thinking: { type: "adaptive" },
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

export function readMessage(message: Pick<Anthropic.Message, "content" | "stop_reason" | "usage" | "model">, modelId: string): Completion {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  const toolCalls: ToolCall[] = message.content.flatMap((block) =>
    block.type === "tool_use" ? [{ id: block.id, type: "function" as const, function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }] : [],
  );
  const refused = message.stop_reason === "refusal";
  return {
    content: refused && !text ? REFUSED_REPLY : text,
    toolCalls: refused ? [] : toolCalls,
    sources: readSources(message.content),
    model: message.model || modelId,
    usage: message.usage ? (message.usage as unknown as Record<string, unknown>) : null,
    state: { model: modelId, format: ANTHROPIC_STATE, content: message.content },
    cutOff: CUT_OFF.has(message.stop_reason ?? ""),
  };
}

function failure(error: unknown): never {
  if (error instanceof Anthropic.APIUserAbortError) throw error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderError("The model took too long to reply. Try again, or pick a lower reasoning level.");
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    const detail = (error.message || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const message = `The model API returned ${error.status}${detail ? `: ${detail}` : "."}`;
    if (error.status === 400 && /signature|thinking/i.test(detail)) throw new ThinkingRejectedError(message);
    if ([400, 404, 405, 415, 422].includes(error.status)) throw new MessagesRefusedError(message);
    throw new ProviderError(message);
  }
  if (error instanceof Anthropic.APIConnectionError) throw new ProviderError("Could not reach the model API.");
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
  const client = new Anthropic({
    apiKey: input.route.apiKey ?? null,
    authToken: input.route.authToken ?? null,
    baseURL: input.route.baseURL,
    maxRetries: 1,
    timeout: input.timeoutMs,
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
  });
  let params = anthropicRequest(input);
  const content: Anthropic.ContentBlock[] = [];
  let streamed = "";
  try {
    for (let step = 0; step < PAUSE_LIMIT; step += 1) {
      const stream = client.messages.stream(params, { signal: input.signal, timeout: input.timeoutMs });
      stream.on("text", (delta) => {
        streamed += delta;
        input.onText?.(streamed);
      });
      const message = await stream.finalMessage();
      content.push(...message.content);
      if (message.stop_reason !== "pause_turn" || step === PAUSE_LIMIT - 1) return readMessage({ ...message, content }, input.modelId);
      params = { ...params, messages: [...params.messages, { role: "assistant", content: message.content }] };
    }
  } catch (error) {
    failure(error);
  }
  throw new ProviderError("The model sent nothing back.");
}
