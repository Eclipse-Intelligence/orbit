"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import {
  disableClickUpWebhook,
  enableClickUpWebhook,
  saveClickUpSettings,
  syncClickUpFor,
} from "@/lib/crm/clickup";
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

export type ClickUpActionState = { error?: string; message?: string };

async function requestOrigin() {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:4173";
  return `${headerStore.get("x-forwarded-proto") ?? "http"}://${host}`;
}

function clickupFailure(error: unknown, fallback: string): ClickUpActionState {
  return { error: error instanceof CrmError ? error.message : fallback };
}

function refreshClickUp() {
  revalidatePath("/settings");
  revalidatePath("/actions");
  revalidatePath("/");
}

export async function saveClickUpSettingsAction(input: {
  teamId: string;
  defaultListId: string | null;
  watchedListIds: string[];
}): Promise<ClickUpActionState> {
  const user = await requireUser();
  try {
    const saved = await saveClickUpSettings(user, input, { origin: await requestOrigin() });
    refreshClickUp();
    return { message: saved.warning ?? "ClickUp settings saved." };
  } catch (error) {
    return clickupFailure(error, "Could not save the ClickUp settings.");
  }
}

export async function syncClickUpAction(): Promise<ClickUpActionState> {
  const user = await requireUser();
  try {
    const result = await syncClickUpFor(user, {
      origin: await requestOrigin(),
      deadline: Date.now() + 50_000,
    });
    refreshClickUp();
    if (result.error) return { error: result.error };
    return {
      message: `Synced: ${result.imported} new, ${result.updated} updated from ClickUp, ${result.pushed} sent to ClickUp.`,
    };
  } catch (error) {
    return clickupFailure(error, "Could not sync ClickUp.");
  }
}

export async function enableClickUpWebhookAction(): Promise<ClickUpActionState> {
  const user = await requireUser();
  try {
    const result = await enableClickUpWebhook(user, await requestOrigin());
    refreshClickUp();
    return { message: result.message };
  } catch (error) {
    return clickupFailure(error, "Could not turn on instant ClickUp sync.");
  }
}

export async function disableClickUpWebhookAction(): Promise<ClickUpActionState> {
  const user = await requireUser();
  try {
    const result = await disableClickUpWebhook(user);
    refreshClickUp();
    return { message: result.message };
  } catch (error) {
    return clickupFailure(error, "Could not turn off instant ClickUp sync.");
  }
}
