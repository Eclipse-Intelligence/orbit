import { mailResponse } from "@/app/api/mail/respond";
import { notificationSettings, setMailNotifications, type NotifyMail } from "@/lib/mail/notify";

export const dynamic = "force-dynamic";

const LEVELS: NotifyMail[] = ["important", "all", "none"];

export async function GET() {
  return mailResponse((actor) => notificationSettings(actor));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { mail?: unknown; calendarMinutes?: unknown; reads?: unknown };
  return mailResponse(async (actor) => {
    const minutes = body.calendarMinutes === null ? null : typeof body.calendarMinutes === "number" ? Math.max(0, Math.min(1440, Math.trunc(body.calendarMinutes))) : undefined;
    await setMailNotifications(actor, {
      mail: LEVELS.find((level) => level === body.mail),
      calendarMinutes: minutes,
      reads: typeof body.reads === "boolean" ? body.reads : undefined,
    });
    return notificationSettings(actor);
  });
}
