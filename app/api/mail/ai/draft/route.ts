import { aiAllowed, aiConfigured, mailResponse } from "@/app/api/mail/respond";
import { CrmError } from "@/lib/crm/errors";
import { draftWithAi } from "@/lib/mail/ai";
import { DRAFT_MODES } from "@/lib/mail/compose";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return mailResponse(async (actor) => {
    if (!aiConfigured()) throw new CrmError("unavailable", "Set LLM_API_KEY in Vercel to write with AI.", 503);
    if (!(await aiAllowed(actor.userId, "draft", 60))) throw new CrmError("rate_limited", "That's a lot of drafts in a short time. Try again in a few minutes.", 429);
    const mode = DRAFT_MODES.find((item) => item === body.mode) ?? "new";
    const to = Array.isArray(body.to)
      ? body.to
          .map((item) => item as { address?: unknown; name?: unknown })
          .filter((item) => typeof item.address === "string")
          .map((item) => ({ address: String(item.address).slice(0, 320), name: typeof item.name === "string" ? item.name.slice(0, 200) : null }))
          .slice(0, 20)
      : [];
    return draftWithAi(actor, {
      mode,
      messageId: typeof body.messageId === "string" ? body.messageId : null,
      to,
      subject: typeof body.subject === "string" ? body.subject.slice(0, 300) : "",
      instruction: typeof body.instruction === "string" ? body.instruction : "",
      current: typeof body.current === "string" ? body.current : "",
    });
  });
}
