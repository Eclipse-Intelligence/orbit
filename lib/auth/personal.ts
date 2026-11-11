import { randomBytes } from "node:crypto";
import { memberActor } from "@/lib/crm/conversations";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound, tooMany } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { hashToken } from "@/lib/crm/tokens";
import { consumeRateLimitFor } from "@/lib/auth/rate-limit";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

const PERSONAL_PREFIX = "orbit_";
const TOKENS_MAX = 10;

export type PersonalToken = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; workspaceName: string; canSend: boolean };

type TokenRow = { id: string; name: string; prefix: string; created_at: Date | string; last_used_at: Date | string | null; workspace_name: string | null; can_send: boolean };

const TOKEN_COLUMNS = "id, name, prefix, created_at, last_used_at, can_send, (select w.name from crm.workspaces w where w.id = crm.personal_tokens.workspace_id) as workspace_name";

function toToken(row: TokenRow): PersonalToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    workspaceName: row.workspace_name ?? "",
    canSend: row.can_send === true,
  };
}

export function isPersonalToken(token: string) {
  return token.startsWith(PERSONAL_PREFIX);
}

export async function listPersonalTokens(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<TokenRow>(
      `select ${TOKEN_COLUMNS} from crm.personal_tokens where user_id = $1 and revoked_at is null order by created_at desc`,
      [actor.userId],
    );
    return result.rows.map(toToken);
  });
}

export async function createPersonalToken(actor: UserActor, rawName: unknown, options: { canSend?: boolean } = {}) {
  const name = typeof rawName === "string" ? rawName.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (!name) throw new CrmError("invalid_input", "Enter a name for the token.", 400, { field: "name" });
  const prefix = `${PERSONAL_PREFIX}${randomBytes(4).toString("hex")}`;
  const token = `${prefix}_${randomBytes(32).toString("base64url")}`;
  const created = await withActor(actor, async (db) => {
    const count = await db.query<{ count: number }>("select count(*)::int as count from crm.personal_tokens where user_id = $1 and revoked_at is null", [actor.userId]);
    if ((count.rows[0]?.count ?? 0) >= TOKENS_MAX) throw new CrmError("invalid_input", `${tooMany(TOKENS_MAX, "tokens")} Revoke one first.`, 400);
    const result = await db.query<TokenRow>(
      `insert into crm.personal_tokens (workspace_id, user_id, name, prefix, token_hash, can_send) values ($1, $2, $3, $4, $5, $6)
       returning ${TOKEN_COLUMNS}`,
      [actor.workspaceId, actor.userId, name, prefix, hashToken(token), options.canSend === true],
    );
    return result.rows[0];
  });
  return { token, details: toToken(created) };
}

export async function revokePersonalToken(actor: UserActor, id: string) {
  if (!isUuid(id)) throw notFound("token");
  await withActor(actor, (db) =>
    db.query("update crm.personal_tokens set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null", [id, actor.userId]),
  );
}

export async function setPersonalTokenSending(actor: UserActor, id: string, canSend: boolean) {
  if (!isUuid(id)) throw notFound("token");
  const row = await withActor(actor, async (db) => {
    const result = await db.query<TokenRow>(
      `update crm.personal_tokens set can_send = $3 where id = $1 and user_id = $2 and revoked_at is null returning ${TOKEN_COLUMNS}`,
      [id, actor.userId, canSend],
    );
    return result.rows[0] ?? null;
  });
  if (!row) throw notFound("token");
  return toToken(row);
}

export async function authenticatePersonal(token: string): Promise<{ actor: UserActor; tokenId: string; canSend: boolean }> {
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
  const actor = memberActor(row);
  const canSend = await withActor(actor, async (db) => {
    const found = await db.query<{ can_send: boolean }>("select can_send from crm.personal_tokens where id = $1 and user_id = $2", [row.token_id, actor.userId]);
    return found.rows[0]?.can_send === true;
  });
  return { actor, tokenId: row.token_id, canSend };
}

export async function consumePersonalRateLimit(tokenId: string, cost = 1) {
  await consumeRateLimitFor(`personal:${tokenId}`, cost);
}
