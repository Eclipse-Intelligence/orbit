"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { revokeBrowser, setBrowserWorkspaces } from "@/lib/extension/pairing";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function failed(error: unknown, fallback: string) {
  if (error instanceof CrmError) return { error: error.message };
  console.error(fallback, error);
  return { error: fallback };
}

export async function revokeBrowserAction(id: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await revokeBrowser(user, id);
    revalidatePath(SETTINGS_PATHS.connections);
    return {};
  } catch (error) {
    return failed(error, "Couldn't revoke that browser. Try again.");
  }
}

export async function setBrowserWorkspacesAction(id: string, workspaceIds: string[]): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await setBrowserWorkspaces(user, id, workspaceIds);
    revalidatePath(SETTINGS_PATHS.connections);
    return {};
  } catch (error) {
    return failed(error, "Couldn't change its workspaces. Try again.");
  }
}
