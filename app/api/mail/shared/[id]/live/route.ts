import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { LIVE_BODY_MAX, LIVE_UPDATE_MAX, LIVE_VECTOR_MAX } from "@/lib/docs/live/persist";
import { decodeBytes, encodeBytes } from "@/lib/docs/live/ydoc";
import { openLiveDraft, syncLiveDraft, type DraftLiveReply } from "@/lib/mail/live-draft";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const HEADERS = { "cache-control": "private, no-store" };

function tooLarge() {
  return new CrmError("live_too_large", "This change is too big to send live. Reload the draft and try again.", 413);
}

function invalid() {
  return new CrmError("live_invalid", "That change wasn't saved. Reload the draft and try again.", 400);
}

function bytes(value: unknown, limit: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 4 * Math.ceil(limit / 3)) throw typeof value === "string" ? tooLarge() : invalid();
  const decoded = decodeBytes(value);
  if (!decoded) throw invalid();
  if (decoded.length > limit) throw tooLarge();
  return decoded;
}

async function readBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > LIVE_BODY_MAX) throw tooLarge();
  const text = await request.text();
  if (text.length > LIVE_BODY_MAX) throw tooLarge();
  try {
    const parsed = JSON.parse(text || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw invalid();
  }
}

function reply(result: DraftLiveReply) {
  return {
    vector: encodeBytes(result.vector),
    missing: encodeBytes(result.missing),
    state: encodeBytes(result.state),
    generation: result.generation,
    rebuilt: result.rebuilt,
    revision: result.version,
    version: result.version,
    locked: result.locked,
    transport: result.transport,
  };
}

async function respond(run: (actor: UserActor) => Promise<unknown>) {
  const actor = await getUserActor();
  if (!actor) return Response.json({ error: "Your session ended. Sign in again." }, { status: 401 });
  try {
    return Response.json(await run(actor), { headers: HEADERS });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ ...error.details, error: error.message, code: error.code }, { status: error.status, headers: HEADERS });
    console.error("live draft request failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "Couldn't save the draft. Try again." }, { status: 500, headers: HEADERS });
  }
}

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  return respond(async (actor) => reply(await openLiveDraft(actor, id)));
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return respond(async (actor) => {
    const input = await readBody(request);
    const generation = typeof input.generation === "number" && Number.isInteger(input.generation) && input.generation >= 0 ? input.generation : undefined;
    return reply(await syncLiveDraft(actor, id, { update: bytes(input.update, LIVE_UPDATE_MAX), vector: bytes(input.vector, LIVE_VECTOR_MAX), generation }));
  });
}
