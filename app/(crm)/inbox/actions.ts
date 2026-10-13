"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { syncCalls } from "@/lib/crm/calls";
import {
  disconnectMailbox,
  sendContactEmail,
  syncMailbox,
} from "@/lib/crm/inbox";
import { actionError } from "@/lib/companies";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
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
