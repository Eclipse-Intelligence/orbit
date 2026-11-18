const MAX_GRAPH_ITEMS = 1_000;
const MAX_GRAPH_NOTICES = 50;

const LIFECYCLE_EVENTS = new Set(["reauthorizationRequired", "subscriptionRemoved", "missed"]);

export type GraphLifecycleEvent = "reauthorizationRequired" | "subscriptionRemoved" | "missed";

export type GraphNotice = { subscriptionId: string; clientState: string; lifecycleEvent: GraphLifecycleEvent | null };

export function graphValidation(request: Request) {
  const token = new URL(request.url).searchParams.get("validationToken");
  if (token === null) return null;
  return new Response(token.slice(0, 1000), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function readGraphNotices(body: unknown): GraphNotice[] {
  const items = body && typeof body === "object" ? (body as { value?: unknown }).value : undefined;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const notices: GraphNotice[] = [];
  for (const item of items.slice(0, MAX_GRAPH_ITEMS)) {
    if (notices.length >= MAX_GRAPH_NOTICES) break;
    if (!item || typeof item !== "object") continue;
    const { subscriptionId, clientState, lifecycleEvent } = item as { subscriptionId?: unknown; clientState?: unknown; lifecycleEvent?: unknown };
    if (typeof subscriptionId !== "string" || subscriptionId.length === 0 || subscriptionId.length > 200) continue;
    if (typeof clientState !== "string" || clientState.length === 0 || clientState.length > 200) continue;
    const lifecycle = typeof lifecycleEvent === "string" && LIFECYCLE_EVENTS.has(lifecycleEvent) ? (lifecycleEvent as GraphLifecycleEvent) : null;
    if (typeof lifecycleEvent === "string" && !lifecycle) continue;
    const key = `${subscriptionId}|${lifecycle ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notices.push({ subscriptionId, clientState, lifecycleEvent: lifecycle });
  }
  return notices;
}

export async function graphNotices(request: Request) {
  const body = await request.json().catch(() => undefined);
  if (body === undefined) return null;
  return readGraphNotices(body);
}
