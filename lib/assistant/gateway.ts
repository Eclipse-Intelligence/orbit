import { OAuthError } from "@/lib/ai-accounts/oauth";
import { aiAccess, noteAiError } from "@/lib/ai-accounts/store";
import { assistantModel } from "@/lib/assistant/models";
import { chatGptRequest, completeChatGpt, readResponses } from "@/lib/assistant/providers/chatgpt";
import { ProviderAuthError, ProviderError, type FunctionTool } from "@/lib/assistant/providers/shared";
import { toolDefinitions } from "@/lib/assistant/tools";
import type { UserActor } from "@/lib/crm/types";

const DEFAULT_BASE_URL = "https://api.llmapi.ai/v1";
const MAX_TOKENS = 16_000;

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ProviderState = { model: string; content: unknown[] };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; state?: ProviderState | null }
  | { role: "tool"; tool_call_id: string; content: string };

export type Source = { url: string; title: string | null };

export type Completion = {
  content: string;
  toolCalls: ToolCall[];
  sources: Source[];
  model: string;
  usage: Record<string, unknown> | null;
  state?: ProviderState | null;
};

export class AssistantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantError";
  }
}

function simplifySchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(simplifySchema);
  if (!schema || typeof schema !== "object") return schema;
  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "enum" && Array.isArray(value) && value.some((item) => typeof item !== "string")) {
      const list = value.join(", ");
      output.description = `${typeof input.description === "string" ? `${input.description} ` : ""}One of: ${list}.`;
      continue;
    }
    if (key === "minimum" || key === "maximum" || key === "additionalProperties") continue;
    if (key === "description" && "description" in output) continue;
    output[key] = simplifySchema(value);
  }
  return output;
}

export function geminiTool(tool: unknown) {
  const definition = tool as { type?: string; function?: { name: string; description?: string; parameters?: Record<string, unknown> } };
  if (definition.type !== "function" || !definition.function) return tool;
  const parameters = definition.function.parameters;
  const properties = parameters?.properties as Record<string, unknown> | undefined;
  const fn: Record<string, unknown> = { name: definition.function.name, description: definition.function.description };
  if (parameters && properties && Object.keys(properties).length > 0) fn.parameters = simplifySchema(parameters);
  return { type: "function", function: fn };
}

function baseUrl() {
  return (process.env.LLM_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function gatewayConfigured() {
  return Boolean(process.env.LLM_API_KEY?.trim());
}

function text(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function readSources(message: Record<string, unknown>, body: Record<string, unknown>) {
  const found = new Map<string, Source>();
  const annotations = Array.isArray(message.annotations) ? message.annotations : [];
  for (const annotation of annotations) {
    const citation = (annotation as { url_citation?: { url?: unknown; title?: unknown } })?.url_citation;
    if (citation && typeof citation.url === "string" && /^https?:\/\//.test(citation.url)) {
      found.set(citation.url, { url: citation.url, title: typeof citation.title === "string" ? citation.title : null });
    }
  }
  const citations = Array.isArray(body.citations) ? body.citations : [];
  for (const entry of citations) {
    const url = typeof entry === "string" ? entry : (entry as { url?: unknown })?.url;
    if (typeof url === "string" && /^https?:\/\//.test(url) && !found.has(url)) found.set(url, { url, title: null });
  }
  return [...found.values()].slice(0, 30);
}

function readToolCalls(message: Record<string, unknown>) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls
    .map((call, index): ToolCall | null => {
      const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function;
      if (!fn || typeof fn.name !== "string") return null;
      const id = typeof (call as { id?: unknown }).id === "string" ? (call as { id: string }).id : `call_${Date.now()}_${index}`;
      const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      return { id, type: "function", function: { name: fn.name, arguments: args || "{}" } };
    })
    .filter((call): call is ToolCall => call !== null);
}

async function detail(response: Response) {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } | string; message?: unknown };
    const message =
      typeof body.error === "string" ? body.error : typeof body.error?.message === "string" ? body.error.message : typeof body.message === "string" ? body.message : "";
    return message.replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    return "";
  }
}

type CompleteInput = {
  model: string;
  reasoning: string;
  messages: ChatMessage[];
  webSearch: boolean;
  timeoutMs: number;
  tools?: unknown[];
  fetchImpl?: typeof fetch;
  actor?: UserActor;
  signal?: AbortSignal;
  onText?: (text: string) => void;
};

class EmptyStreamError extends AssistantError {}

type StreamedCall = { id?: string; name?: string; args: string };

async function readStream(response: Response, input: CompleteInput): Promise<Completion> {
  const reader = response.body?.getReader();
  if (!reader) throw new EmptyStreamError("The model sent nothing back.");
  const decoder = new TextDecoder();
  const calls = new Map<number, StreamedCall>();
  const annotations: unknown[] = [];
  let citations: unknown[] = [];
  let buffer = "";
  let content = "";
  let model = input.model;
  let usage: Record<string, unknown> | null = null;
  const take = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (chunk.error) {
      const error = chunk.error as { message?: unknown } | string;
      throw new AssistantError(`The LLM gateway stopped: ${typeof error === "string" ? error : String(error.message ?? "unknown error")}`);
    }
    if (typeof chunk.model === "string" && chunk.model) model = chunk.model;
    if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage as Record<string, unknown>;
    if (Array.isArray(chunk.citations)) citations = chunk.citations;
    const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : null) as { delta?: Record<string, unknown>; message?: Record<string, unknown> } | null;
    const delta = choice?.delta ?? choice?.message ?? {};
    const piece = text(delta.content);
    if (piece) {
      content += piece;
      input.onText?.(content);
    }
    for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const call = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const index = typeof call.index === "number" ? call.index : calls.size;
      const entry = calls.get(index) ?? { args: "" };
      if (typeof call.id === "string" && call.id) entry.id = call.id;
      const name = call.function?.name;
      if (typeof name === "string" && name) entry.name = entry.name && !name.startsWith(entry.name) ? entry.name + name : name;
      const args = call.function?.arguments;
      if (typeof args === "string") entry.args += args;
      else if (args && typeof args === "object") entry.args = JSON.stringify(args);
      calls.set(index, entry);
    }
    if (Array.isArray(delta.annotations)) annotations.push(...delta.annotations);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      take(buffer.slice(0, end).trim());
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
    }
  }
  take(buffer.trim());
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([index, call]): ToolCall[] =>
      call.name ? [{ id: call.id ?? `call_${Date.now()}_${index}`, type: "function", function: { name: call.name, arguments: call.args || "{}" } }] : [],
    );
  if (!content.trim() && toolCalls.length === 0) throw new EmptyStreamError("The model sent nothing back.");
  return { content: content.trim(), toolCalls, sources: readSources({ annotations }, { citations }), model, usage };
}

export class StoppedError extends AssistantError {}

function plain(messages: ChatMessage[]) {
  return messages.map((message) =>
    message.role === "assistant"
      ? { role: message.role, content: message.content, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) }
      : message,
  );
}

export async function complete(input: CompleteInput): Promise<Completion> {
  const chosen = assistantModel(input.model);
  if (chosen?.source === "orbit" && chosen.responses) return completeGatewayResponses({ ...input, model: chosen.apiModel }, chosen.id);
  if (!chosen || chosen.source === "orbit") return completeGateway({ ...input, model: chosen?.apiModel ?? input.model });
  if (chosen.source === "claude") throw new AssistantError("Claude account models run through Orbit Agent on your Mac.");
  if (!input.actor) throw new AssistantError("Sign in again to use your connected accounts.");
  const actor = input.actor;
  const source = chosen.source;
  const run = async (force: boolean) => {
    const access = await aiAccess(actor, source, { force });
    const provider = {
      modelId: chosen.id,
      apiModel: chosen.apiModel,
      reasoning: input.reasoning,
      messages: input.messages,
      webSearch: input.webSearch,
      timeoutMs: input.timeoutMs,
      tools: (input.tools ?? toolDefinitions()) as FunctionTool[],
      fetchImpl: input.fetchImpl,
    };
    return completeChatGpt({ ...provider, token: access.token, accountId: access.accountId });
  };
  try {
    try {
      return await run(false);
    } catch (error) {
      if (!(error instanceof ProviderAuthError)) throw error;
      return await run(true);
    }
  } catch (error) {
    if (error instanceof ProviderAuthError) {
      await noteAiError(actor, source, error.message);
      throw new AssistantError(error.message);
    }
    if (error instanceof ProviderError || error instanceof OAuthError) throw new AssistantError(error.message);
    throw error;
  }
}

class ResponsesUnsupportedError extends AssistantError {}

async function gatewayResponsesAttempt(input: CompleteInput, modelId: string): Promise<Completion> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) throw new AssistantError("Set LLM_API_KEY in Vercel to use the assistant.");
  const request = chatGptRequest({
    modelId,
    apiModel: input.model,
    reasoning: input.reasoning,
    messages: input.messages,
    webSearch: input.webSearch,
    timeoutMs: input.timeoutMs,
    tools: (input.tools ?? toolDefinitions()) as FunctionTool[],
  });
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${baseUrl()}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...request, max_output_tokens: MAX_TOKENS }),
      signal: input.signal ? AbortSignal.any([AbortSignal.timeout(input.timeoutMs), input.signal]) : AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    if (input.signal?.aborted) throw new StoppedError("Stopped.");
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new AssistantError("The model took too long to reply. Try again, or pick a lower reasoning level.");
    }
    throw new AssistantError("Could not reach the LLM gateway.");
  }
  if (!response.ok || !response.body) {
    const reason = await detail(response);
    const message = `The LLM gateway returned ${response.status}${reason ? `: ${reason}` : "."}`;
    if ([400, 404, 405, 422].includes(response.status)) throw new ResponsesUnsupportedError(message);
    throw new AssistantError(message);
  }
  try {
    return await readResponses(response.body, { label: "The model", modelId, onText: input.onText });
  } catch (error) {
    if (input.signal?.aborted) throw new StoppedError("Stopped.");
    if (error instanceof ProviderError) throw new AssistantError(error.message);
    throw error;
  }
}

async function completeGatewayResponses(input: CompleteInput, modelId: string): Promise<Completion> {
  try {
    return await gatewayResponsesAttempt(input, modelId);
  } catch (error) {
    if (!(error instanceof ResponsesUnsupportedError)) throw error;
    console.error("Responses request refused, retrying without reasoning", error.message);
    return completeGateway({ ...input, reasoning: "none", messages: input.messages.map((message) => (message.role === "assistant" ? { ...message, state: null } : message)) });
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_PAUSE_MS = 1_500;
const RETRY_MIN_MS = 20_000;

class RetryableGatewayError extends AssistantError {}

async function completeGateway(input: CompleteInput): Promise<Completion> {
  const started = Date.now();
  try {
    return await gatewayAttempt(input, input.timeoutMs);
  } catch (error) {
    if (error instanceof EmptyStreamError && !input.signal?.aborted) {
      return gatewayAttempt({ ...input, onText: undefined }, Math.max(5_000, input.timeoutMs - (Date.now() - started)));
    }
    const left = input.timeoutMs - (Date.now() - started) - RETRY_PAUSE_MS;
    if (!(error instanceof RetryableGatewayError) || left < RETRY_MIN_MS || input.signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    return gatewayAttempt(input, left);
  }
}

async function gatewayAttempt(input: CompleteInput, timeoutMs: number): Promise<Completion> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) throw new AssistantError("Set LLM_API_KEY in Vercel to use the assistant.");
  const raw = input.tools ?? toolDefinitions();
  const tools = input.model.startsWith("gemini") ? raw.map(geminiTool) : raw;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages: plain(input.messages),
        tools,
        tool_choice: "auto",
        reasoning_effort: input.reasoning,
        max_tokens: MAX_TOKENS,
        ...(input.webSearch ? { web_search_options: { search_context_size: "medium" } } : {}),
        ...(input.onText ? { stream: true, stream_options: { include_usage: true } } : {}),
      }),
      signal: input.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), input.signal]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (input.signal?.aborted) throw new StoppedError("Stopped.");
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new RetryableGatewayError("The model took too long to reply. Try again, or pick a lower reasoning level.");
    }
    throw new RetryableGatewayError("Could not reach the LLM gateway.");
  }
  if (!response.ok) {
    const reason = await detail(response);
    const message = `The LLM gateway returned ${response.status}${reason ? `: ${reason}` : "."}`;
    throw RETRY_STATUSES.has(response.status) ? new RetryableGatewayError(message) : new AssistantError(message);
  }
  if (input.onText && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    try {
      return await readStream(response, input);
    } catch (error) {
      if (input.signal?.aborted) throw new StoppedError("Stopped.");
      if (error instanceof AssistantError) throw error;
      throw new EmptyStreamError("The model's reply was cut off.");
    }
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new AssistantError("The LLM gateway returned an unreadable reply.");
  }
  const choice = (Array.isArray(body.choices) ? body.choices[0] : null) as { message?: Record<string, unknown> } | null;
  const message = choice?.message ?? {};
  return {
    content: text(message.content).trim(),
    toolCalls: readToolCalls(message),
    sources: readSources(message, body),
    model: typeof body.model === "string" && body.model ? body.model : input.model,
    usage: body.usage && typeof body.usage === "object" ? (body.usage as Record<string, unknown>) : null,
  };
}
