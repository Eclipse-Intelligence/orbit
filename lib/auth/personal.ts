import { randomBytes } from "node:crypto";
import { memberActor } from "@/lib/crm/conversations";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { hashToken } from "@/lib/crm/tokens";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export const PERSONAL_PREFIX = "orbit_";
const TOKENS_MAX = 10;

export type PersonalToken = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null };

type TokenRow = { id: string; name: string; prefix: string; created_at: Date | string; last_used_at: Date | string | null };

function toToken(row: TokenRow): PersonalToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  };
}

export function isPersonalToken(token: string) {
  return token.startsWith(PERSONAL_PREFIX);
}

export async function listPersonalTokens(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<TokenRow>(
      "select id, name, prefix, created_at, last_used_at from crm.personal_tokens where user_id = $1 and revoked_at is null order by created_at desc",
      [actor.userId],
    );
    return result.rows.map(toToken);
  });
}

export async function createPersonalToken(actor: UserActor, rawName: unknown) {
  const name = typeof rawName === "string" ? rawName.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (!name) throw new CrmError("invalid_input", "Give the token a name, such as Claude.", 400, { field: "name" });
  const prefix = `${PERSONAL_PREFIX}${randomBytes(4).toString("hex")}`;
  const token = `${prefix}_${randomBytes(32).toString("base64url")}`;
  const created = await withActor(actor, async (db) => {
    const count = await db.query<{ count: number }>("select count(*)::int as count from crm.personal_tokens where user_id = $1 and revoked_at is null", [actor.userId]);
    if ((count.rows[0]?.count ?? 0) >= TOKENS_MAX) throw new CrmError("invalid_input", `You can have up to ${TOKENS_MAX} tokens. Revoke one first.`, 400);
    const result = await db.query<TokenRow>(
      `insert into crm.personal_tokens (workspace_id, user_id, name, prefix, token_hash) values ($1, $2, $3, $4, $5)
       returning id, name, prefix, created_at, last_used_at`,
      [actor.workspaceId, actor.userId, name, prefix, hashToken(token)],
    );
    return result.rows[0];
  });
  return { token, details: toToken(created) };
}

export async function revokePersonalToken(actor: UserActor, id: string) {
  if (!isUuid(id)) throw new CrmError("not_found", "Token not found.", 404);
  await withActor(actor, (db) =>
    db.query("update crm.personal_tokens set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null", [id, actor.userId]),
  );
}

export async function authenticatePersonal(token: string): Promise<{ actor: UserActor; tokenId: string }> {
  const result = await query<{
    token_id: string;
    workspace_id: string;
    workspace_name: string;
    user_id: string;
    role: WorkspaceRole;
    email: string | null;
    full_name: string | null;
  }>("select * from private.authenticate_personal_token($1)", [hashToken(token)]);
  const row = result.rows[0];
  if (!row) throw new CrmError("unauthorized", "Invalid credentials.", 401);
  return { actor: memberActor(row), tokenId: row.token_id };
}

export async function consumePersonalRateLimit(tokenId: string) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`personal:${tokenId}`, 120, 60]);
  if (!result.rows[0]?.allowed) throw new CrmError("rate_limited", "Too many requests.", 429);
}
