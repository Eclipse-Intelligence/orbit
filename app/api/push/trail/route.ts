import { withinLimit } from "@/app/api/mail/respond";
import { getUserActor } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

const STEP = /^[a-z-]{1,40}$/;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { step?: unknown; data?: unknown };
  const step = typeof body.step === "string" && STEP.test(body.step) ? body.step : null;
  if (!step) return new Response(null, { status: 204 });
  const actor = await getUserActor().catch(() => null);
  if (actor && !(await withinLimit(actor.userId, "push-trail", 200, 600).catch(() => true))) return new Response(null, { status: 204 });
  const data = JSON.stringify(body.data ?? {}).slice(0, 800);
  console.info(`push-trail ${step} user=${actor ? actor.userId.slice(0, 8) : "signed-out"} ${data}`);
  return new Response(null, { status: 204 });
}
