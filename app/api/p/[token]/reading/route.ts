import { getUserActor } from "@/lib/auth/user";
import { clientIp } from "@/lib/booking/book";
import { CrmError } from "@/lib/crm/errors";
import { query } from "@/lib/db/pool";
import { recordReading } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (await getUserActor().catch(() => null)) return new Response(null, { status: 204 });
  const ip = clientIp(request.headers);
  const allowed = (await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`proposal-reading:${ip}`, 120, 600])).rows[0]?.allowed;
  if (!allowed) return new Response(null, { status: 429 });
  let body: unknown = null;
  try {
    body = JSON.parse((await request.text()).slice(0, 20_000));
  } catch {
    return new Response(null, { status: 400 });
  }
  try {
    await recordReading(token, body, { ip, userAgent: request.headers.get("user-agent") });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof CrmError) return new Response(null, { status: error.status });
    console.error("Recording reading time failed", error);
    return new Response(null, { status: 500 });
  }
}
