"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { savePipelineStages, type StageDraft } from "@/lib/crm/pipeline";
import type { PipelineStage } from "@/lib/crm/types";
import { archiveWebhook, createWebhook } from "@/lib/crm/webhooks";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

export async function createWebhookAction(url: string, events: string[], description: string) {
  const user = await requireUser();
  try {
    const result = await createWebhook(user, { url, events, description });
    revalidatePath("/settings");
    return { secret: result.secret, id: result.endpoint.id };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Could not save the webhook." };
  }
}

export async function archiveWebhookAction(id: string) {
  const user = await requireUser();
  try {
    await archiveWebhook(user, id);
    revalidatePath("/settings");
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Could not remove the webhook." };
  }
}

export async function saveStagesAction(
  stages: StageDraft[],
): Promise<{ error?: string; stages?: PipelineStage[] }> {
  const user = await requireUser();
  try {
    const saved = await savePipelineStages(user, stages);
    revalidatePath("/settings");
    revalidatePath("/opportunities");
    return { stages: saved };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Could not save the pipeline." };
  }
}
