import { ORIGINATOR } from "@/lib/ai-accounts/oauth";
import { ProviderAuthError, ProviderError, type ProviderInput } from "@/lib/assistant/providers/shared";
import type { Completion, Source, ToolCall } from "@/lib/assistant/gateway";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

type Item = Record<string, unknown> & { type?: string };

function callId(id: string) {
  return id.slice(0, 64) || "call";
}

export function chatGptRequest(input: ProviderInput) {
  const instructions = input.messages.find((message) => message.role === "system")?.content ?? "";
  const items: Item[] = [];
  for (const message of input.messages) {
    if (message.role === "tool") {
      items.push({ type: "function_call_output", call_id: callId(message.tool_call_id), output: message.content || "{}" });
      continue;
    }
    if (message.role !== "assistant") {
      if (message.role === "user") items.push({ role: "user", content: [{ type: "input_text", text: message.content }] });
      continue;
    }
    const calls = new Set((message.tool_calls ?? []).map((call) => callId(call.id)));
    const state = message.state;
    if (state && state.model === input.modelId && Array.isArray(state.content)) {
      items.push(
        ...(state.content as Item[]).filter((item) => item.type !== "function_call" || calls.has(callId(String(item.call_id)))),
      );
      continue;
    }
    if (message.content) {
      items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: message.content, annotations: [] }] });
    }
    for (const call of message.tool_calls ?? []) {
      items.push({ type: "function_call", call_id: callId(call.id), name: call.function.name, arguments: call.function.arguments || "{}" });
    }
  }
  const tools: Item[] = input.tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
    strict: false,
  }));
  if (input.webSearch) tools.push({ type: "web_search" });
  return {
    model: input.apiModel,
    instructions: instructions || "You are a helpful assistant.",
    input: items,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: input.reasoning === "max" ? "xhigh" : input.reasoning, summary: "auto" },
    include: ["reasoning.encrypted_content"],
    store: false,
    stream: true,
  };
}

async function failure(response: Response) {
  let detail = "";
  try {
    const body = (await response.json()) as { detail?: unknown; error?: { message?: unknown } | string };
    detail =
      typeof body.detail === "string"
        ? body.detail
        : typeof body.error === "string"
          ? body.error
          : typeof body.error?.message === "string"
            ? body.error.message
            : "";
  } catch {}
  const message = `ChatGPT returned ${response.status}${detail ? `: ${detail.replace(/\s+/g, " ").trim().slice(0, 300)}` : "."}`;
  return response.status === 401 ? new ProviderAuthError(message) : new ProviderError(message);
}

async function* events(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") {
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {}
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
}

function readItems(items: Item[]) {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  const sources = new Map<string, Source>();
  for (const item of items) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content as Item[]) {
        if (part.type !== "output_text" || typeof part.text !== "string") continue;
        text.push(part.text);
        for (const note of (Array.isArray(part.annotations) ? part.annotations : []) as Item[]) {
          if (note.type === "url_citation" && typeof note.url === "string" && /^https?:\/\//.test(note.url) && !sources.has(note.url)) {
            sources.set(note.url, { url: note.url, title: typeof note.title === "string" ? note.title : null });
          }
        }
      }
    } else if (item.type === "function_call" && typeof item.name === "string") {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? `call_${toolCalls.length}`),
        type: "function",
        function: { name: item.name, arguments: typeof item.arguments === "string" && item.arguments ? item.arguments : "{}" },
      });
    }
  }
  return { text: text.join("\n\n").trim(), toolCalls, sources: [...sources.values()].slice(0, 30) };
}

export async function completeChatGpt(input: ProviderInput & { token: string; accountId: string | null }): Promise<Completion> {
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(CODEX_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        ...(input.accountId ? { "chatgpt-account-id": input.accountId } : {}),
        originator: ORIGINATOR,
        "OpenAI-Beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(chatGptRequest(input)),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ProviderError("ChatGPT took too long to reply. Try again, or pick a lower reasoning level.");
    }
    throw new ProviderError("Couldn't reach ChatGPT.");
  }
  if (!response.ok || !response.body) throw await failure(response);
  return readResponses(response.body, { label: "ChatGPT", modelId: input.modelId, onText: input.onText });
}

export async function readResponses(body: ReadableStream<Uint8Array>, options: { label: string; modelId: string; onText?: (text: string) => void }): Promise<Completion> {
  const items: Item[] = [];
  let finished: Item | null = null;
  let streamed = "";
  try {
    for await (const event of events(body)) {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string" && options.onText) {
        streamed += event.delta;
        options.onText(streamed);
      } else if (event.type === "response.output_item.done" && event.item && typeof event.item === "object") items.push(event.item as Item);
      else if (event.type === "response.completed" || event.type === "response.incomplete") finished = (event.response as Item) ?? {};
      else if (event.type === "response.failed" || event.type === "error") {
        const problem = ((event.response as Item | undefined)?.error ?? event.error ?? event) as { message?: unknown };
        throw new ProviderError(`${options.label} stopped: ${typeof problem.message === "string" ? problem.message : "unknown error"}`);
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ProviderError(`${options.label} took too long to reply. Try again, or pick a lower reasoning level.`);
    }
    throw new ProviderError(`The ${options.label} connection dropped. Try again.`);
  }
  if (items.length === 0 && Array.isArray(finished?.output)) items.push(...(finished.output as Item[]));
  const reply = readItems(items);
  return {
    content: reply.text,
    toolCalls: reply.toolCalls,
    sources: reply.sources,
    model: options.modelId,
    usage: finished?.usage && typeof finished.usage === "object" ? (finished.usage as Record<string, unknown>) : null,
    state: { model: options.modelId, content: items },
  };
}
