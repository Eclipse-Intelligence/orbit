"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import {
  checkSlugAvailable,
  saveBookingPage,
  type BookingPageInput,
  type BookingPageSettings,
} from "@/lib/booking/pages";
import {
  disableClickUpWebhook,
  enableClickUpWebhook,
  saveClickUpSettings,
  syncClickUpFor,
} from "@/lib/crm/clickup";
import { CrmError } from "@/lib/crm/errors";
import { removeGranolaKey, saveGranolaKey } from "@/lib/crm/granola";
import { saveMeetingLink } from "@/lib/crm/invites";
import { savePipelineStages, type StageDraft } from "@/lib/crm/pipeline";
import { draftPersonalContext, savePersonalContext, type PersonalContext, type PersonalDraft } from "@/lib/crm/personal-context";
import { saveOtherEmails, type MyEmails } from "@/lib/crm/profile";
import { TASKS_PATH } from "@/lib/crm/task-views";
import type { PipelineStage } from "@/lib/crm/types";
import { removeReadwiseToken, saveReadwiseToken } from "@/lib/readwise/keys";
import { removeRecallKey, saveRecallKey } from "@/lib/recall/keys";
import { syncReaderToKnowledge } from "@/lib/readwise/sync";
import { archiveWebhook, createWebhook } from "@/lib/crm/webhooks";
import { SETTINGS_PATHS, SETTINGS_ROOT } from "@/lib/settings-nav";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

export async function createWebhookAction(url: string, events: string[], description: string) {
  const user = await requireUser();
  try {
    const result = await createWebhook(user, { url, events, description });
    revalidatePath(SETTINGS_ROOT, "layout");
    return { secret: result.secret, id: result.endpoint.id };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Could not save the webhook." };
  }
}

export async function archiveWebhookAction(id: string) {
  const user = await requireUser();
  try {
    await archiveWebhook(user, id);
    revalidatePath(SETTINGS_ROOT, "layout");
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Could not remove the webhook." };
  }
}

export async function saveStagesAction(
  stages: StageDraft[],
  pipelineId: string | null = null,
): Promise<{ error?: string; stages?: PipelineStage[] }> {
  const user = await requireUser();
  try {
    const saved = await savePipelineStages(user, stages, pipelineId);
    revalidatePath(SETTINGS_ROOT, "layout");
    revalidatePath("/opportunities");
    revalidatePath("/boards", "layout");
    return { stages: saved };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Could not save the pipeline." };
  }
}

export async function saveOtherEmailsAction(
  emails: string[],
): Promise<{ error?: string; emails?: MyEmails }> {
  const user = await requireUser();
  try {
    const saved = await saveOtherEmails(user, emails);
    revalidatePath(SETTINGS_ROOT, "layout");
    revalidatePath("/capture");
    return { emails: saved };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Could not save your email addresses." };
  }
}

export async function saveAboutYouAction(input: unknown): Promise<{ error?: string; field?: string; saved?: PersonalContext }> {
  const user = await requireUser();
  try {
    const saved = await savePersonalContext(user, input);
    revalidatePath(SETTINGS_ROOT, "layout");
    return { saved };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message, field: typeof error.details?.field === "string" ? error.details.field : undefined };
    return { error: "Could not save About you." };
  }
}

export async function draftAboutYouAction(input: { linkedinUrl: string; websiteUrl: string }): Promise<{ error?: string; field?: string; draft?: PersonalDraft }> {
  const user = await requireUser();
  try {
    return { draft: await draftPersonalContext(user, input, { deadline: Date.now() + 100_000 }) };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message, field: typeof error.details?.field === "string" ? error.details.field : undefined };
    return { error: "Could not draft About you. Try again, or fill it in yourself." };
  }
}

export async function saveMeetingLinkAction(
  link: string,
): Promise<{ error?: string; meetingLink?: string | null }> {
  const user = await requireUser();
  try {
    const meetingLink = await saveMeetingLink(user, typeof link === "string" ? link : "");
    revalidatePath(SETTINGS_ROOT, "layout");
    revalidatePath("/calendar");
    revalidatePath("/(crm)/contacts/[id]", "page");
    return { meetingLink };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Could not save the meeting link." };
  }
}

export async function saveBookingPageAction(
  input: BookingPageInput,
): Promise<{ error?: string; field?: string; page?: BookingPageSettings }> {
  const user = await requireUser();
  try {
    const page = await saveBookingPage(user, input && typeof input === "object" ? input : {});
    revalidatePath(SETTINGS_PATHS.bookingPage);
    return { page };
  } catch (error) {
    if (error instanceof CrmError) {
      const field = typeof error.details?.field === "string" ? error.details.field : undefined;
      return { error: error.message, field };
    }
    console.error("Booking page save failed", error);
    return { error: "Could not save the booking page." };
  }
}

export async function checkBookingSlugAction(
  slug: string,
): Promise<{ slug: string | null; available: boolean; error: string | null }> {
  const user = await requireUser();
  return checkSlugAvailable(user, typeof slug === "string" ? slug.slice(0, 100) : "");
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
  revalidatePath(SETTINGS_ROOT, "layout");
  revalidatePath(TASKS_PATH);
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

export async function saveGranolaKeyAction(key: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await saveGranolaKey(user, key);
    revalidatePath(SETTINGS_PATHS.integrations);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't save the Granola key." };
  }
}

export async function saveReadwiseTokenAction(token: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await saveReadwiseToken(user, token);
    revalidatePath(SETTINGS_PATHS.integrations);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't save the Readwise token." };
  }
}

export async function removeReadwiseTokenAction(): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await removeReadwiseToken(user);
    revalidatePath(SETTINGS_PATHS.integrations);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't disconnect Readwise Reader." };
  }
}

export async function saveRecallKeyAction(key: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await saveRecallKey(user, key);
    revalidatePath(SETTINGS_PATHS.integrations);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't save the Recall key." };
  }
}

export async function removeRecallKeyAction(): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await removeRecallKey(user);
    revalidatePath(SETTINGS_PATHS.integrations);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't disconnect Recall." };
  }
}

export async function syncReadwiseAction(): Promise<{ error?: string; message?: string }> {
  const user = await requireUser();
  try {
    const result = await syncReaderToKnowledge(user, { full: true, deadline: Date.now() + 50_000 });
    revalidatePath(SETTINGS_PATHS.integrations);
    if (result.error) return { error: result.error };
    if (!result.ran) return { message: "A sync is already running." };
    const changed = result.added + result.updated;
    const parts = [
      changed ? `${changed} ${changed === 1 ? "document" : "documents"} added or updated` : "Nothing new",
      result.archived ? `${result.archived} removed` : null,
      result.complete ? null : "the rest follows on the next sync",
    ].filter(Boolean);
    return { message: `${parts.join(", ")}.` };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't sync Readwise Reader." };
  }
}

export async function removeGranolaKeyAction(): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await removeGranolaKey(user);
    revalidatePath(SETTINGS_PATHS.integrations);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't remove the Granola key." };
  }
}
