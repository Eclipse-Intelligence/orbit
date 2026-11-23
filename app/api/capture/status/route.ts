import { getUserActor } from "@/lib/auth/user";
import { captureBadges } from "@/lib/crm/capture";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const user = await getUserActor();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  const badges = await captureBadges(user).catch(() => ({ status: null, waiting: [] }));
  return Response.json(badges, { headers: { "Cache-Control": "no-store" } });
}
