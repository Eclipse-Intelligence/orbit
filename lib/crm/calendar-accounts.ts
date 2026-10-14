import type { Db } from "@/lib/db/pool";
import { encryptSecret } from "@/lib/crypto/secret";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { readStored, type StoredTokens } from "@/lib/crm/inbox";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import {
  consentProblem,
  exchangeAuthorizationCode,
  fetchMicrosoftIdentity,
  grantsCalendar,
  MicrosoftTokenError,
  sanitizeMicrosoftError,
  type MicrosoftToken,
} from "@/lib/microsoft/oauth";

export const SAME_AS_PRIMARY = "That Microsoft account is already connected as your main account.";

export type CalendarProvider = "microsoft" | "ics";

export type StoredFeed = {
  urlCipher: string;
  host: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: string | null;
};

export type StoredAccount = StoredTokens & {
  id: string;
  provider: CalendarProvider;
  email: string | null;
  feed: StoredFeed | null;
  displayName: string | null;
  tenantId: string | null;
  status: "connected" | "disconnected";
  scopeMissing: boolean;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

type AccountRow = {
  id: string;
  provider: CalendarProvider;
  email: string | null;
  feed_url_cipher: string | null;
  feed_host: string | null;
  feed_etag: string | null;
  feed_last_modified: string | null;
  feed_fetched_at: Date | string | null;
  display_name: string | null;
  tenant_id: string | null;
  status: "connected" | "disconnected";
  scope_missing: boolean;
  refresh_token: string | null;
  access_token: string | null;
  access_token_expires_at: Date | string | null;
  last_synced_at: Date | string | null;
  last_attempt_at: Date | string | null;
  last_error: string | null;
};

function iso(value: Date | string | null) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function mapAccount(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    feed:
      row.provider === "ics" && row.feed_url_cipher
        ? {
            urlCipher: row.feed_url_cipher,
            host: row.feed_host ?? "",
            etag: row.feed_etag,
            lastModified: row.feed_last_modified,
            fetchedAt: iso(row.feed_fetched_at),
          }
        : null,
    displayName: row.display_name,
    tenantId: row.tenant_id,
    status: row.status,
    scopeMissing: row.scope_missing,
    lastSyncedAt: iso(row.last_synced_at),
    lastAttemptAt: iso(row.last_attempt_at),
    lastError: row.last_error,
    refreshTokenCipher: row.refresh_token,
    accessTokenCipher: row.access_token,
    accessTokenExpiresAt: iso(row.access_token_expires_at),
  };
}

export async function readAccounts(db: Db, actor: UserActor): Promise<StoredAccount[]> {
  const result = await db.query<AccountRow>(
    `select id, provider, email, display_name, tenant_id, status, scope_missing, refresh_token, access_token,
            access_token_expires_at, last_synced_at, last_attempt_at, last_error,
            feed_url_cipher, feed_host, feed_etag, feed_last_modified, feed_fetched_at
     from crm.calendar_accounts
     where user_id = $1 and workspace_id = $2
     order by created_at, email nulls last, id`,
    [actor.userId, actor.workspaceId],
  );
  return result.rows.map(mapAccount);
}

export async function storeAccountToken(db: Db, accountId: string, token: MicrosoftToken) {
  await db.query(
    `update crm.calendar_accounts
     set refresh_token = $2, access_token = $3, access_token_expires_at = $4
     where id = $1`,
    [accountId, encryptSecret(token.refreshToken), encryptSecret(token.accessToken), token.expiresAt],
  );
}

export async function claimAccount(db: Db, accountId: string, force: boolean, gapMs: number) {
  const result = await db.query(
    `update crm.calendar_accounts
     set last_attempt_at = now()
     where id = $1
       and ($2::boolean
         or last_attempt_at is null
         or last_attempt_at <= now() - make_interval(secs => $3::double precision))
     returning id`,
    [accountId, force, gapMs / 1000],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function finishAccount(
  db: Db,
  accountId: string,
  values: { syncedAt?: string | null; error: string | null; scopeMissing: boolean },
) {
  await db.query(
    `update crm.calendar_accounts
     set last_synced_at = coalesce($2::timestamptz, last_synced_at),
         last_error = $3,
         scope_missing = $4
     where id = $1`,
    [accountId, values.syncedAt ?? null, values.error ? values.error.slice(0, 500) : null, values.scopeMissing],
  );
}

export function calendarConnectError(detail: string | null | undefined) {
  return consentProblem(detail) ?? sanitizeMicrosoftError(detail || "Could not connect the Microsoft account.");
}

export async function connectCalendarAccount(
  actor: UserActor,
  input: { origin: string; code: string },
  fetchImpl: typeof fetch = fetch,
) {
  let token: MicrosoftToken;
  try {
    token = await exchangeAuthorizationCode(input.origin, input.code, fetchImpl, "calendar_account");
  } catch (error) {
    const detail = error instanceof MicrosoftTokenError ? error.detail : error instanceof Error ? error.message : null;
    throw new CrmError("invalid_input", calendarConnectError(detail), 400);
  }
  let identity: { email: string; displayName: string | null };
  try {
    identity = await fetchMicrosoftIdentity(token.accessToken, fetchImpl);
  } catch (error) {
    throw new CrmError(
      "invalid_input",
      calendarConnectError(error instanceof Error ? error.message : null),
      400,
    );
  }
  const email = canonicalEmail(identity.email);
  if (!email) {
    throw new CrmError("invalid_input", "Microsoft did not return an email address.", 400, { field: "email" });
  }
  const scopeMissing = grantsCalendar(token.scope) === false;
  return withActor(actor, async (db) => {
    const primary = await readStored(db, actor);
    if (primary && canonicalEmail(primary.email) === email) {
      throw new CrmError("conflict", SAME_AS_PRIMARY, 409, { field: "email" });
    }
    const saved = await db.query<{ id: string }>(
      `insert into crm.calendar_accounts (
         workspace_id, user_id, provider, email, display_name, tenant_id, status, scope_missing,
         refresh_token, access_token, access_token_expires_at, last_error
       ) values ($1, $2, 'microsoft', $3, $4, $5, 'connected', $6, $7, $8, $9, null)
       on conflict (user_id, provider, email) do update set
         display_name = coalesce(excluded.display_name, crm.calendar_accounts.display_name),
         tenant_id = coalesce(excluded.tenant_id, crm.calendar_accounts.tenant_id),
         status = 'connected',
         scope_missing = excluded.scope_missing,
         refresh_token = excluded.refresh_token,
         access_token = excluded.access_token,
         access_token_expires_at = excluded.access_token_expires_at,
         last_attempt_at = null,
         last_error = null
       returning id`,
      [
        actor.workspaceId,
        actor.userId,
        email,
        identity.displayName,
        token.tenantId ?? null,
        scopeMissing,
        encryptSecret(token.refreshToken),
        encryptSecret(token.accessToken),
        token.expiresAt,
      ],
    );
    return { id: saved.rows[0].id, email, scopeMissing };
  });
}

export async function disconnectCalendarAccount(actor: UserActor, accountId: string) {
  if (!isUuid(accountId)) throw new CrmError("not_found", "That calendar account isn't connected.", 404);
  const removed = await withActor(actor, async (db) => {
    const result = await db.query(
      "delete from crm.calendar_accounts where id = $1 and user_id = $2 and workspace_id = $3",
      [accountId, actor.userId, actor.workspaceId],
    );
    return result.rowCount ?? 0;
  });
  if (removed === 0) throw new CrmError("not_found", "That calendar account isn't connected.", 404);
}

export async function removeAccountsForEmail(actor: UserActor, email: string) {
  const canonical = canonicalEmail(email);
  if (!canonical) return;
  await withActor(actor, async (db) => {
    await db.query(
      "delete from crm.calendar_accounts where user_id = $1 and workspace_id = $2 and provider = 'microsoft' and email = $3",
      [actor.userId, actor.workspaceId, canonical],
    );
  });
}

export async function hasCalendarAccounts(db: Db, actor: UserActor) {
  const result = await db.query(
    `select 1 from crm.calendar_accounts
     where user_id = $1 and workspace_id = $2 and provider = 'microsoft'
       and status = 'connected' and refresh_token is not null
     limit 1`,
    [actor.userId, actor.workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function hasCalendarFeeds(db: Db, actor: UserActor) {
  const result = await db.query(
    `select 1 from crm.calendar_accounts
     where user_id = $1 and workspace_id = $2 and provider = 'ics'
       and status = 'connected' and feed_url_cipher is not null
     limit 1`,
    [actor.userId, actor.workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function insertFeedAccount(
  db: Db,
  actor: UserActor,
  feed: { urlCipher: string; urlHash: string; host: string; label: string | null },
) {
  const result = await db.query<{ id: string }>(
    `insert into crm.calendar_accounts (
       workspace_id, user_id, provider, email, display_name, status, feed_url_cipher, feed_url_hash, feed_host
     ) values ($1, $2, 'ics', null, $3, 'connected', $4, $5, $6)
     on conflict do nothing
     returning id`,
    [actor.workspaceId, actor.userId, feed.label, feed.urlCipher, feed.urlHash, feed.host],
  );
  return result.rows[0]?.id ?? null;
}

export async function storeFeedState(
  db: Db,
  accountId: string,
  state: { etag: string | null; lastModified: string | null; fetchedAt: string },
) {
  await db.query(
    `update crm.calendar_accounts
     set feed_etag = $2, feed_last_modified = $3, feed_fetched_at = $4
     where id = $1 and provider = 'ics'`,
    [accountId, state.etag, state.lastModified, state.fetchedAt],
  );
}
