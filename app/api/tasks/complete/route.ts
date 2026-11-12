import { revalidatePath } from "next/cache";
import { NextResponse, after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { clickupToken } from "@/lib/clickup";
import { pushClickUpTask } from "@/lib/crm/clickup";
import { completeTasksFromBeacon } from "@/lib/crm/task-beacon";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { actorForTask } from "@/lib/crm/workspaces";
import { revalidateRecordPages } from "@/lib/revalidate";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const actor = await getUserActor();
  const result = await completeTasksFromBeacon(request, actor);
  if (actor && result.completed.length > 0) {
    revalidatePath("/");
    revalidateRecordPages();
    revalidatePath(TASKS_PATH);
    if (clickupToken()) {
      const ids = result.completed;
      try {
        after(async () => {
          for (const id of ids) {
            try {
              await pushClickUpTask(await actorForTask(actor, id), id);
            } catch (error) {
              console.error("ClickUp push failed", error);
            }
          }
        });
      } catch (error) {
        console.error("ClickUp push failed", error);
      }
    }
  }
  return NextResponse.json(result.body, { status: result.status });
}
