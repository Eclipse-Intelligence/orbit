"use server";

import { getUserActor } from "@/lib/auth/user";
import { createPersonalToken, revokePersonalToken, type PersonalToken } from "@/lib/auth/personal";
import { CrmError } from "@/lib/crm/errors";

export async function createPersonalTokenAction(name: string): Promise<{ token?: string; details?: PersonalToken; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return await createPersonalToken(user, name);
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "The token wasn't created. Try again." };
  }
}

export async function revokePersonalTokenAction(id: string): Promise<{ error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await revokePersonalToken(user, id);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "The token wasn't revoked. Try again." };
  }
}
