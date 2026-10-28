import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { ReadwiseError, validateReadwiseToken } from "@/lib/readwise";

export const READWISE_NOT_CONNECTED = "Readwise Reader isn't connected. Add your access token in Settings, Integrations.";

export type ReadwiseStatus = {
  connected: boolean;
  hint: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  documents: number;
};

export type ReadwiseKeyRow = {
  id: string;
  token_cipher: string;
  token_hint: string | null;
  connected_at: Date;
  last_sync_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  updated_after: Date | null;
  full_sync_at: Date | null;
  scan_cursor: string | null;
  scan_since: Date | null;
  scan_started_at: Date | null;
  scan_full: boolean;
  list_cursor: string | null;
  list_full: boolean;
  list_done: boolean;
};

export async function readReadwiseKey(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<ReadwiseKeyRow>(
      `select id, token_cipher, token_hint, connected_at, last_sync_at, last_error, last_error_at,
         updated_after, full_sync_at, scan_cursor, scan_since, scan_started_at, scan_full, list_cursor, list_full, list_done
       from crm.readwise_keys where workspace_id = $1 and user_id = $2`,
      [actor.workspaceId, actor.userId],
    );
    return result.rows[0] ?? null;
  });
}

export function decryptToken(row: Pick<ReadwiseKeyRow, "token_cipher">) {
  try {
    return decryptSecret(row.token_cipher);
  } catch {
    return null;
  }
}

export async function readwiseToken(actor: UserActor) {
  const row = await readReadwiseKey(actor);
  return row ? decryptToken(row) : null;
}

export async function requireReadwiseToken(actor: UserActor) {
  const token = await readwiseToken(actor);
  if (!token) throw new CrmError("not_connected", READWISE_NOT_CONNECTED, 400);
  return token;
}

export async function saveReadwiseToken(actor: UserActor, token: string, options: { fetchImpl?: typeof fetch } = {}) {
  const trimmed = token.trim();
  if (trimmed.length < 10 || trimmed.length > 500 || /\s/.test(trimmed)) {
    throw new CrmError("invalid_input", "Paste the whole Readwise access token.", 400, { field: "token" });
  }
  let valid: boolean;
  try {
    valid = await validateReadwiseToken(trimmed, options.fetchImpl);
  } catch (error) {
    const reason = error instanceof ReadwiseError ? error.message : "";
    throw new CrmError("invalid_input", `Couldn't reach Readwise to check the token. ${reason}`.trim(), 400, { field: "token" });
  }
  if (!valid) {
    throw new CrmError("invalid_input", "Readwise didn't accept that token. Copy it again from readwise.io/access_token.", 400, { field: "token" });
  }
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.readwise_keys (workspace_id, user_id, token_cipher, token_hint)
       values ($1, $2, $3, $4)
       on conflict (workspace_id, user_id)
       do update set token_cipher = excluded.token_cipher, token_hint = excluded.token_hint, connected_at = now(),
         last_error = null, last_error_at = null, updated_after = null, full_sync_at = null,
         scan_cursor = null, scan_since = null, scan_started_at = null, scan_full = false,
         list_cursor = null, list_full = false, list_done = false`,
      [actor.workspaceId, actor.userId, encryptSecret(trimmed), trimmed.slice(-4)],
    ),
  );
}

export async function removeReadwiseToken(actor: UserActor) {
  await withActor(actor, (db) =>
    db.query("delete from crm.readwise_keys where workspace_id = $1 and user_id = $2", [actor.workspaceId, actor.userId]),
  );
}

export async function readwiseStatus(actor: UserActor): Promise<ReadwiseStatus> {
  return withActor(actor, async (db) => {
    const result = await db.query<{
      token_hint: string | null;
      connected_at: Date;
      last_sync_at: Date | null;
      last_error: string | null;
      last_error_at: Date | null;
      documents: number;
    }>(
      `select k.token_hint, k.connected_at, k.last_sync_at, k.last_error, k.last_error_at,
         (select count(*)::int from crm.readwise_documents d
            join crm.knowledge_items i on i.id = d.knowledge_item_id and i.archived_at is null
            where d.key_id = k.id) as documents
       from crm.readwise_keys k
       where k.workspace_id = $1 and k.user_id = $2`,
      [actor.workspaceId, actor.userId],
    );
    const row = result.rows[0];
    if (!row) {
      return { connected: false, hint: null, connectedAt: null, lastSyncedAt: null, lastError: null, lastErrorAt: null, documents: 0 };
    }
    return {
      connected: true,
      hint: row.token_hint,
      connectedAt: row.connected_at.toISOString(),
      lastSyncedAt: row.last_sync_at?.toISOString() ?? null,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at?.toISOString() ?? null,
      documents: row.documents,
    };
  });
}
