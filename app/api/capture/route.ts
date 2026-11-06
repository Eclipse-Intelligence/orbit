import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { clickupToken } from "@/lib/clickup";
import { relinkCalendar } from "@/lib/crm/calendar";
import { readCaptureAction, runCaptureAction } from "@/lib/crm/capture-actions";
import { pushClickUpTask } from "@/lib/crm/clickup";
import { summariseImport } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";

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
  const actor = await getUserActor();
  if (!actor) return Response.json({ error: "Sign in again." }, { status: 401 });
  try {
    const action = readCaptureAction(await request.json().catch(() => null));
    const outcome = await runCaptureAction(actor, action);
    if (outcome.importId) {
      const importId = outcome.importId;
      later(() => summariseImport(actor, importId), "Conversation summary failed");
    }
    if (outcome.relink) later(() => relinkCalendar(actor), "Could not relink calendar events");
    if (outcome.taskId && clickupToken()) {
      const taskId = outcome.taskId;
      later(() => pushClickUpTask(actor, taskId), "ClickUp push failed");
    }
    revalidatePath("/", "layout");
    return Response.json(outcome, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Capture change failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "That didn't save. Try again." }, { status: 500 });
  }
}
