"use server";

import { revalidatePath } from "next/cache";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getHomeActor, getUserActor } from "@/lib/auth/user";
import { discardAttachments, prepareAttachment, type PreparedAttachment } from "@/lib/crm/email-attachments";
import { syncCalls } from "@/lib/crm/calls";
import { captureActor } from "@/lib/crm/capture-actions";
import { listDismissedImports, type DismissedPage } from "@/lib/crm/conversations";
import { closeFollowUp } from "@/lib/crm/follow-ups";
import { enableGranolaWebhook, syncGranolaFor } from "@/lib/crm/granola";
import {
  disconnectMailbox,
  listSenders,
  saveSignature,
  sendContactEmail,
  type Sender,
  syncMailbox,
} from "@/lib/crm/inbox";
import { ensureTranscriptSubscription, syncTeamsTranscripts } from "@/lib/crm/teams-transcripts";
import { actionError } from "@/lib/companies";
import { revalidateRecordPages } from "@/lib/revalidate";
import { mailOriginFromHeaders } from "@/lib/mail/origin";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

async function requireHomeUser() {
  const user = await getHomeActor();
  if (!user) redirect("/login");
  return user;
}

function refreshRecords() {
  revalidatePath("/capture");
  revalidatePath(SETTINGS_PATHS.email);
  revalidatePath(SETTINGS_PATHS.connections);
  revalidatePath("/");
  revalidateRecordPages();
  revalidatePath(SETTINGS_PATHS.activity);
  revalidatePath("/contacts");
}

function settingsWith(path: string, key: "error" | "info", message: string): never {
  redirect(`${path}?${key}=${encodeURIComponent(message)}`);
}

export async function syncInboxAction() {
  const user = await requireUser();
  const result = await syncMailbox(user);
  refreshRecords();
  if (result.error) settingsWith(SETTINGS_PATHS.email, "error", result.error);
  redirect(SETTINGS_PATHS.email);
}

export async function syncCallsAction() {
  const user = await requireHomeUser();
  const result = await syncCalls(user, { force: true });
  refreshRecords();
  if (result.error) settingsWith(SETTINGS_PATHS.connections, "error", result.error);
  redirect(SETTINGS_PATHS.connections);
}

export async function syncGranolaAction() {
  const user = await requireUser();
  let error: string | undefined;
  try {
    error = (await syncGranolaFor(user)).error;
  } catch (failure) {
    error = actionError(failure).error;
  }
  refreshRecords();
  if (error) settingsWith(SETTINGS_PATHS.connections, "error", error);
  redirect(SETTINGS_PATHS.connections);
}

export async function enableGranolaWebhookAction() {
  const user = await requireUser();
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:4173";
  const proto = headerStore.get("x-forwarded-proto") ?? "http";
  let message: string;
  try {
    message = (await enableGranolaWebhook(user, `${proto}://${host}`)).message;
  } catch (failure) {
    settingsWith(SETTINGS_PATHS.connections, "error", actionError(failure).error);
  }
  revalidatePath(SETTINGS_PATHS.connections);
  settingsWith(SETTINGS_PATHS.connections, "info", message);
}

export async function syncTranscriptsAction() {
  const user = await requireHomeUser();
  const result = await syncTeamsTranscripts(user, { force: true });
  const subscription = await ensureTranscriptSubscription(user);
  refreshRecords();
  const error = result.error ?? subscription.error;
  if (error) settingsWith(SETTINGS_PATHS.connections, "error", error);
  redirect(SETTINGS_PATHS.connections);
}

type ConversationActionState = { error?: string; ok?: boolean };

export async function listDismissedAction(workspaceId: string, offset: number, limit: number): Promise<{ page?: DismissedPage; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return { page: await listDismissedImports(await captureActor(user, workspaceId), { offset, limit }) };
  } catch (error) {
    return actionError(error);
  }
}

export async function closeFollowUpAction(id: string, state: "used" | "dismissed"): Promise<ConversationActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await closeFollowUp(user, id, state === "used" ? "used" : "dismissed");
  } catch (error) {
    return actionError(error);
  }
  revalidatePath("/capture");
  return { ok: true };
}

export async function prepareAttachmentAction(file: { name: string; size: number; contentType: string }): Promise<{ attachment?: PreparedAttachment; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return { attachment: await prepareAttachment(user, file) };
  } catch (error) {
    return actionError(error);
  }
}

export async function saveSignatureAction(senderEmail: string, body: string): Promise<{ signature?: string | null; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return { signature: await saveSignature(user, senderEmail, body) };
  } catch (error) {
    return actionError(error);
  }
}

export async function listSendersAction(): Promise<Sender[]> {
  const user = await getUserActor();
  if (!user) return [];
  return listSenders(user);
}

export async function discardAttachmentsAction(ids: string[]) {
  const user = await getUserActor();
  if (!user) return;
  await discardAttachments(user, ids).catch(() => undefined);
}

export async function sendContactEmailAction(
  contactId: string,
  email: {
    subject: string;
    body: string;
    attachments?: string[];
    keepAttachments?: boolean;
    from?: string | null;
    signature?: boolean;
  },
) {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again.", stopsRun: true as const };
  let warning: string | null;
  try {
    ({ warning } = await sendContactEmail(user, contactId, { ...email, origin: mailOriginFromHeaders(await headers()) }));
  } catch (error) {
    return actionError(error);
  }
  revalidatePath("/contacts");
  revalidatePath("/");
  revalidateRecordPages();
  revalidatePath("/capture");
  revalidatePath(SETTINGS_PATHS.activity);
  return { ok: true as const, warning };
}

export async function disconnectInboxAction() {
  const user = await requireUser();
  await disconnectMailbox(user);
  revalidatePath("/capture");
  revalidatePath(SETTINGS_PATHS.email);
  redirect(SETTINGS_PATHS.email);
}

