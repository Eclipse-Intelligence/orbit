import { HOOK_BODY_MAX_BYTES, parseHookBody, postViaHook } from "@/lib/crm/chat-hooks";
import { CrmError } from "@/lib/crm/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };

function tooLarge() {
  return new CrmError("too_large", "Keep the body to 32 KB.", 413);
}

async function cappedText(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > HOOK_BODY_MAX_BYTES) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > HOOK_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    if (url.searchParams.has("key") || url.searchParams.has("secret") || url.searchParams.has("token")) {
      throw new CrmError("invalid_input", "Send the secret as Authorization: Bearer <secret>, not in the URL.", 400);
    }
    const payload = parseHookBody(await cappedText(request));
    const result = await postViaHook({
      hookId: id,
      authorization: request.headers.get("authorization"),
      idempotencyKey: request.headers.get("idempotency-key"),
      payload,
    });
    return Response.json({ ok: true, ...result }, { status: result.duplicate ? 200 : 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    console.error("Chat webhook failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "Couldn't post the message. Try again." }, { status: 500, headers: NO_STORE });
  }
}
