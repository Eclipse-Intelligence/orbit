import { inBackground, mailResponse } from "@/app/api/mail/respond";
import { EXISTING_CHOICES, unsubscribe, unsubscribePreview } from "@/lib/mail/subscriptions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const thread = params.get("thread") ?? undefined;
  const sender = params.get("sender") ?? undefined;
  if (!thread && !sender) return Response.json({ error: "Choose a conversation or a sender." }, { status: 400 });
  return mailResponse((actor) => unsubscribePreview(actor, { thread, sender }));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { thread?: unknown; sender?: unknown; existing?: unknown; block?: unknown; confirmed?: unknown };
  const thread = typeof body.thread === "string" ? body.thread : undefined;
  const sender = typeof body.sender === "string" ? body.sender : undefined;
  if (!thread && !sender) return Response.json({ error: "Choose a conversation or a sender." }, { status: 400 });
  const existing = EXISTING_CHOICES.find((choice) => choice === body.existing) ?? "archive";
  return mailResponse((actor) =>
    unsubscribe(
      actor,
      { thread, sender, existing, block: body.block === true, confirmed: body.confirmed === true },
      { deadline: Date.now() + 90_000, defer: inBackground },
    ),
  );
}
