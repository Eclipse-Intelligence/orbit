import { clientIp } from "@/lib/booking/book";
import { CrmError } from "@/lib/crm/errors";
import { query } from "@/lib/db/pool";
import { clientSign } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = clientIp(request.headers);
  const allowed = (await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`proposal-sign:${ip}`, 20, 600])).rows[0]?.allowed;
  if (!allowed) return Response.json({ error: "Too many attempts. Wait a few minutes and try again." }, { status: 429 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return Response.json(await clientSign(token, body, { ip, userAgent: request.headers.get("user-agent") }));
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Signing failed", error);
    return Response.json({ error: "Signing didn't go through. Try again." }, { status: 500 });
  }
}
