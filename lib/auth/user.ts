import { cookies } from "next/headers";
import { query } from "@/lib/db/pool";
import {
  SESSION_COOKIE,
  WORKSPACE_COOKIE,
  supabaseConfigured,
} from "@/lib/auth/config";
import { readSession } from "@/lib/auth/session";
import { createSupabaseServer } from "@/lib/auth/supabase";
import { CrmError, isPgError } from "@/lib/crm/errors";
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
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
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

export async function ensurePersonalWorkspace(userId: string) {
  const result = await query<{ id: string }>(
    "select private.ensure_personal_workspace($1) as id",
    [userId],
  );
  return result.rows[0].id;
}

export async function verifyLocalPassword(email: string, password: string) {
  const result = await query<{ user_id: string | null }>(
    "select private.verify_local_password($1, $2) as user_id",
    [email, password],
  );
  return result.rows[0]?.user_id ?? null;
}

export async function createLocalUser(
  email: string,
  password: string,
  fullName: string,
) {
  try {
    const result = await query<{ id: string }>(
      "select private.create_local_user($1, $2, $3) as id",
      [email, password, fullName],
    );
    return result.rows[0].id;
  } catch (error) {
    if (isPgError(error) && error.code === "23505") {
      throw new CrmError(
        "account_exists",
        "An account with that email already exists.",
        409,
      );
    }
    if (isPgError(error) && error.code === "22023") {
      throw new CrmError(
        "invalid_input",
        "Use a valid email and a password of at least 8 characters.",
        400,
      );
    }
    throw error;
  }
}

export async function getUserActor(): Promise<UserActor | null> {
  const userId = await currentUserId();
  if (!userId) return null;

  let memberships = await membershipsFor(userId);
  if (memberships.length === 0) {
    await ensurePersonalWorkspace(userId);
    memberships = await membershipsFor(userId);
  }
  if (memberships.length === 0) return null;

  const cookieStore = await cookies();
  const requested = cookieStore.get(WORKSPACE_COOKIE)?.value;
  const membership =
    memberships.find((item) => item.workspace_id === requested) ?? memberships[0];

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
