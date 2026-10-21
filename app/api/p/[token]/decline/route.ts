import { clientIp } from "@/lib/booking/book";
import { CrmError } from "@/lib/crm/errors";
import { clientDecline } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return Response.json(await clientDecline(token, body, { ip: clientIp(request.headers), userAgent: request.headers.get("user-agent") }));
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Declining failed", error);
    return Response.json({ error: "That didn't go through. Try again." }, { status: 500 });
  }
}
