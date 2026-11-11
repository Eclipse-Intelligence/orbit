import { mailResponse } from "@/app/api/mail/respond";
import { badgeParts, badgeTotal } from "@/lib/mail/notify";
import { BELL_LIMIT, listNotifications } from "@/lib/workflows/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return mailResponse(async (actor) => {
    const [notifications, parts] = await Promise.all([listNotifications(actor, BELL_LIMIT), badgeParts(actor)]);
    return { notifications, teamUnread: parts.team, badge: badgeTotal(parts) };
  });
}
