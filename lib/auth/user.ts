import { cache } from "react";
import { cookies } from "next/headers";
import { query } from "@/lib/db/pool";
import {
  SESSION_COOKIE,
  WORKSPACE_COOKIE,
  supabaseConfigured,
} from "@/lib/auth/config";
import { readSession } from "@/lib/auth/session";
import { createSupabaseServer } from "@/lib/auth/supabase";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";

type MembershipRow = {
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

async function currentUserId() {
  if (supabaseConfigured()) {
    const supabase = await createSupabaseServer();
    const { data } = await supabase.auth.getClaims();
    return typeof data?.claims.sub === "string" ? data.claims.sub : null;
  }
  const cookieStore = await cookies();
  return readSession(cookieStore.get(SESSION_COOKIE)?.value);
}

export async function membershipsFor(userId: string) {
  const result = await query<MembershipRow>(
    "select * from private.memberships_for($1)",
    [userId],
  );
  return result.rows;
}

export async function verifyLocalPassword(email: string, password: string) {
  const result = await query<{ user_id: string | null }>(
    "select private.verify_local_password($1, $2) as user_id",
    [email, password],
  );
  return result.rows[0]?.user_id ?? null;
}

function actorFor(userId: string, membership: MembershipRow): UserActor {
  return {
    type: "user",
    userId,
    email: membership.email ?? "",
    fullName: membership.full_name,
    workspaceId: membership.workspace_id,
    workspaceName: membership.workspace_name,
    role: membership.role,
    scopes: scopesForRole(membership.role),
  };
}

export function pickMembership(memberships: MembershipRow[], requested: string | undefined) {
  return memberships.find((item) => item.workspace_id === requested) ?? memberships[0];
}

const currentMemberships = cache(async () => {
  const userId = await currentUserId();
  if (!userId) return null;
  const memberships = await membershipsFor(userId);
  if (memberships.length === 0) return null;
  return { userId, memberships };
});

export const getUserActor = cache(async (): Promise<UserActor | null> => {
  const current = await currentMemberships();
  if (!current) return null;
  const cookieStore = await cookies();
  const requested = cookieStore.get(WORKSPACE_COOKIE)?.value;
  return actorFor(current.userId, pickMembership(current.memberships, requested));
});

export const getHomeActor = cache(async (): Promise<UserActor | null> => {
  const current = await currentMemberships();
  if (!current) return null;
  return actorFor(current.userId, current.memberships[0]);
});

export type WorkspaceChoice = { id: string; name: string; role: WorkspaceRole; waiting?: boolean };

export const getWorkspaceChoices = cache(async (): Promise<WorkspaceChoice[]> => {
  const current = await currentMemberships();
  if (!current) return [];
  return current.memberships.map((item) => ({ id: item.workspace_id, name: item.workspace_name, role: item.role }));
});

export async function getMoveTargets(actor: UserActor): Promise<{ id: string; name: string }[]> {
  const choices = await getWorkspaceChoices();
  return choices.filter((choice) => choice.id !== actor.workspaceId).map((choice) => ({ id: choice.id, name: choice.name }));
}
