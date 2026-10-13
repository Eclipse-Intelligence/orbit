import type { z } from "zod";

const DEFAULT_BASE_URL = "https://api.llmapi.ai/v1";
const DEFAULT_MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 2;

export class LlmError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
  }
}

export type LlmJsonRequest<T> = {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type LlmJsonResult<T> = {
  data: T;
  model: string;
};

export function llmModel() {
  return process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;
}

function baseUrl() {
  return (process.env.LLM_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const unfenced = (fenced ? fenced[1] : text).trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new LlmError("The model did not return JSON.", true);
  }
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw new LlmError("The model returned JSON that could not be read.", true);
  }
}

function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

async function gatewayDetail(response: Response) {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } | string; message?: unknown };
    const detail =
      typeof body.error === "string"
        ? body.error
        : typeof body.error?.message === "string"
          ? body.error.message
          : typeof body.message === "string"
            ? body.message
            : "";
    return detail.replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}

async function attempt<T>(request: LlmJsonRequest<T>, apiKey: string, model: string) {
  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens ?? 4000,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new LlmError("The LLM gateway timed out.", true);
    }
    throw new LlmError("Could not reach the LLM gateway.", true);
  }
  if (!response.ok) {
    const detail = await gatewayDetail(response);
    const hint =
      response.status === 401 || response.status === 403 ? " Check LLM_API_KEY." : "";
    throw new LlmError(
      `The LLM gateway returned ${response.status}${detail ? `: ${detail}` : "."}${hint}`,
      response.status >= 500,
    );
  }
  let body: {
    model?: unknown;
    choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  };
  try {
    body = await response.json();
  } catch {
    throw new LlmError("The LLM gateway returned an unreadable response.", true);
  }
  const choice = body.choices?.[0];
  const text = messageText(choice?.message?.content);
  if (!text.trim()) throw new LlmError("The model returned an empty reply.", true);
  if (choice?.finish_reason === "length") {
    throw new LlmError("The model reply was cut off before it finished.", true);
  }
  const parsed = request.schema.safeParse(extractJson(text));
  if (!parsed.success) {
    throw new LlmError("The model returned JSON in an unexpected shape.", true);
  }
  return {
    data: parsed.data,
    model: typeof body.model === "string" && body.model ? body.model : model,
  };
}

export async function completeJson<T>(request: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) throw new LlmError("Set LLM_API_KEY to summarise calls.");
  const model = llmModel();
  let last: unknown;
  for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
    try {
      return await attempt(request, apiKey, model);
    } catch (error) {
      last = error;
      if (!(error instanceof LlmError) || !error.retryable) throw error;
    }
  }
  throw last;
}
