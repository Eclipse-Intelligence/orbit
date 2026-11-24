"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { WORKSPACE_COOKIE, sessionCookieOptions } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { createWorkspace } from "@/lib/crm/workspaces";

const YEAR = 60 * 60 * 24 * 365;

async function selectWorkspace(id: string) {
  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, id, sessionCookieOptions(YEAR));
}

export async function createWorkspaceAction(input: { name: string }): Promise<{ id?: string; error?: string }> {
  const user = await getUserActor();
  if (!user) redirect("/login");
  try {
    const created = await createWorkspace(user, input);
    await selectWorkspace(created.id);
    return { id: created.id };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't create the workspace." };
  }
}
