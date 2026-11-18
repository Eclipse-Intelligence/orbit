const MAX_GRAPH_ITEMS = 1_000;
const MAX_SUBSCRIPTIONS = 50;
const MAX_MESSAGES_PER_SUBSCRIPTION = 100;
const MESSAGE_ID_MAX = 400;

const LIFECYCLE_EVENTS = new Set(["reauthorizationRequired", "subscriptionRemoved", "missed"]);
const CHANGE_TYPES = new Set(["created", "updated", "deleted"]);

export type GraphLifecycleEvent = "reauthorizationRequired" | "subscriptionRemoved" | "missed";

export type GraphChangeType = "created" | "updated" | "deleted";

export type GraphNotice = {
  subscriptionId: string;
  clientState: string;
  lifecycleEvent: GraphLifecycleEvent | null;
  changeType: GraphChangeType | null;
  messageId: string | null;
};

export function graphValidation(request: Request) {
  const token = new URL(request.url).searchParams.get("validationToken");
  if (token === null) return null;
  return new Response(token.slice(0, 1000), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function messageIdFrom(resource: unknown, resourceData: unknown) {
  const direct = resourceData && typeof resourceData === "object" ? (resourceData as { id?: unknown }).id : undefined;
  const raw =
    typeof direct === "string"
      ? direct
      : typeof resource === "string"
        ? (/messages(?:\('([^']+)'\)|\/([^/?()']+))/i.exec(resource)?.slice(1).find(Boolean) ?? null)
        : null;
  if (!raw || raw.length > MESSAGE_ID_MAX) return null;
  return raw;
}

export function readGraphNotices(body: unknown): GraphNotice[] {
  const items = body && typeof body === "object" ? (body as { value?: unknown }).value : undefined;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const bySubscription = new Map<string, GraphNotice[]>();
  for (const item of items.slice(0, MAX_GRAPH_ITEMS)) {
    if (!item || typeof item !== "object") continue;
    const { subscriptionId, clientState, lifecycleEvent, changeType, resource, resourceData } = item as Record<string, unknown>;
    if (typeof subscriptionId !== "string" || subscriptionId.length === 0 || subscriptionId.length > 200) continue;
    if (typeof clientState !== "string" || clientState.length === 0 || clientState.length > 200) continue;
    const lifecycle = typeof lifecycleEvent === "string" && LIFECYCLE_EVENTS.has(lifecycleEvent) ? (lifecycleEvent as GraphLifecycleEvent) : null;
    if (typeof lifecycleEvent === "string" && !lifecycle) continue;
    const change = typeof changeType === "string" && CHANGE_TYPES.has(changeType) ? (changeType as GraphChangeType) : null;
    const messageId = lifecycle ? null : messageIdFrom(resource, resourceData);
    const key = `${subscriptionId}|${clientState}|${lifecycle ?? ""}|${change ?? ""}|${messageId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = bySubscription.get(subscriptionId) ?? [];
    if (!bySubscription.has(subscriptionId)) {
      if (bySubscription.size >= MAX_SUBSCRIPTIONS) continue;
      bySubscription.set(subscriptionId, list);
    }
    list.push({ subscriptionId, clientState, lifecycleEvent: lifecycle, changeType: change, messageId });
  }
  const notices: GraphNotice[] = [];
  for (const list of bySubscription.values()) {
    const messages = list.filter((notice) => notice.messageId !== null);
    if (messages.length <= MAX_MESSAGES_PER_SUBSCRIPTION) {
      notices.push(...list);
      continue;
    }
    const others = list.filter((notice) => notice.messageId === null);
    const states = new Set(messages.map((notice) => notice.clientState));
    notices.push(...others);
    for (const clientState of states) {
      notices.push({ subscriptionId: messages[0].subscriptionId, clientState, lifecycleEvent: null, changeType: null, messageId: null });
    }
  }
  return notices;
}

export async function graphNotices(request: Request) {
  const body = await request.json().catch(() => undefined);
  if (body === undefined) return null;
  return readGraphNotices(body);
}
