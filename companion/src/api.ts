import type { CompanionCall, CompanionJob, CompanionResult, CompanionToolResult, PairResponse } from "./protocol";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Me = { companionId: string; name: string; email: string; workspace: string };

export function createApi(baseUrl: string, token: string | null, fetchImpl: typeof fetch = fetch) {
  async function call<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
      });
    } catch {
      throw new ApiError(`Couldn't reach Orbit at ${baseUrl}.`, 0);
    }
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!response.ok) throw new ApiError(payload?.error?.message ?? `Orbit returned ${response.status}.`, response.status);
    return payload as T;
  }

  return {
    pair: (code: string, name: string) => call<PairResponse>("/api/companion/pair", { body: { code, name } }),
    me: () => call<Me>("/api/companion/me"),
    next: () => call<{ job: CompanionJob | null }>("/api/companion/next", { timeoutMs: 70_000 }),
    tool: (jobId: string, toolCall: CompanionCall) =>
      call<CompanionToolResult>(`/api/companion/jobs/${jobId}/tool`, { body: toolCall, timeoutMs: 130_000 }),
    complete: (jobId: string, result: CompanionResult) => call<{ ok: true }>(`/api/companion/jobs/${jobId}/complete`, { body: result }),
    fail: (jobId: string, error: string, timeoutMs?: number) => call<{ ok: true }>(`/api/companion/jobs/${jobId}/fail`, { body: { error }, timeoutMs }),
    heartbeat: (jobId: string) => call<{ ok: true }>(`/api/companion/jobs/${jobId}/heartbeat`, { body: {}, timeoutMs: 20_000 }),
  };
}

export type Api = ReturnType<typeof createApi>;
