import { toolDefinitions } from "@/lib/assistant/tools";

const DEFAULT_BASE_URL = "https://api.llmapi.ai/v1";
const MAX_TOKENS = 16_000;

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type Source = { url: string; title: string | null };

export type Completion = {
  content: string;
  toolCalls: ToolCall[];
  sources: Source[];
  model: string;
  usage: Record<string, unknown> | null;
};

export class AssistantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantError";
  }
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

export async function complete(input: {
  model: string;
  reasoning: string;
  messages: ChatMessage[];
  webSearch: boolean;
  timeoutMs: number;
  tools?: unknown[];
  fetchImpl?: typeof fetch;
}): Promise<Completion> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) throw new AssistantError("Set LLM_API_KEY in Vercel to use the assistant.");
  const tools = [...(input.tools ?? toolDefinitions()), ...(input.webSearch ? [{ type: "web_search" }] : [])];
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        tools,
        tool_choice: "auto",
        reasoning_effort: input.reasoning,
        max_tokens: MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new AssistantError("The model took too long to reply. Try again, or pick a lower reasoning level.");
    }
    throw new AssistantError("Could not reach the LLM gateway.");
  }
  if (!response.ok) {
    const reason = await detail(response);
    throw new AssistantError(`The LLM gateway returned ${response.status}${reason ? `: ${reason}` : "."}`);
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
