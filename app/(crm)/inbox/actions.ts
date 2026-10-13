"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { syncCalls } from "@/lib/crm/calls";
import { fileImport, ignoreImport, summariseImport } from "@/lib/crm/conversations";
import { enableGranolaWebhook, syncGranolaFor } from "@/lib/crm/granola";
import {
  disconnectMailbox,
  sendContactEmail,
  syncMailbox,
} from "@/lib/crm/inbox";
import { ensureTranscriptSubscription, syncTeamsTranscripts } from "@/lib/crm/teams-transcripts";
import { actionError } from "@/lib/companies";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function refreshRecords() {
  revalidatePath("/inbox");
  revalidatePath("/");
  revalidatePath("/activities");
  revalidatePath("/contacts");
}

function inboxWith(key: "error" | "info", message: string): never {
  redirect(`/inbox?${key}=${encodeURIComponent(message)}`);
}

export async function syncInboxAction() {
  const user = await requireUser();
  const result = await syncMailbox(user);
  revalidatePath("/inbox");
  revalidatePath("/");
  if (result.error)
    redirect(`/inbox?error=${encodeURIComponent(result.error)}`);
  redirect("/inbox");
}

export async function syncCallsAction() {
  const user = await requireUser();
  const result = await syncCalls(user, { force: true });
  revalidatePath("/inbox");
  revalidatePath("/");
  revalidatePath("/activities");
  revalidatePath("/contacts");
  if (result.error)
    redirect(`/inbox?error=${encodeURIComponent(result.error)}`);
  redirect("/inbox");
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
  if (error) inboxWith("error", error);
  redirect("/inbox");
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
    inboxWith("error", actionError(failure).error);
  }
  revalidatePath("/inbox");
  inboxWith("info", message);
}

export async function syncTranscriptsAction() {
  const user = await requireUser();
  const result = await syncTeamsTranscripts(user, { force: true });
  const subscription = await ensureTranscriptSubscription(user);
  refreshRecords();
  const error = result.error ?? subscription.error;
  if (error) inboxWith("error", error);
  redirect("/inbox");
}

export type ConversationActionState = { error?: string; ok?: boolean };

export async function fileConversationAction(
  importId: string,
  contactId: string,
): Promise<ConversationActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to file conversations." };
  try {
    await fileImport(user, importId, contactId, { summarise: false });
  } catch (error) {
    return actionError(error);
  }
  after(async () => {
    try {
      await summariseImport(user, importId);
    } catch (error) {
      console.error("Conversation summary failed", error);
    }
  });
  refreshRecords();
  return { ok: true };
}

export async function ignoreConversationAction(
  importId: string,
): Promise<ConversationActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to change conversations." };
  try {
    await ignoreImport(user, importId);
  } catch (error) {
    return actionError(error);
  }
  revalidatePath("/inbox");
  return { ok: true };
}

export async function sendContactEmailAction(
  contactId: string,
  subject: string,
  body: string,
) {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to send mail." };
  let warning: string | null;
  try {
    ({ warning } = await sendContactEmail(user, contactId, { subject, body }));
  } catch (error) {
    return actionError(error);
  }
  revalidatePath("/contacts");
  revalidatePath("/");
  revalidatePath("/inbox");
  revalidatePath("/activities");
  return { ok: true as const, warning };
}

export async function disconnectInboxAction() {
  const user = await requireUser();
  await disconnectMailbox(user);
  revalidatePath("/inbox");
  redirect("/inbox");
}
