import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { recallClient } from "@/lib/recall";

export const RECALL_NOT_CONNECTED = "Recall isn't connected. Add your Recall API key in Settings, Integrations.";
export const TAG_PROBE_EVERY_MS = 24 * 60 * 60 * 1000;

export type RecallTagSupport = "names" | "ids" | "unknown";

export type RecallStatus = { connected: boolean; hint: string | null; connectedAt: string | null; tags: RecallTagSupport };

export type RecallKeyRow = {
  id: string;
  key_cipher: string;
  key_hint: string | null;
  connected_at: Date;
  tags_path: string | null;
  tags_checked_at: Date | null;
};

export function tagSupport(row: Pick<RecallKeyRow, "tags_path" | "tags_checked_at">): RecallTagSupport {
  if (row.tags_path) return "names";
  return row.tags_checked_at ? "ids" : "unknown";
}

export function tagProbeDue(row: Pick<RecallKeyRow, "tags_checked_at">, now = Date.now()) {
  return !row.tags_checked_at || now - row.tags_checked_at.getTime() >= TAG_PROBE_EVERY_MS;
}

export async function readRecallKey(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<RecallKeyRow>(
      `select id, key_cipher, key_hint, connected_at, tags_path, tags_checked_at
       from crm.recall_keys where workspace_id = $1 and user_id = $2`,
      [actor.workspaceId, actor.userId],
    );
    return result.rows[0] ?? null;
  });
}

function decryptKey(row: Pick<RecallKeyRow, "key_cipher">) {
  try {
    return decryptSecret(row.key_cipher);
  } catch {
    return null;
  }
}

export async function recallKey(actor: UserActor) {
  const row = await readRecallKey(actor);
  return row ? decryptKey(row) : null;
}

export async function requireRecallKey(actor: UserActor) {
  const row = await readRecallKey(actor);
  const apiKey = row ? decryptKey(row) : null;
  if (!row || !apiKey) throw new CrmError("not_connected", RECALL_NOT_CONNECTED, 400);
  return { row, apiKey };
}

export async function saveTagProbe(actor: UserActor, path: string | null) {
  await withActor(actor, (db) =>
    db.query("update crm.recall_keys set tags_path = $3, tags_checked_at = now() where workspace_id = $1 and user_id = $2", [
      actor.workspaceId,
      actor.userId,
      path,
    ]),
  );
}

export async function saveRecallKey(actor: UserActor, apiKey: string, options: { fetchImpl?: typeof fetch } = {}) {
  const trimmed = apiKey.trim();
  if (trimmed.length < 10 || trimmed.length > 500 || /\s/.test(trimmed)) {
    throw new CrmError("invalid_input", "Paste the whole Recall API key.", 400, { field: "key" });
  }
  if (!trimmed.startsWith("sk_")) {
    throw new CrmError("invalid_input", "Recall API keys start with sk_. Copy the key from Recall, Settings, API & MCP.", 400, { field: "key" });
  }
  const api = recallClient({ apiKey: trimmed, fetchImpl: options.fetchImpl, deadline: Date.now() + 25_000 });
  let valid: boolean;
  try {
    valid = await api.validate();
  } catch (error) {
    const reason = error instanceof CrmError ? error.message : "";
    throw new CrmError("invalid_input", `Couldn't check the key with Recall. ${reason}`.trim(), 400, { field: "key" });
  }
  if (!valid) {
    throw new CrmError(
      "invalid_input",
      "Recall didn't accept that key. Check it hasn't expired, or create a new one in Recall, Settings, API & MCP.",
      400,
      { field: "key" },
    );
  }
  let probe: { path: string | null } | null = null;
  try {
    probe = await api.probeTags();
  } catch {}
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.recall_keys (workspace_id, user_id, key_cipher, key_hint, tags_path, tags_checked_at)
       values ($1, $2, $3, $4, $5::text, case when $6::boolean then now() else null end)
       on conflict (workspace_id, user_id)
       do update set key_cipher = excluded.key_cipher, key_hint = excluded.key_hint, connected_at = now(),
         tags_path = excluded.tags_path, tags_checked_at = excluded.tags_checked_at`,
      [actor.workspaceId, actor.userId, encryptSecret(trimmed), trimmed.slice(-4), probe?.path ?? null, probe !== null],
    ),
  );
}

export async function removeRecallKey(actor: UserActor) {
  await withActor(actor, (db) => db.query("delete from crm.recall_keys where workspace_id = $1 and user_id = $2", [actor.workspaceId, actor.userId]));
}

export async function recallStatus(actor: UserActor): Promise<RecallStatus> {
  const row = await readRecallKey(actor);
  if (!row) return { connected: false, hint: null, connectedAt: null, tags: "unknown" };
  return { connected: true, hint: row.key_hint, connectedAt: row.connected_at.toISOString(), tags: tagSupport(row) };
}
