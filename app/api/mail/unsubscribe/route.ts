import { inBackground, mailResponse, withinLimit } from "@/app/api/mail/respond";
import { CrmError } from "@/lib/crm/errors";
import { EXISTING_CHOICES, senderSummary, unsubscribe, unsubscribePreview } from "@/lib/mail/subscriptions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PER_MINUTE = 30;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const thread = params.get("thread") ?? undefined;
  const sender = params.get("sender") ?? undefined;
  if (!thread && !sender) return Response.json({ error: "Choose a conversation or a sender." }, { status: 400 });
  const headers = params.get("mode") !== "block" && params.get("mode") !== "research";
  return mailResponse((actor) => (headers ? unsubscribePreview(actor, { thread, sender }) : senderSummary(actor, { thread, sender })));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { thread?: unknown; sender?: unknown; existing?: unknown; block?: unknown; confirmed?: unknown };
  const thread = typeof body.thread === "string" ? body.thread : undefined;
  const sender = typeof body.sender === "string" ? body.sender : undefined;
  if (!thread && !sender) return Response.json({ error: "Choose a conversation or a sender." }, { status: 400 });
  const existing = EXISTING_CHOICES.find((choice) => choice === body.existing) ?? "archive";
  return mailResponse(async (actor) => {
    if (!(await withinLimit(actor.userId, "unsubscribe", PER_MINUTE, 60))) {
      throw new CrmError("rate_limited", "That's a lot of unsubscribes in a minute. Wait a moment and try again.", 429);
    }
    return unsubscribe(
      actor,
      { thread, sender, existing, block: body.block === true, confirmed: body.confirmed === true },
      { deadline: Date.now() + 90_000, defer: inBackground },
    );
  });
}
