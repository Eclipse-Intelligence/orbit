"use server";

import { getUserActor } from "@/lib/auth/user";
import { listMembers } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import type { WorkspaceRole } from "@/lib/crm/types";
import { actorIn, workspaceActors } from "@/lib/crm/workspaces";

export async function workspaceRolesAction(workspaceId: string): Promise<{ roles: Record<string, WorkspaceRole> } | { error: string }> {
  const actor = await getUserActor();
  if (!actor) return { error: "Your session ended. Sign in again." };
  try {
    const member = actorIn(await workspaceActors(actor), workspaceId);
    const members = await listMembers(member);
    return { roles: Object.fromEntries(members.map((item) => [item.id, item.role])) };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message };
    console.error("Reading workspace roles failed", error);
    return { error: "Couldn't load roles. Try again." };
  }
}
