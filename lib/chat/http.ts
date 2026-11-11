import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";

export type ChatRouteContext = { params: Promise<{ id: string }> };

export async function chatResponse<T>(fallback: string, run: (actor: UserActor) => Promise<T>) {
  try {
    const actor = await getUserActor();
    if (!actor) return Response.json({ error: "Your session ended. Sign in again." }, { status: 401 });
    return Response.json(await run(actor), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Chat request failed", error);
    return Response.json({ error: fallback }, { status: 500 });
  }
}

export function searchParam(request: Request, name: string) {
  const value = new URL(request.url).searchParams.get(name);
  return value && value.trim() ? value.trim() : null;
}

export function limitParam(request: Request) {
  const value = Number.parseInt(searchParam(request, "limit") ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

export async function upToBody(request: Request) {
  const text = (await request.text().catch(() => "")).trim();
  if (!text) return null;
  let input: unknown = null;
  try {
    input = JSON.parse(text);
  } catch {}
  const upTo = input && typeof input === "object" ? (input as { upTo?: unknown }).upTo : undefined;
  if (typeof upTo !== "string" || !isUuid(upTo)) throw new CrmError("invalid_input", "Say which message to mark read up to, or send no body to mark everything read.", 400);
  return upTo;
}
