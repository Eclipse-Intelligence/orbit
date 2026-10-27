import type { z } from "zod";

const DEFAULT_BASE_URL = "https://api.llmapi.ai/v1";
const DEFAULT_MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 2;
const DEADLINE_MARGIN_MS = 2_000;
const MIN_ATTEMPT_MS = 5_000;

export class LlmError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
  }
}

type LlmJsonRequest<T> = {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  deadline?: number;
  model?: string;
  webSearch?: boolean;
};

type LlmJsonResult<T> = {
  data: T;
  model: string;
  citations: string[];
};

function citationsOf(message: unknown) {
  const annotations = (message as { annotations?: unknown } | undefined)?.annotations;
  if (!Array.isArray(annotations)) return [];
  const urls = annotations.flatMap((item) => {
    const citation = (item as { url_citation?: { url?: unknown }; url?: unknown } | null) ?? {};
    const url = citation.url_citation?.url ?? citation.url;
    return typeof url === "string" && /^https?:\/\//.test(url) ? [url] : [];
  });
  return [...new Set(urls)].slice(0, 20);
}

function llmModel() {
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

async function attempt<T>(
  request: LlmJsonRequest<T>,
  apiKey: string,
  model: string,
  timeoutMs: number,
) {
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
        ...(request.webSearch ? { web_search_options: { search_context_size: "medium" } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
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
    choices?: { message?: { content?: unknown; annotations?: unknown }; finish_reason?: unknown }[];
  };
  try {
    body = await response.json();
  } catch {
    throw new LlmError("The LLM gateway returned an unreadable response.", true);
  }
  const choice = body.choices?.[0];
  const text = messageText(choice?.message?.content);
  if (choice?.finish_reason === "length") {
    throw new LlmError("The model reply was cut off before it finished.", true);
  }
  if (!text.trim()) throw new LlmError("The model returned an empty reply.", true);
  const parsed = request.schema.safeParse(extractJson(text));
  if (!parsed.success) {
    throw new LlmError("The model returned JSON in an unexpected shape.", true);
  }
  return {
    data: parsed.data,
    model: typeof body.model === "string" && body.model ? body.model : model,
    citations: citationsOf(choice?.message),
  };
}

export async function completeJson<T>(request: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) throw new LlmError("Set LLM_API_KEY in Vercel to use Orbit's AI.");
  const model = request.model?.trim() || llmModel();
  let last: unknown;
  for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
    const limit = request.timeoutMs ?? TIMEOUT_MS;
    const remaining = request.deadline
      ? request.deadline - Date.now() - DEADLINE_MARGIN_MS
      : limit;
    if (remaining < MIN_ATTEMPT_MS) {
      if (last) throw last;
      throw new LlmError("There was not enough time left to summarise. Try again.", true);
    }
    try {
      return await attempt(request, apiKey, model, Math.min(limit, remaining));
    } catch (error) {
      last = error;
      if (!(error instanceof LlmError) || !error.retryable) throw error;
    }
  }
  throw last;
}

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_BATCH = 64;

export async function embedTexts(texts: string[], options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<number[][]> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) throw new LlmError("Set LLM_API_KEY in Vercel to use Orbit's AI.");
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH);
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(`${baseUrl()}/embeddings`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch {
      throw new LlmError("Couldn't reach the LLM gateway for embeddings.", true);
    }
    if (!response.ok) throw new LlmError(`The LLM gateway returned ${response.status} for embeddings.`, response.status >= 500 || response.status === 429);
    const body = (await response.json().catch(() => null)) as { data?: { index?: number; embedding?: unknown }[] } | null;
    const data = [...(body?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== batch.length) throw new LlmError("The LLM gateway returned the wrong number of embeddings.");
    for (const entry of data) {
      const embedding = entry.embedding;
      if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS || !embedding.every((value) => typeof value === "number")) {
        throw new LlmError("The LLM gateway returned an embedding Orbit can't use.");
      }
      vectors.push(embedding as number[]);
    }
  }
  return vectors;
}

export const TRANSCRIBE_MODEL = "universal-2";
export const TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;

export async function transcribeAudio(
  bytes: Uint8Array,
  name: string,
  contentType: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; language?: string } = {},
): Promise<string> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) throw new LlmError("Set LLM_API_KEY in Vercel to use Orbit's AI.");
  const form = new FormData();
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  if (options.language) form.append("language", options.language);
  form.append("file", new Blob([bytes.slice()], { type: contentType || "audio/mpeg" }), name);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${baseUrl()}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
    });
  } catch {
    throw new LlmError("Couldn't reach the LLM gateway to transcribe.", true);
  }
  if (!response.ok) {
    const detail = await gatewayDetail(response);
    throw new LlmError(`The LLM gateway returned ${response.status} transcribing${detail ? `: ${detail}` : "."}`, response.status >= 500 || response.status === 429);
  }
  const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
  if (typeof body?.text !== "string") throw new LlmError("The LLM gateway returned a transcript Orbit can't read.");
  return body.text.trim();
}
