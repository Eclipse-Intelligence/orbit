"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import {
  archiveWorkflow,
  createWorkflow,
  decideApproval,
  getRunSteps,
  markNotificationsRead,
  saveWorkflow,
  setWorkflowStatus,
  setWorkflowTemplate,
  startRun,
  type RunStepLog,
  type RunSummary,
  type Workflow,
  type WorkflowStatus,
} from "@/lib/workflows/store";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function failure(error: unknown, fallback: string) {
  if (!(error instanceof CrmError)) console.error(fallback, error);
  return { error: error instanceof CrmError ? error.message : fallback };
}

function refresh(id?: string) {
  revalidatePath("/workflows");
  if (id) revalidatePath(`/workflows/${id}`);
}

export async function createWorkflowAction(input: { name?: string; template?: string | null }): Promise<{ id?: string; error?: string }> {
  const user = await requireUser();
  try {
    const workflow = await createWorkflow(user, input);
    refresh();
    return { id: workflow.id };
  } catch (error) {
    return failure(error, "Couldn't create the workflow.");
  }
}

export async function saveWorkflowAction(
  id: string,
  input: { name?: string; description?: string | null; definition?: unknown },
): Promise<{ workflow?: Workflow; error?: string }> {
  const user = await requireUser();
  try {
    const workflow = await saveWorkflow(user, id, input);
    refresh(id);
    return { workflow };
  } catch (error) {
    return failure(error, "Couldn't save the workflow.");
  }
}

export async function setWorkflowStatusAction(id: string, status: WorkflowStatus): Promise<{ workflow?: Workflow; error?: string }> {
  const user = await requireUser();
  try {
    const workflow = await setWorkflowStatus(user, id, status);
    refresh(id);
    return { workflow };
  } catch (error) {
    return failure(error, "Couldn't change the workflow.");
  }
}

export async function setWorkflowTemplateAction(id: string, shared: boolean): Promise<{ workflow?: Workflow; error?: string }> {
  const user = await requireUser();
  try {
    const workflow = await setWorkflowTemplate(user, id, shared);
    refresh(id);
    return { workflow };
  } catch (error) {
    return failure(error, "Couldn't change sharing.");
  }
}

export async function archiveWorkflowAction(id: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await archiveWorkflow(user, id);
    refresh();
    return {};
  } catch (error) {
    return failure(error, "Couldn't delete the workflow.");
  }
}

export async function runWorkflowAction(
  id: string,
  input: { test: boolean; record?: { type: "company" | "contact"; id: string } | null },
): Promise<{ runId?: string; status?: string; error?: string }> {
  const user = await requireUser();
  try {
    const result = await startRun(user, id, input);
    refresh(id);
    return result;
  } catch (error) {
    return failure(error, "Couldn't run the workflow.");
  }
}

export async function runDetailsAction(runId: string): Promise<{ run?: RunSummary; steps?: RunStepLog[]; error?: string }> {
  const user = await requireUser();
  try {
    return await getRunSteps(user, runId);
  } catch (error) {
    return failure(error, "Couldn't load the run.");
  }
}

export async function decideApprovalAction(runId: string, approved: boolean, note?: string): Promise<{ status?: string; error?: string }> {
  const user = await requireUser();
  try {
    const status = await decideApproval(user, runId, { approved, note });
    revalidatePath("/", "layout");
    return { status };
  } catch (error) {
    return failure(error, "Couldn't record your decision.");
  }
}

export async function markNotificationsReadAction(ids?: string[]): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await markNotificationsRead(user, ids);
    return {};
  } catch (error) {
    return failure(error, "Couldn't update notifications.");
  }
}
