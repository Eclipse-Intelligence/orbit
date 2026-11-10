export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

const nativeFetch = globalThis.fetch;

export type JevAnswer = { type: string; noul?: number; choice?: string; score?: number; confidence?: number };

export function jevConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

export function jevModel() {
  return process.env.TYPESAFE_MODEL?.trim() || "jev-latest";
}

export async function askJev(
  state: unknown,
  questions: Record<string, unknown>,
  options: { fetchImpl?: typeof fetch; timeoutMs: number },
): Promise<Record<string, JevAnswer>> {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) throw new Error("Jev isn't set up.");
  const send = options.fetchImpl ?? fetch;
  if (process.env.NODE_TEST_CONTEXT && send === nativeFetch) throw new Error("Jev isn't called for real in tests. Pass fetchImpl.");
  const response = await send(JEV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: jevModel(), state, questions }),
    signal: AbortSignal.timeout(Math.max(1_000, Math.round(options.timeoutMs))),
  });
  if (!response.ok) throw new Error(`Jev answered ${response.status}.`);
  return ((await response.json()) as { answers?: Record<string, JevAnswer> }).answers ?? {};
}
