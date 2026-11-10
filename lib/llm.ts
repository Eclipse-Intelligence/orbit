import { ShownError, notSetUp } from "@/lib/crm/errors";
import { logUpstream, upstreamMessage } from "@/lib/upstream";
import type { z } from "zod";

const DEFAULT_BASE_URL = "https://api.llmapi.ai/v1";
const nativeFetch = globalThis.fetch;
const DEFAULT_MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 2;
const MIN_REPLY_TOKENS = 4000;
const DEADLINE_MARGIN_MS = 2_000;
const MIN_ATTEMPT_MS = 5_000;
const UNUSABLE = "The AI gave an unusable answer. Try again.";
const UNREACHABLE = "Couldn't reach the AI. Try again.";
const AI_ERROR = "The AI returned an error. Try again.";
const TRANSCRIBE_FAILED = "Couldn't transcribe. Try again.";

type Viewer = { type?: string; role?: string } | null | undefined;

function missingKey(viewer?: Viewer) {
  return new LlmError(notSetUp("AI", "LLM_API_KEY", viewer), false, true);
}

function gatewayFailure(status: number, fallback: string, viewer: Viewer, retryable: boolean) {
  if (status === 401 || status === 403 || status === 429) {
    const owner = viewer?.type !== "agent" && viewer?.role === "owner";
    return new LlmError(upstreamMessage("The AI", status, { fix: owner ? "Check LLM_API_KEY." : undefined }), retryable, true);
  }
  return new LlmError(fallback, retryable);
}

export class LlmError extends ShownError {
  readonly retryable: boolean;
  readonly actionable: boolean;

  constructor(message: string, retryable = false, actionable = false) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
    this.actionable = actionable;
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
  attempts?: number;
  model?: string;
  webSearch?: boolean;
  viewer?: Viewer;
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
    logUpstream("LLM gateway", null, "reply had no JSON");
    throw new LlmError(UNUSABLE, true);
  }
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    logUpstream("LLM gateway", null, "reply JSON could not be parsed");
    throw new LlmError(UNUSABLE, true);
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
        max_tokens: Math.max(request.maxTokens ?? MIN_REPLY_TOKENS, MIN_REPLY_TOKENS),
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
      throw new LlmError("The AI took too long. Try again.", true);
    }
    logUpstream("LLM gateway", null, error);
    throw new LlmError(UNREACHABLE, true);
  }
  if (!response.ok) {
    logUpstream("LLM gateway", response.status, await gatewayDetail(response));
    throw gatewayFailure(response.status, AI_ERROR, request.viewer, response.status >= 500);
  }
  let body: {
    model?: unknown;
    choices?: { message?: { content?: unknown; annotations?: unknown }; finish_reason?: unknown }[];
  };
  try {
    body = await response.json();
  } catch {
    logUpstream("LLM gateway", response.status, "unreadable response");
    throw new LlmError(UNUSABLE, true);
  }
  const choice = body.choices?.[0];
  const text = messageText(choice?.message?.content);
  if (choice?.finish_reason === "length") {
    throw new LlmError("The AI's answer was cut off.", false);
  }
  if (!text.trim()) throw new LlmError(UNUSABLE, true);
  const parsed = request.schema.safeParse(extractJson(text));
  if (!parsed.success) {
    logUpstream("LLM gateway", null, parsed.error.message);
    throw new LlmError(UNUSABLE, true);
  }
  return {
    data: parsed.data,
    model: typeof body.model === "string" && body.model ? body.model : model,
    citations: citationsOf(choice?.message),
  };
}

export async function completeJson<T>(request: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) throw missingKey(request.viewer);
  if (process.env.NODE_TEST_CONTEXT && (request.fetchImpl ?? fetch) === nativeFetch) {
    throw new LlmError("The AI isn't called for real in tests. Pass fetchImpl.");
  }
  const model = request.model?.trim() || llmModel();
  let last: unknown;
  for (let index = 0; index < Math.max(1, Math.min(request.attempts ?? MAX_ATTEMPTS, MAX_ATTEMPTS)); index += 1) {
    const limit = request.timeoutMs ?? TIMEOUT_MS;
    const remaining = request.deadline
      ? request.deadline - Date.now() - DEADLINE_MARGIN_MS
      : limit;
    if (remaining < (request.deadline ? MIN_ATTEMPT_MS : 1_000)) {
      if (last) throw last;
      throw new LlmError("Ran out of time. Try again.", true);
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

const EMBEDDING_PARALLEL = 4;

async function embedBatch(batch: string[], apiKey: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number; viewer?: Viewer }) {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${baseUrl()}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    logUpstream("LLM gateway embeddings", null, error);
    throw new LlmError(UNREACHABLE, true);
  }
  if (!response.ok) {
    logUpstream("LLM gateway embeddings", response.status, await gatewayDetail(response));
    throw gatewayFailure(response.status, AI_ERROR, options.viewer, response.status >= 500 || response.status === 429);
  }
  const body = (await response.json().catch(() => null)) as { data?: { index?: number; embedding?: unknown }[] } | null;
  const data = [...(body?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== batch.length) throw new LlmError(UNUSABLE);
  return data.map((entry) => {
    const embedding = entry.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS || !embedding.every((value) => typeof value === "number")) {
      throw new LlmError(UNUSABLE);
    }
    return embedding as number[];
  });
}

export async function embedTexts(texts: string[], options: { fetchImpl?: typeof fetch; timeoutMs?: number; viewer?: Viewer } = {}): Promise<number[][]> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) throw missingKey(options.viewer);
  const batches: string[][] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) batches.push(texts.slice(start, start + EMBEDDING_BATCH));
  const results: number[][][] = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const index = next;
      next += 1;
      results[index] = await embedBatch(batches[index], apiKey, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(EMBEDDING_PARALLEL, batches.length) }, worker));
  return results.flat();
}

export const TRANSCRIBE_MODEL = "universal-2";
export const TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;

export async function transcribeAudio(
  bytes: Uint8Array,
  name: string,
  contentType: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; language?: string; signal?: AbortSignal; viewer?: Viewer } = {},
): Promise<string> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) throw missingKey(options.viewer);
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
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 180_000)]) : AbortSignal.timeout(options.timeoutMs ?? 180_000),
    });
  } catch (error) {
    logUpstream("LLM gateway transcription", null, error);
    throw new LlmError(UNREACHABLE, true);
  }
  if (!response.ok) {
    logUpstream("LLM gateway transcription", response.status, await gatewayDetail(response));
    throw gatewayFailure(response.status, TRANSCRIBE_FAILED, options.viewer, response.status >= 500 || response.status === 429);
  }
  const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
  if (typeof body?.text !== "string") throw new LlmError(TRANSCRIBE_FAILED);
  return body.text.trim();
}
