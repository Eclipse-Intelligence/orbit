import { mailResponse } from "@/app/api/mail/respond";
import { setHoldCalendar } from "@/lib/crm/invite-senders";
import { listIdentities, removeIdentity, saveIdentity } from "@/lib/mail/identities";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  return mailResponse(async (actor) => ({ identities: await listIdentities(actor) }));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return mailResponse((actor) => saveIdentity(actor, body));
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return mailResponse(async (actor) => {
    await removeIdentity(actor, id);
    return { removed: true };
  });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return mailResponse(async (actor) => {
    const calendarId = typeof body.holdCalendarId === "string" && body.holdCalendarId ? body.holdCalendarId : null;
    await setHoldCalendar(actor, typeof body.id === "string" ? body.id : "", calendarId);
    return { saved: true };
  });
}
