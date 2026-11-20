import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { relinkCalendar } from "@/lib/crm/calendar";
import { captureActor, readCaptureAction, runCaptureAction } from "@/lib/crm/capture-actions";
import { summariseImport } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { readSyncOrigin } from "@/lib/sync-origin";
import { runPendingMailActions } from "@/lib/mail/pending";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function later(work: () => Promise<unknown>, label: string) {
  try {
    after(async () => {
      try {
        await work();
      } catch (error) {
        console.error(label, error instanceof Error ? error.message : error);
      }
    });
  } catch {
    void work().catch((error) => console.error(label, error instanceof Error ? error.message : error));
  }
}

export async function POST(request: Request) {
  const signedIn = await getUserActor();
  if (!signedIn) return Response.json({ error: "Sign in again." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => null)) as { captureWorkspaceId?: unknown } | null;
    const actor = await captureActor(signedIn, body?.captureWorkspaceId);
    const action = readCaptureAction(body);
    const outcome = await runCaptureAction(actor, action, { origin: readSyncOrigin(request.headers) });
    if (outcome.importId) {
      const importId = outcome.importId;
      later(() => summariseImport(actor, importId), "Conversation summary failed");
    }
    if (outcome.queued) later(() => runPendingMailActions(actor, { deadline: Date.now() + 50_000 }), "Queued mail moves failed");
    if (outcome.relink) later(() => relinkCalendar(actor), "Could not relink calendar events");
    revalidatePath("/", "layout");
    return Response.json(outcome, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Capture change failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "That didn't save. Try again." }, { status: 500 });
  }
}
