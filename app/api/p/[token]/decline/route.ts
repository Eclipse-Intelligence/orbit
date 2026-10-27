import { CrmError } from "@/lib/crm/errors";
import { guardPublic } from "@/lib/proposals/guard";
import { clientDecline } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublic(request, "decline", 20, { clientOnly: true });
  if ("error" in guard) return guard.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return Response.json(await clientDecline(token, body, guard));
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Declining failed", error);
    return Response.json({ error: "That didn't go through. Try again." }, { status: 500 });
  }
}
