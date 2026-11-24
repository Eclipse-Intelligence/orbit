import { after } from "next/server";
import { getHomeActor, getUserActor } from "@/lib/auth/user";
import { captureBadges } from "@/lib/crm/capture";
import { classifyCapture } from "@/lib/mail/capture-filter";
import { microsoftConfigured } from "@/lib/microsoft/oauth";
import { visitDue } from "@/lib/visit-throttle";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SORT_GAP_MS = 2 * 60 * 1000;

export async function GET() {
  const [user, home] = await Promise.all([getUserActor(), getHomeActor()]);
  if (!user || !home) return Response.json({ error: "Sign in again." }, { status: 401 });
  if (microsoftConfigured() && visitDue(`capture-sort:${home.userId}`, SORT_GAP_MS)) {
    try {
      after(async () => {
        try {
          await classifyCapture(home, { budgetMs: 20_000, gapSeconds: 60 });
        } catch (error) {
          console.error("Sorting Capture email failed", error instanceof Error ? error.message : error);
        }
      });
    } catch (error) {
      console.error("Sorting Capture email failed", error instanceof Error ? error.message : error);
    }
  }
  try {
    return Response.json(await captureBadges(user), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Couldn't load Capture." }, { status: 500 });
  }
}
