"use server";

import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import type { MailShareControl, MailShareResult } from "@/lib/mail/share-types";
import { removeFromShare, shareThread } from "@/lib/mail/shares";

async function run<T extends object>(fallback: string, work: (actor: UserActor) => Promise<T>): Promise<MailShareResult<T>> {
  try {
    const actor = await getUserActor();
    if (!actor) return { error: "Your session ended. Sign in again." };
    return { ok: true, ...(await work(actor)) };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message };
    console.error("Shared mail action failed", error);
    return { error: fallback };
  }
}

export async function shareThreadAction(threadKey: string, userIds: string[]): Promise<MailShareResult<{ share: MailShareControl; added: string[] }>> {
  return run("Couldn't share the thread. Try again.", (actor) => shareThread(actor, threadKey, userIds));
}

export async function removeFromShareAction(shareId: string, userId: string): Promise<MailShareResult<{ removed: boolean }>> {
  return run("Couldn't remove them. Try again.", (actor) => removeFromShare(actor, shareId, userId));
}
