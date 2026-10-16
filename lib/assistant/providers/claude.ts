import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolUnion,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ProviderAuthError, ProviderError, type ProviderInput } from "@/lib/assistant/providers/shared";
import type { Completion, Source, ToolCall } from "@/lib/assistant/gateway";

const MAX_TOKENS = 32_000;
const MAX_CONTINUATIONS = 4;
const OAUTH_BETA = "oauth-2025-04-20";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

function toolId(id: string) {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return clean || "call";
}

function parseInput(raw: string) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function append(messages: BetaMessageParam[], role: "user" | "assistant", blocks: BetaContentBlockParam[]) {
  if (blocks.length === 0) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    last.content = [...last.content, ...blocks];
    return;
  }
  messages.push({ role, content: blocks });
}

export function claudeRequest(input: ProviderInput) {
  const system = input.messages.find((message) => message.role === "system")?.content ?? "";
  const messages: BetaMessageParam[] = [];
  for (const message of input.messages) {
    if (message.role === "tool") {
      append(messages, "user", [{ type: "tool_result", tool_use_id: toolId(message.tool_call_id), content: message.content || "{}" }]);
      continue;
    }
    if (message.role !== "assistant") {
      if (message.role === "user") append(messages, "user", [{ type: "text", text: message.content || " " }]);
      continue;
    }
    const calls = new Set((message.tool_calls ?? []).map((call) => toolId(call.id)));
    const state = message.state;
    if (state && state.model === input.modelId && Array.isArray(state.content)) {
      const blocks = (state.content as BetaContentBlockParam[]).filter(
        (block) => block.type !== "tool_use" || calls.has(toolId((block as { id: string }).id)),
      );
      append(messages, "assistant", blocks);
      continue;
    }
    const blocks: BetaContentBlockParam[] = [];
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const call of message.tool_calls ?? []) {
      blocks.push({ type: "tool_use", id: toolId(call.id), name: call.function.name, input: parseInput(call.function.arguments) });
    }
    append(messages, "assistant", blocks);
  }
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "Continue." }] });

  const tools: BetaToolUnion[] = input.tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: { type: "object", ...(tool.function.parameters ?? {}) } as { type: "object" },
  }));
  if (input.webSearch) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });

  const fallback = FALLBACK_MODELS.has(input.apiModel);
  const params: MessageCreateParamsNonStreaming = {
    model: input.apiModel,
    max_tokens: MAX_TOKENS,
    system: system ? [{ type: "text", text: system }] : undefined,
    messages,
    tools,
    tool_choice: { type: "auto" },
    thinking: { type: "adaptive" },
    output_config: { effort: input.reasoning as "low" | "medium" | "high" | "xhigh" | "max" },
    cache_control: { type: "ephemeral" },
    betas: fallback ? [OAUTH_BETA, FALLBACK_BETA] : [OAUTH_BETA],
    ...(fallback ? { fallbacks: "default" as const } : {}),
  };
  return params;
}

function readReply(content: BetaContentBlock[], stopReason: string | null) {
  const sources = new Map<string, Source>();
  const toolCalls: ToolCall[] = [];
  const text: string[] = [];
  const truncated = stopReason === "max_tokens";
  for (const block of content) {
    if (block.type === "text") {
      text.push(block.text);
      for (const citation of block.citations ?? []) {
        if (citation.type === "web_search_result_location" && /^https?:\/\//.test(citation.url) && !sources.has(citation.url)) {
          sources.set(citation.url, { url: citation.url, title: citation.title ?? null });
        }
      }
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result.type === "web_search_result" && /^https?:\/\//.test(result.url) && !sources.has(result.url)) {
          sources.set(result.url, { url: result.url, title: result.title ?? null });
        }
      }
    } else if (block.type === "tool_use" && !truncated) {
      toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
    }
  }
  const kept = truncated ? content.filter((block) => block.type !== "tool_use") : content;
  return { text: text.join("").trim(), toolCalls, sources: [...sources.values()].slice(0, 30), kept };
}

export function claudeErrorDetail(error: InstanceType<typeof Anthropic.APIError>) {
  const body = error.error as { error?: { message?: unknown; type?: unknown } } | undefined;
  const message = typeof body?.error?.message === "string" ? body.error.message : error.message;
  const type = typeof body?.error?.type === "string" ? body.error.type : null;
  const headers = error.headers;
  const retry = headers?.get("retry-after") ?? null;
  return {
    status: error.status ?? null,
    type,
    message: message.replace(/\s+/g, " ").trim().slice(0, 300),
    retryAfter: retry,
    requestId: error.requestID ?? headers?.get("request-id") ?? null,
    headers: headers
      ? Object.fromEntries(
          [...headers.entries()].filter(([key]) => /^(retry-after|anthropic-ratelimit-|x-should-retry|request-id|anthropic-organization-id)/.test(key)),
        )
      : {},
  };
}

function describeError(error: InstanceType<typeof Anthropic.APIError>) {
  const detail = claudeErrorDetail(error);
  const parts = [`Claude returned ${detail.status}${detail.type ? ` (${detail.type})` : ""}: ${detail.message}`];
  if (detail.retryAfter) parts.push(`Retry after ${detail.retryAfter}s.`);
  if (detail.requestId) parts.push(`Request ${detail.requestId}.`);
  console.error("Claude account request failed", detail);
  return parts.join(" ");
}

export async function completeClaude(input: ProviderInput & { token: string }): Promise<Completion> {
  const client = new Anthropic({
    apiKey: null,
    authToken: input.token,
    maxRetries: 1,
    timeout: input.timeoutMs,
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
  });
  const params = claudeRequest(input);
  const content: BetaContentBlock[] = [];
  let last: BetaMessage | null = null;
  try {
    for (let round = 0; round <= MAX_CONTINUATIONS; round += 1) {
      const messages = content.length > 0 ? [...params.messages, { role: "assistant" as const, content: content as BetaContentBlockParam[] }] : params.messages;
      last = await client.beta.messages.stream({ ...params, messages }).finalMessage();
      content.push(...last.content);
      if (last.stop_reason !== "pause_turn") break;
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new ProviderAuthError(describeError(error));
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      throw new ProviderError("Claude took too long to reply. Try again, or pick a lower reasoning level.");
    }
    if (error instanceof Anthropic.APIError && typeof error.status === "number") {
      throw new ProviderError(describeError(error));
    }
    if (error instanceof Anthropic.APIError) throw new ProviderError("Couldn't reach Claude.");
    throw error;
  }
  const reply = readReply(content, last?.stop_reason ?? null);
  const refused = last?.stop_reason === "refusal" && !reply.text && reply.toolCalls.length === 0;
  return {
    content: refused ? "Claude declined to answer that one. Try rephrasing it, or pick another model." : reply.text,
    toolCalls: reply.toolCalls,
    sources: reply.sources,
    model: input.modelId,
    usage: last?.usage ? (JSON.parse(JSON.stringify(last.usage)) as Record<string, unknown>) : null,
    state: { model: input.modelId, content: reply.kept },
  };
}
