import { mailResponse } from "@/app/api/mail/respond";
import { draftShareCandidates, draftSharePeople, shareDraft } from "@/lib/mail/shared-drafts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const share = new URL(request.url).searchParams.get("share");
  return mailResponse(async (actor) => (share ? { people: await draftSharePeople(actor, share) } : { candidates: await draftShareCandidates(actor) }));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { draftId?: unknown; people?: unknown };
  return mailResponse((actor) => shareDraft(actor, body.draftId, body.people));
}
