import { getUserActor } from "@/lib/auth/user";
import { conversationsWaiting } from "@/lib/campaigns/conversations";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getUserActor();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  try {
    return Response.json({ waiting: await conversationsWaiting(user) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Couldn't count campaign replies", error);
    return Response.json({ error: "Couldn't count replies. Try again." }, { status: 500 });
  }
}
