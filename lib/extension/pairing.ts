import { randomBytes, randomInt } from "node:crypto";
import { membershipsFor } from "@/lib/auth/user";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import { scopesForRole, type Scope } from "@/lib/crm/scopes";
import { hashToken } from "@/lib/crm/tokens";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { EXTENSION_TOKEN_PREFIX, PAIRING_TTL_MINUTES, type PairRedeemResponse, type PairStartResponse } from "@/lib/extension/protocol";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EXTENSION_SCOPES: Scope[] = ["crm:read", "companies:write", "contacts:write", "leads:write", "activities:write", "opportunities:write", "tasks:write"];

export type BrowserSummary = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  workspaces: { id: string; name: string }[];
};

export type ExtensionAuth = {
  browserId: string;
  name: string;
  userId: string;
  workspaceIds: string[];
};

export type PairingState = "pending" | "approved" | "declined" | "used" | "expired" | "missing";

function normalisePairingCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function newCode() {
  const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function codeHash(code: string) {
  return hashToken(`extension:${normalisePairingCode(code)}`);
}

export async function startPairing(orbitUrl: string): Promise<PairStartResponse> {
  const code = newCode();
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MINUTES * 60_000);
  await query("select private.extension_pairing_start($1, $2, $3)", [codeHash(code), hashToken(secret), expiresAt.toISOString()]);
  const approveUrl = `${orbitUrl.replace(/\/$/, "")}/connect/chrome`;
  return { code, secret, expiresAt: expiresAt.toISOString(), approveUrl };
}

export async function pairingState(code: string): Promise<{ state: PairingState; expiresAt: string | null }> {
  if (normalisePairingCode(code).length !== 8) return { state: "missing", expiresAt: null };
  const result = await query<{ status: string; expires_at: Date | string }>("select * from private.extension_pairing_status($1)", [codeHash(code)]);
  const row = result.rows[0];
  if (!row) return { state: "missing", expiresAt: null };
  return { state: row.status as PairingState, expiresAt: iso(row.expires_at) };
}

export async function decidePairing(
  actor: UserActor,
  input: { code: unknown; name?: unknown; workspaceIds?: unknown; approve: boolean },
) {
  const code = typeof input.code === "string" ? input.code : "";
  if (normalisePairingCode(code).length !== 8) throw new CrmError("invalid_input", "Enter the 8-character code from the Orbit panel.", 400, { field: "code" });
  const ids = Array.isArray(input.workspaceIds) ? input.workspaceIds.filter((id): id is string => typeof id === "string" && isUuid(id)) : [];
  if (input.approve && ids.length === 0) throw new CrmError("invalid_input", "Choose at least one workspace.", 400, { field: "workspaceIds" });
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (input.approve && !name) throw new CrmError("invalid_input", "Give this browser a name.", 400, { field: "name" });
  await allow(`extension-decide:${actor.userId}`, 20, 600);
  const result = await query<{ status: string }>("select private.extension_pairing_decide($1, $2, $3, $4::uuid[], $5) as status", [
    codeHash(code),
    actor.userId,
    name,
    ids,
    input.approve,
  ]);
  const status = result.rows[0]?.status;
  if (status === "no_workspaces") throw new CrmError("invalid_input", "Choose a workspace you're a member of.", 400, { field: "workspaceIds" });
  if (status !== "approved" && status !== "declined") {
    throw new CrmError("expired", "That code isn't valid, has expired or was already used. Check the code in the Orbit panel, or press Connect there again.", 410);
  }
  return status;
}

export async function redeemPairing(code: unknown, secret: unknown): Promise<PairRedeemResponse> {
  const cleanCode = typeof code === "string" ? code : "";
  const cleanSecret = typeof secret === "string" ? secret : "";
  if (normalisePairingCode(cleanCode).length !== 8 || !cleanSecret) {
    throw new CrmError("invalid_input", "Press Connect again.", 400);
  }
  const token = `${EXTENSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const result = await query<{ status: string; browser_id: string | null; name: string | null; expires_at: Date | string | null }>(
    "select * from private.extension_pairing_redeem($1, $2, $3)",
    [codeHash(cleanCode), hashToken(cleanSecret), hashToken(token)],
  );
  const row = result.rows[0];
  if (row?.status === "pending") return { status: "pending", expiresAt: iso(row.expires_at) ?? new Date().toISOString() };
  if (row?.status === "approved" && row.browser_id) {
    return { status: "approved", token, browser: { id: row.browser_id, name: row.name ?? "Chrome" } };
  }
  if (row?.status === "declined") throw new CrmError("declined", "Connecting was cancelled in Orbit.", 410);
  throw new CrmError("expired", "That code has expired or was already used. Press Connect again.", 410);
}

export async function authenticateExtension(request: Request): Promise<ExtensionAuth> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  const token = match?.[1] ?? "";
  if (!token.startsWith(EXTENSION_TOKEN_PREFIX)) throw new CrmError("unauthorized", "Connect this browser to Orbit.", 401);
  const result = await query<{ browser_id: string; user_id: string; name: string; workspace_ids: string[] }>(
    "select * from private.authenticate_extension($1)",
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("unauthorized", "This browser was disconnected from Orbit. Connect again.", 401);
  return { browserId: row.browser_id, name: row.name, userId: row.user_id, workspaceIds: row.workspace_ids ?? [] };
}

export async function extensionActors(auth: ExtensionAuth): Promise<UserActor[]> {
  const memberships = await membershipsFor(auth.userId);
  return auth.workspaceIds.flatMap((workspaceId) => {
    const membership = memberships.find((item) => item.workspace_id === workspaceId);
    if (!membership) return [];
    const allowed = scopesForRole(membership.role);
    return [
      {
        type: "user" as const,
        userId: auth.userId,
        email: membership.email ?? "",
        fullName: membership.full_name,
        workspaceId: membership.workspace_id,
        workspaceName: membership.workspace_name,
        role: membership.role,
        scopes: EXTENSION_SCOPES.filter((scope) => allowed.includes(scope)),
      },
    ];
  });
}

export async function extensionActor(auth: ExtensionAuth, workspaceId: string | null | undefined) {
  if (!workspaceId || !isUuid(workspaceId)) {
    throw new CrmError("workspace_required", "Choose a workspace.", 400);
  }
  if (!auth.workspaceIds.includes(workspaceId)) {
    throw new CrmError("workspace_not_allowed", "This browser can't reach that workspace. Change its workspaces in Orbit.", 403);
  }
  const actor = (await extensionActors(auth)).find((item) => item.workspaceId === workspaceId);
  if (!actor) throw new CrmError("workspace_not_allowed", "You're no longer a member of that workspace.", 403);
  return actor;
}

export async function allow(key: string, limit: number, windowSeconds: number) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [key, limit, windowSeconds]);
  if (!result.rows[0]?.allowed) throw new CrmError("rate_limited", "Too many requests. Wait a minute.", 429);
}

type BrowserRow = {
  id: string;
  name: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  workspaces: { id: string; name: string }[] | null;
};

export async function listBrowsers(actor: UserActor): Promise<BrowserSummary[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<BrowserRow>(
      `select b.id, b.name, b.created_at, b.last_used_at,
         coalesce((
           select json_agg(json_build_object('id', w.id, 'name', w.name) order by bw.created_at, w.name)
           from crm.extension_browser_workspaces bw
           join crm.workspaces w on w.id = bw.workspace_id
           where bw.browser_id = b.id
         ), '[]'::json) as workspaces
       from crm.extension_browsers b
       where b.user_id = $1 and b.revoked_at is null
       order by b.created_at desc`,
      [actor.userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: iso(row.created_at) ?? new Date().toISOString(),
      lastUsedAt: iso(row.last_used_at),
      workspaces: row.workspaces ?? [],
    }));
  });
}

export async function revokeBrowser(actor: UserActor, id: unknown) {
  if (typeof id !== "string" || !isUuid(id)) throw new CrmError("not_found", "That browser isn't connected.", 404);
  await withActor(actor, async (db) => {
    const result = await db.query("update crm.extension_browsers set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null", [
      id,
      actor.userId,
    ]);
    if (result.rowCount === 0) throw new CrmError("not_found", "That browser isn't connected.", 404);
  });
}

export async function setBrowserWorkspaces(actor: UserActor, id: unknown, workspaceIds: unknown) {
  if (typeof id !== "string" || !isUuid(id)) throw new CrmError("not_found", "That browser isn't connected.", 404);
  const memberships = await membershipsFor(actor.userId);
  const wanted = Array.isArray(workspaceIds)
    ? [...new Set(workspaceIds.filter((value): value is string => typeof value === "string" && memberships.some((item) => item.workspace_id === value)))]
    : [];
  if (wanted.length === 0) throw new CrmError("invalid_input", "Choose at least one workspace.", 400, { field: "workspaceIds" });
  await withActor(actor, async (db) => {
    const browser = await db.query("select 1 from crm.extension_browsers where id = $1 and user_id = $2 and revoked_at is null", [id, actor.userId]);
    if (browser.rowCount === 0) throw new CrmError("not_found", "That browser isn't connected.", 404);
    await db.query("delete from crm.extension_browser_workspaces where browser_id = $1 and not (workspace_id = any($2::uuid[]))", [id, wanted]);
    await db.query(
      `insert into crm.extension_browser_workspaces (browser_id, workspace_id, user_id)
       select $1, unnest($2::uuid[]), $3
       on conflict (browser_id, workspace_id) do nothing`,
      [id, wanted, actor.userId],
    );
  });
}

export async function revokeSelf(auth: ExtensionAuth) {
  const result = await query<{ revoked: boolean }>("select private.extension_revoke_browser($1) as revoked", [auth.browserId]);
  if (!result.rows[0]?.revoked) throw new CrmError("not_found", "This browser is already disconnected.", 404);
}
