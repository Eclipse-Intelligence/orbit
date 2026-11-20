import { inBackground, mailResponse } from "@/app/api/mail/respond";
import { applyMailAction, MAIL_ACTIONS, type MailAction } from "@/lib/mail/actions";
import { queueMailAction, runPendingMailActions } from "@/lib/mail/pending";
import { isMoveAction } from "@/lib/mail/refusals";
import { readMailView } from "@/lib/mail/view";
import { readSyncOrigin } from "@/lib/sync-origin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { thread?: unknown; action?: unknown; view?: unknown; until?: unknown };
  const action = MAIL_ACTIONS.find((item) => item === body.action) as MailAction | undefined;
  if (typeof body.thread !== "string" || !action) return Response.json({ error: "Choose an email and an action." }, { status: 400 });
  const view = typeof body.view === "string" && body.view !== "search" ? readMailView(body.view) : null;
  const until = typeof body.until === "string" ? body.until : null;
  const origin = readSyncOrigin(request.headers);
  const input = { thread: body.thread, action, view, until };
  if (!isMoveAction(action)) return mailResponse((actor) => applyMailAction(actor, input, fetch, { origin }));
  return mailResponse(async (actor) => {
    await queueMailAction(actor, input, origin);
    inBackground(() =>
      runPendingMailActions(actor, { deadline: Date.now() + 50_000 }).catch((error) =>
        console.error("Queued mail moves failed", error instanceof Error ? error.name : "unknown"),
      ),
    );
    return { queued: true, changed: 0, failed: 0, problem: null };
  });
}
