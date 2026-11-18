import { mailResponse } from "@/app/api/mail/respond";
import { withActor } from "@/lib/crm/context";
import { checkSuppressed, suppressedLine, type Recipient } from "@/lib/crm/suppressions";

export const dynamic = "force-dynamic";

const MAX_RECIPIENTS = 100;

function recipientsOf(value: unknown): Recipient[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_RECIPIENTS).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { address, name } = item as { address?: unknown; name?: unknown };
    return typeof address === "string" ? [{ address, name: typeof name === "string" ? name : null }] : [];
  });
}

export async function POST(request: Request) {
  return mailResponse(async (actor) => {
    const body = (await request.json().catch(() => ({}))) as { recipients?: unknown };
    const recipients = recipientsOf(body.recipients);
    if (recipients.length === 0) return { line: null };
    const names = await withActor(actor, (db) => checkSuppressed(db, actor.workspaceId, recipients, "warn"));
    return { line: suppressedLine(names) };
  });
}
