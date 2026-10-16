import {
  AI_PROVIDERS,
  OAuthError,
  OPENAI_DEVICE_PAGE,
  PROVIDER_NAMES,
  pollDeviceLogin,
  refreshTokens,
  startDeviceLogin,
  type AiProvider,
  type Pending,
  type Tokens,
} from "@/lib/ai-accounts/oauth";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import type { Db } from "@/lib/db/pool";

const REFRESH_EARLY_MS = 2 * 60 * 1000;

export type AiAccountSummary = {
  provider: AiProvider;
  name: string;
  connected: boolean;
  label: string | null;
  lastError: string | null;
  connectedAt: string | null;
};

export type AiAccess = { provider: AiProvider; token: string; accountId: string | null };

type Row = {
  provider: AiProvider;
  status: "pending" | "connected";
  label: string | null;
  account_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: Date | string | null;
  pending: string | null;
  last_error: string | null;
  created_at: Date | string;
};

const COLUMNS = "provider, status, label, account_id, access_token, refresh_token, expires_at, pending, last_error, created_at";

function isProvider(value: unknown): value is AiProvider {
  return AI_PROVIDERS.includes(value as AiProvider);
}

function provider(value: unknown) {
  if (!isProvider(value)) throw new OAuthError("Pick ChatGPT.");
  return value;
}

function readPending(row: Row | undefined): Pending | null {
  if (!row?.pending) return null;
  try {
    return JSON.parse(decryptSecret(row.pending)) as Pending;
  } catch {
    return null;
  }
}

async function readRow(db: Db, actor: UserActor, which: AiProvider, lock = false) {
  const result = await db.query<Row>(
    `select ${COLUMNS} from crm.ai_accounts where user_id = $1 and workspace_id = $2 and provider = $3${lock ? " for update" : ""}`,
    [actor.userId, actor.workspaceId, which],
  );
  return result.rows[0];
}

async function savePending(actor: UserActor, which: AiProvider, pending: Pending) {
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.ai_accounts (workspace_id, user_id, provider, status, pending)
       values ($1, $2, $3, 'pending', $4)
       on conflict (user_id, provider) do update set pending = excluded.pending, last_error = null`,
      [actor.workspaceId, actor.userId, which, encryptSecret(JSON.stringify(pending))],
    ),
  );
}

async function saveTokens(db: Db, actor: UserActor, which: AiProvider, tokens: Tokens) {
  await db.query(
    `insert into crm.ai_accounts
       (workspace_id, user_id, provider, status, label, account_id, access_token, refresh_token, expires_at, pending, last_error)
     values ($1, $2, $3, 'connected', $4, $5, $6, $7, $8, null, null)
     on conflict (user_id, provider) do update set
       status = 'connected', label = excluded.label, account_id = excluded.account_id,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, pending = null, last_error = null`,
    [
      actor.workspaceId,
      actor.userId,
      which,
      tokens.label,
      tokens.accountId,
      encryptSecret(tokens.access),
      tokens.refresh ? encryptSecret(tokens.refresh) : null,
      tokens.expiresAt.toISOString(),
    ],
  );
}

export async function listAiAccounts(actor: UserActor): Promise<AiAccountSummary[]> {
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<Row>(`select ${COLUMNS} from crm.ai_accounts where user_id = $1 and workspace_id = $2`, [
      actor.userId,
      actor.workspaceId,
    ]);
    return result.rows;
  });
  return AI_PROVIDERS.map((which) => {
    const row = rows.find((entry) => entry.provider === which);
    const connected = row?.status === "connected";
    return {
      provider: which,
      name: PROVIDER_NAMES[which],
      connected,
      label: connected ? row.label : null,
      lastError: row?.last_error ?? null,
      connectedAt: connected && row ? new Date(row.created_at).toISOString() : null,
    };
  });
}

export async function connectedProviders(actor: UserActor): Promise<AiProvider[]> {
  return (await listAiAccounts(actor)).filter((account) => account.connected).map((account) => account.provider);
}

export async function startChatGptLogin(actor: UserActor, fetchImpl?: typeof fetch) {
  const pending = await startDeviceLogin(fetchImpl);
  await savePending(actor, "chatgpt", pending);
  return { userCode: pending.userCode, url: OPENAI_DEVICE_PAGE, intervalMs: pending.intervalMs };
}

export async function pollChatGptLogin(actor: UserActor, fetchImpl?: typeof fetch) {
  const row = await withActor(actor, (db) => readRow(db, actor, "chatgpt"));
  const pending = readPending(row);
  if (!pending || pending.kind !== "device") return { status: "failed" as const, error: "Start the ChatGPT sign-in again." };
  const result = await pollDeviceLogin(pending, fetchImpl);
  if (result.status === "pending") return { status: "pending" as const };
  if (result.status === "failed") {
    await withActor(actor, (db) =>
      db.query("update crm.ai_accounts set pending = null where user_id = $1 and provider = 'chatgpt'", [actor.userId]),
    );
    return { status: "failed" as const, error: result.error };
  }
  await withActor(actor, (db) => saveTokens(db, actor, "chatgpt", result.tokens));
  return { status: "connected" as const, label: result.tokens.label };
}

export async function disconnectAiAccount(actor: UserActor, which: unknown) {
  const chosen = provider(which);
  await withActor(actor, (db) =>
    db.query("delete from crm.ai_accounts where user_id = $1 and workspace_id = $2 and provider = $3", [
      actor.userId,
      actor.workspaceId,
      chosen,
    ]),
  );
}

export async function aiAccess(
  actor: UserActor,
  which: AiProvider,
  options: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<AiAccess> {
  const outcome = await withActor(actor, async (db): Promise<AiAccess | { error: string }> => {
    const row = await readRow(db, actor, which, true);
    if (!row || row.status !== "connected" || !row.access_token) {
      return { error: `Connect your ${PROVIDER_NAMES[which]} account in Settings › Integrations first.` };
    }
    const expires = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    if (!options.force && expires - Date.now() > REFRESH_EARLY_MS) {
      return { provider: which, token: decryptSecret(row.access_token), accountId: row.account_id };
    }
    try {
      const tokens = await refreshTokens(
        which,
        { refresh: row.refresh_token ? decryptSecret(row.refresh_token) : "", accountId: row.account_id, label: row.label },
        options.fetchImpl,
      );
      await saveTokens(db, actor, which, tokens);
      return { provider: which, token: tokens.access, accountId: tokens.accountId };
    } catch (error) {
      const message = error instanceof OAuthError ? error.message : `Your ${PROVIDER_NAMES[which]} sign-in couldn't be renewed.`;
      await db.query("update crm.ai_accounts set last_error = $2 where user_id = $1 and provider = $3", [actor.userId, message, which]);
      return { error: message };
    }
  });
  if ("error" in outcome) throw new OAuthError(outcome.error);
  return outcome;
}

export async function noteAiError(actor: UserActor, which: AiProvider, message: string | null) {
  await withActor(actor, (db) =>
    db.query("update crm.ai_accounts set last_error = $2 where user_id = $1 and provider = $3", [actor.userId, message, which]),
  ).catch(() => undefined);
}
