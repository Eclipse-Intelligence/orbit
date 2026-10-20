import { randomBytes, randomInt } from "node:crypto";
import { membershipsFor } from "@/lib/auth/user";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import { scopesForRole } from "@/lib/crm/scopes";
import { hashToken } from "@/lib/crm/tokens";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 10 * 60 * 1000;
export const ONLINE_WINDOW_MS = 75 * 1000;

export type CompanionSummary = {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
};

export type AuthenticatedCompanion = { companionId: string; name: string; actor: UserActor };

type CompanionRow = { id: string; name: string; created_at: Date | string; last_seen_at: Date | string | null };

function normaliseCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function newCode() {
  const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function summary(row: CompanionRow, now = Date.now()): CompanionSummary {
  const lastSeen = iso(row.last_seen_at);
  return {
    id: row.id,
    name: row.name,
    createdAt: iso(row.created_at) ?? new Date(now).toISOString(),
    lastSeenAt: lastSeen,
    online: Boolean(lastSeen && now - new Date(lastSeen).getTime() < ONLINE_WINDOW_MS),
  };
}

export async function createPairingCode(actor: UserActor) {
  const code = newCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await withActor(actor, async (db) => {
    await db.query("delete from crm.ai_companion_pairings where user_id = $1 and (used_at is not null or expires_at < now())", [actor.userId]);
    await db.query(
      "insert into crm.ai_companion_pairings (workspace_id, user_id, code_hash, expires_at) values ($1, $2, $3, $4)",
      [actor.workspaceId, actor.userId, hashToken(normaliseCode(code)), expiresAt.toISOString()],
    );
  });
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function listCompanions(actor: UserActor): Promise<CompanionSummary[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<CompanionRow>(
      `select id, name, created_at, last_seen_at from crm.ai_companions
       where user_id = $1 and workspace_id = $2 and revoked_at is null order by created_at`,
      [actor.userId, actor.workspaceId],
    );
    const now = Date.now();
    return result.rows.map((row) => summary(row, now));
  });
}

export async function companionOnline(actor: UserActor) {
  return (await listCompanions(actor)).some((companion) => companion.online);
}

export async function revokeCompanion(actor: UserActor, id: unknown) {
  if (typeof id !== "string" || !isUuid(id)) throw new CrmError("not_found", "That Mac isn't paired.", 404);
  await withActor(actor, async (db) => {
    const result = await db.query("update crm.ai_companions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null", [
      id,
      actor.userId,
    ]);
    if (result.rowCount === 0) throw new CrmError("not_found", "That Mac isn't paired.", 404);
  });
}

async function actorFor(userId: string, workspaceId: string): Promise<UserActor | null> {
  const membership = (await membershipsFor(userId)).find((item) => item.workspace_id === workspaceId);
  if (!membership) return null;
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

export async function redeemPairing(code: unknown, name: unknown) {
  const clean = typeof code === "string" ? normaliseCode(code) : "";
  if (clean.length !== 8) throw new CrmError("invalid_input", "Enter the 8-character code from Orbit.", 400);
  const token = `oa_${randomBytes(32).toString("base64url")}`;
  const result = await query<{ companion_id: string; user_id: string; workspace_id: string }>(
    "select * from private.redeem_companion_pairing($1, $2, $3)",
    [hashToken(clean), hashToken(token), typeof name === "string" ? name.slice(0, 120) : "Mac"],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("invalid_input", "That code has expired or was already used. Make a new one in Orbit.", 400);
  const actor = await actorFor(row.user_id, row.workspace_id);
  return { token, companionId: row.companion_id, email: actor?.email ?? null, workspace: actor?.workspaceName ?? null };
}

export async function authenticateCompanion(request: Request): Promise<AuthenticatedCompanion> {
  const match = /^Bearer\s+(oa_\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new CrmError("unauthorized", "Pair Orbit Agent again.", 401);
  const result = await query<{ companion_id: string; user_id: string; workspace_id: string; name: string }>(
    "select * from private.authenticate_companion($1)",
    [hashToken(match[1])],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("unauthorized", "This Mac was removed from Orbit. Pair it again.", 401);
  const actor = await actorFor(row.user_id, row.workspace_id);
  if (!actor) throw new CrmError("unauthorized", "This Mac was removed from Orbit. Pair it again.", 401);
  return { companionId: row.companion_id, name: row.name, actor };
}

export const AGENT_START_COMMAND = "npx -y --package=https://orbit.geteclipse.co/downloads/orbit-agent.tgz orbit-agent --install";

function sinceText(iso: string, now: number) {
  const minutes = Math.max(1, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export async function companionOfflineMessage(actor: UserActor, now = Date.now()) {
  const companions = await listCompanions(actor);
  if (companions.length === 0) {
    return "To use your Claude account, pair your Mac in Settings › Integrations. It takes one command in Terminal.";
  }
  const latest = companions
    .filter((companion) => companion.lastSeenAt)
    .sort((a, b) => new Date(b.lastSeenAt!).getTime() - new Date(a.lastSeenAt!).getTime())[0];
  const seen = latest ? ` ${latest.name} was last seen ${sinceText(latest.lastSeenAt!, now)}.` : "";
  return `Orbit Agent isn't running on your Mac.${seen} Run this once in Terminal and it will keep running, starting by itself at login: ${AGENT_START_COMMAND}`;
}
