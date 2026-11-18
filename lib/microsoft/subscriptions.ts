const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 15_000;
const SHORTEST_CALL_MS = 1_000;

export class GraphSubscriptionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string = "",
  ) {
    super(message);
    this.name = "GraphSubscriptionError";
  }
}

type Limit = { deadline?: number; fetchImpl?: typeof fetch };

function timeout(deadline: number | undefined) {
  if (deadline === undefined) return TIMEOUT_MS;
  const left = deadline - Date.now();
  if (left < SHORTEST_CALL_MS) throw new GraphSubscriptionError("Ran out of time waiting for Microsoft.", 408);
  return Math.min(TIMEOUT_MS, left);
}

async function call<T>(token: string, path: string, method: "POST" | "PATCH" | "DELETE", body: unknown, limit: Limit): Promise<T> {
  const response = await (limit.fetchImpl ?? fetch)(`${GRAPH}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: 'IdType="ImmutableId"' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout(limit.deadline)),
  });
  if (response.ok) {
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
  const failure = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  throw new GraphSubscriptionError(
    (failure.error?.message || `Microsoft answered ${response.status}.`).slice(0, 240),
    response.status,
    failure.error?.code ?? "",
  );
}

export type SubscriptionInput = {
  resource: string;
  changeType: string;
  notificationUrl: string;
  clientState: string;
  minutes: number;
};

export async function createGraphSubscription(token: string, input: SubscriptionInput, limit: Limit = {}) {
  const expirationDateTime = new Date(Date.now() + input.minutes * 60_000).toISOString();
  const created = await call<{ id: string; expirationDateTime?: string }>(
    token,
    "/subscriptions",
    "POST",
    {
      changeType: input.changeType,
      notificationUrl: input.notificationUrl,
      lifecycleNotificationUrl: input.notificationUrl,
      resource: input.resource,
      expirationDateTime,
      clientState: input.clientState,
      latestSupportedTlsVersion: "v1_2",
    },
    limit,
  );
  return { id: created.id, expiresAt: created.expirationDateTime ?? expirationDateTime };
}

export async function renewGraphSubscription(token: string, id: string, minutes: number, limit: Limit = {}) {
  const expirationDateTime = new Date(Date.now() + minutes * 60_000).toISOString();
  try {
    const renewed = await call<{ expirationDateTime?: string }>(token, `/subscriptions/${encodeURIComponent(id)}`, "PATCH", { expirationDateTime }, limit);
    return renewed.expirationDateTime ?? expirationDateTime;
  } catch (error) {
    if (error instanceof GraphSubscriptionError && error.status === 404) return null;
    throw error;
  }
}

export async function deleteGraphSubscription(token: string, id: string, limit: Limit = {}) {
  try {
    await call(token, `/subscriptions/${encodeURIComponent(id)}`, "DELETE", undefined, limit);
  } catch (error) {
    if (error instanceof GraphSubscriptionError && error.status === 404) return;
    throw error;
  }
}
