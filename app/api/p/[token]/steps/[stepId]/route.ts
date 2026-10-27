import { clientIp } from "@/lib/booking/book";
import { CrmError } from "@/lib/crm/errors";
import { query } from "@/lib/db/pool";
import { clientStep } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string; stepId: string }> }) {
  const { token, stepId } = await params;
  const ip = clientIp(request.headers);
  const allowed = (await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`proposal-step:${ip}`, 60, 600])).rows[0]?.allowed;
  if (!allowed) return Response.json({ error: "Too many changes. Wait a few minutes and try again." }, { status: 429 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return Response.json(await clientStep(token, stepId, body, { ip, userAgent: request.headers.get("user-agent") }));
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Updating a step failed", error);
    return Response.json({ error: "That didn't save. Try again." }, { status: 500 });
  }
}
