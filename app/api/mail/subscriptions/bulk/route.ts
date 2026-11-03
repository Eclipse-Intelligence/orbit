import { inBackground, mailResponse } from "@/app/api/mail/respond";
import { EXISTING_CHOICES, unsubscribeMany } from "@/lib/mail/subscriptions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { senders?: unknown; existing?: unknown };
  const senders = Array.isArray(body.senders) ? body.senders.filter((item): item is string => typeof item === "string").slice(0, 100) : [];
  if (senders.length === 0) return Response.json({ error: "Choose at least one sender." }, { status: 400 });
  const existing = EXISTING_CHOICES.find((choice) => choice === body.existing) ?? "archive";
  return mailResponse(async (actor) => ({
    results: await unsubscribeMany(actor, senders, { existing }, { deadline: Date.now() + 240_000, defer: inBackground }),
  }));
}
