import { mailResponse } from "@/app/api/mail/respond";
import { applyMailAction, MAIL_ACTIONS, type MailAction } from "@/lib/mail/actions";
import { readMailView } from "@/lib/mail/view";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { thread?: unknown; action?: unknown; view?: unknown; until?: unknown };
  const action = MAIL_ACTIONS.find((item) => item === body.action) as MailAction | undefined;
  if (typeof body.thread !== "string" || !action) return Response.json({ error: "Choose an email and an action." }, { status: 400 });
  const view = typeof body.view === "string" && body.view !== "search" ? readMailView(body.view) : null;
  const until = typeof body.until === "string" ? body.until : null;
  return mailResponse((actor) => applyMailAction(actor, { thread: body.thread as string, action, view, until }));
}
