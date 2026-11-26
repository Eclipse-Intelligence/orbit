import { withinLimit } from "@/app/api/mail/respond";
import { getUserActor } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

const STEP = /^[a-z-]{1,40}$/;

function callerAddress(request: Request) {
  return (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim().slice(0, 64) || "unknown";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { step?: unknown; data?: unknown };
  const step = typeof body.step === "string" && STEP.test(body.step) ? body.step : null;
  if (!step) return new Response(null, { status: 204 });
  const actor = await getUserActor().catch(() => null);
  if (!actor) {
    if (await withinLimit(`signed-out:${callerAddress(request)}`, "push-trail", 30, 600).catch(() => false)) console.info(`push-trail ${step} user=signed-out`);
    return new Response(null, { status: 204 });
  }
  if (!(await withinLimit(actor.userId, "push-trail", 200, 600).catch(() => true))) return new Response(null, { status: 204 });
  console.info(`push-trail ${step} user=${actor.userId.slice(0, 8)} ${JSON.stringify(body.data ?? {}).slice(0, 800)}`);
  return new Response(null, { status: 204 });
}
