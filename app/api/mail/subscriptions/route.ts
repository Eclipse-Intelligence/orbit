import { inBackground, mailResponse } from "@/app/api/mail/respond";
import { EXISTING_CHOICES, listSubscriptions, SENDER_ACTIONS, setSubscription } from "@/lib/mail/subscriptions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const days = Number(new URL(request.url).searchParams.get("days") ?? "");
  return mailResponse((actor) => listSubscriptions(actor, { days: Number.isFinite(days) && days > 0 ? days : undefined }));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { sender?: unknown; action?: unknown; existing?: unknown; confirmed?: unknown };
  const action = SENDER_ACTIONS.find((item) => item === body.action);
  const sender = typeof body.sender === "string" ? body.sender : "";
  if (!sender || !action) return Response.json({ error: "Choose a sender and what to do." }, { status: 400 });
  const existing = EXISTING_CHOICES.find((choice) => choice === body.existing) ?? "archive";
  return mailResponse((actor) =>
    setSubscription(actor, { sender, action, existing, confirmed: body.confirmed === true }, { deadline: Date.now() + 90_000, defer: inBackground }),
  );
}
