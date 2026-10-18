"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { listActivities } from "@/lib/crm/activities";
import { archiveBoard, createBoard, updateBoard } from "@/lib/crm/boards";
import { CrmError } from "@/lib/crm/errors";
import { archiveOpportunity } from "@/lib/crm/opportunities";
import { listTasks } from "@/lib/crm/tasks";
import type { Activity, BoardSummary, Task } from "@/lib/crm/types";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function failure(error: unknown, fallback: string) {
  return { error: error instanceof CrmError ? error.message : fallback };
}

function refresh() {
  revalidatePath("/", "layout");
}

export async function createBoardAction(name: string): Promise<{ board?: BoardSummary; error?: string }> {
  const user = await requireUser();
  try {
    const board = await createBoard(user, { name });
    refresh();
    return { board };
  } catch (error) {
    return failure(error, "Could not create the board.");
  }
}

export async function updateBoardAction(
  id: string,
  input: { name?: string; addOnWon?: boolean },
): Promise<{ board?: BoardSummary; error?: string }> {
  const user = await requireUser();
  try {
    const board = await updateBoard(user, id, input);
    refresh();
    return { board };
  } catch (error) {
    return failure(error, "Could not save the board.");
  }
}

export async function archiveBoardAction(id: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await archiveBoard(user, id);
    refresh();
    return {};
  } catch (error) {
    return failure(error, "Could not delete the board.");
  }
}

export async function removeCardAction(id: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await archiveOpportunity(user, id, { provenance: { operation: "remove_from_board", source: "web" } });
    refresh();
    return {};
  } catch (error) {
    return failure(error, "Could not remove it from the board.");
  }
}

export async function cardContextAction(
  companyId: string,
): Promise<{ activities: Activity[]; tasks: Task[]; error?: string }> {
  const user = await requireUser();
  try {
    const [activities, tasks] = await Promise.all([
      listActivities(user, { companyId, limit: 5 }),
      listTasks(user, { companyId, view: "all", limit: 5 }),
    ]);
    return { activities: activities.data, tasks: tasks.data };
  } catch (error) {
    return { activities: [], tasks: [], ...failure(error, "Could not load this client.") };
  }
}
