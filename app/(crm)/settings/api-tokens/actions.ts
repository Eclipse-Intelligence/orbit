"use server";

import { getUserActor } from "@/lib/auth/user";
import { createPersonalToken, revokePersonalToken, setPersonalTokenSending, type PersonalToken } from "@/lib/auth/personal";
import { CrmError } from "@/lib/crm/errors";

export async function createPersonalTokenAction(name: string, canSend = false): Promise<{ token?: string; details?: PersonalToken; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return await createPersonalToken(user, name, { canSend: canSend === true });
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

export async function setPersonalTokenSendingAction(id: string, canSend: boolean): Promise<{ details?: PersonalToken; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return { details: await setPersonalTokenSending(user, id, canSend === true) };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't save. Try again." };
  }
}
