import { createHash, randomBytes } from "node:crypto";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { canonicalEmail } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export type InviteRole = "member" | "admin";

export type TeamMember = {
  id: string;
  name: string;
  email: string | null;
  role: WorkspaceRole;
  joinedAt: string;
};

export type TeamInvite = {
  id: string;
  email: string;
  role: InviteRole;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
};

export type Team = { members: TeamMember[]; invites: TeamInvite[] };

export type InvitePreview = {
  inviteId: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  role: InviteRole;
  invitedBy: string | null;
  status: "pending" | "accepted" | "revoked" | "expired";
};

export function inviteTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function teamError(error: unknown): never {
  if (isPgError(error) && ["42501", "22023", "23505"].includes(error.code)) {
    const code = error.code === "42501" ? "forbidden" : error.code === "23505" ? "conflict" : "invalid_input";
    const status = error.code === "42501" ? 403 : error.code === "23505" ? 409 : 400;
    throw new CrmError(code, error.message, status);
  }
  throw error;
}

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

export function canManageTeam(actor: UserActor) {
  return actor.role === "owner" || actor.role === "admin";
}

export async function getTeam(actor: UserActor): Promise<Team> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const members = await db.query<{ id: string; full_name: string | null; email: string | null; role: WorkspaceRole; created_at: Date }>(
      `select p.id, p.full_name, p.email, m.role, m.created_at
       from crm.workspace_members m
       join crm.profiles p on p.id = m.user_id
       where m.workspace_id = $1
       order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, coalesce(nullif(p.full_name, ''), p.email)`,
      [actor.workspaceId],
    );
    const invites = canManageTeam(actor)
      ? await db.query<{ id: string; email: string; role: InviteRole; invited_by: string | null; created_at: Date; expires_at: Date }>(
          `select i.id, i.email, i.role, coalesce(nullif(p.full_name, ''), p.email) as invited_by, i.created_at, i.expires_at
           from crm.workspace_invites i
           left join crm.profiles p on p.id = i.invited_by
           where i.workspace_id = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
           order by i.created_at desc`,
          [actor.workspaceId],
        )
      : { rows: [] };
    return {
      members: members.rows.map((row) => ({
        id: row.id,
        name: row.full_name || row.email || "Member",
        email: row.email,
        role: row.role,
        joinedAt: iso(row.created_at),
      })),
      invites: invites.rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        invitedBy: row.invited_by,
        createdAt: iso(row.created_at),
        expiresAt: iso(row.expires_at),
      })),
    };
  });
}

export async function createInvite(
  actor: UserActor,
  input: { email: string; role?: string },
): Promise<{ inviteId: string; email: string; role: InviteRole; token: string }> {
  const email = canonicalEmail(input.email ?? "");
  if (!email) throw new CrmError("invalid_input", "Enter a valid email address.", 400, { field: "email" });
  const role: InviteRole = input.role === "admin" ? "admin" : "member";
  const token = randomBytes(32).toString("base64url");
  try {
    const result = await query<{ id: string }>("select private.team_invite($1, $2, $3, $4, $5) as id", [
      actor.workspaceId,
      actor.userId,
      email,
      role,
      inviteTokenHash(token),
    ]);
    return { inviteId: result.rows[0].id, email, role, token };
  } catch (error) {
    teamError(error);
  }
}

export async function revokeInvite(actor: UserActor, inviteId: string) {
  try {
    await query("select private.team_revoke_invite($1, $2, $3)", [actor.workspaceId, actor.userId, inviteId]);
  } catch (error) {
    teamError(error);
  }
}

export async function setMemberRole(actor: UserActor, userId: string, role: string) {
  try {
    await query("select private.team_set_role($1, $2, $3, $4)", [actor.workspaceId, actor.userId, userId, role]);
  } catch (error) {
    teamError(error);
  }
}

export async function removeMember(actor: UserActor, userId: string) {
  try {
    await query("select private.team_remove($1, $2, $3)", [actor.workspaceId, actor.userId, userId]);
  } catch (error) {
    teamError(error);
  }
}

export async function previewInvite(token: string): Promise<InvitePreview | null> {
  if (!token || token.length > 200) return null;
  const result = await query<{
    invite_id: string;
    workspace_id: string;
    workspace_name: string;
    email: string;
    role: InviteRole;
    invited_by_name: string | null;
    status: InvitePreview["status"];
  }>("select * from private.invite_preview($1)", [inviteTokenHash(token)]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    inviteId: row.invite_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by_name,
    status: row.status,
  };
}

export async function acceptInvite(token: string, userId: string): Promise<string> {
  try {
    const result = await query<{ workspace_id: string }>("select private.accept_invite($1, $2) as workspace_id", [
      inviteTokenHash(token),
      userId,
    ]);
    return result.rows[0].workspace_id;
  } catch (error) {
    teamError(error);
  }
}

export function inviteEmail(input: { workspaceName: string; inviterName: string; link: string }) {
  return {
    subject: `Join ${input.workspaceName} on Orbit`,
    body: [
      "Hi,",
      "",
      `${input.inviterName} has invited you to ${input.workspaceName} on Orbit, our CRM.`,
      "",
      `Set up your login here: ${input.link}`,
      "",
      "The link works once and expires in 14 days.",
    ].join("\n"),
  };
}
