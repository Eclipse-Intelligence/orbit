"use server";

import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { setMailHelp } from "@/lib/mail/prepare";
import { setReadStatuses } from "@/lib/mail/tracking";

export async function setReadStatusesAction(on: boolean): Promise<{ on?: boolean; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return { on: await setReadStatuses(user, Boolean(on)) };
  } catch {
    return { error: "That didn't save. Try again." };
  }
}

export async function setMailHelpAction(input: { prepareReplies?: boolean; autoRemindDays?: number | null }): Promise<{ error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await setMailHelp(user, {
      prepareReplies: typeof input.prepareReplies === "boolean" ? input.prepareReplies : undefined,
      autoRemindDays: input.autoRemindDays === undefined ? undefined : input.autoRemindDays,
    });
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "That didn't save. Try again." };
  }
}
