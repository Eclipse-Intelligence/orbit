"use server";

import { getUserActor } from "@/lib/auth/user";
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
