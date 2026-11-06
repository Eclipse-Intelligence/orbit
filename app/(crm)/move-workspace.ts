"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import { moveRecordsToWorkspace, previewMoveToWorkspace, type MovePreview, type MoveRequest } from "@/lib/crm/move-workspace";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { revalidateRecordPages } from "@/lib/revalidate";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

export async function previewMoveAction(request: MoveRequest): Promise<{ preview?: MovePreview; error?: string }> {
  const user = await requireUser();
  try {
    return { preview: await previewMoveToWorkspace(user, request) };
  } catch (error) {
    return { error: actionError(error).error };
  }
}

export async function moveRecordsAction(request: MoveRequest): Promise<{ message?: string; copy?: boolean; error?: string }> {
  const user = await requireUser();
  try {
    const result = await moveRecordsToWorkspace(user, request, { operation: request.copy === true ? "copy_to_workspace" : "move_to_workspace", source: "web" });
    revalidatePath("/");
    revalidateRecordPages();
    revalidatePath("/contacts");
    revalidatePath("/opportunities");
    revalidatePath("/boards", "layout");
    revalidatePath(TASKS_PATH);
    return { message: result.message, copy: result.copy };
  } catch (error) {
    return { error: actionError(error).error };
  }
}
