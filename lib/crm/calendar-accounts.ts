import type { Db } from "@/lib/db/pool";
import { encryptSecret } from "@/lib/crypto/secret";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { readStored, sameMicrosoftAccount, wrongAccount, type SignedInAccount, type StoredTokens } from "@/lib/crm/inbox";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import {
  consentProblem,
  exchangeAuthorizationCode,
  fetchMicrosoftIdentity,
  grantsCalendar,
  grantsCalendarWrite,
  grantsMailSend,
  MICROSOFT_CONNECT_FAILED,
  microsoftErrorText,
  microsoftProblem,
  MicrosoftTokenError,
  type MicrosoftToken,
} from "@/lib/microsoft/oauth";

export const SAME_AS_PRIMARY = "Already connected as your main account.";

export type CalendarProvider = "microsoft" | "ics";

export type StoredFeed = {
  urlCipher: string;
  host: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: string | null;
};

type StoredAccount = StoredTokens & {
  id: string;
  provider: CalendarProvider;
  email: string | null;
  feed: StoredFeed | null;
  displayName: string | null;
  tenantId: string | null;
  status: "connected" | "disconnected";
  scopeMissing: boolean;
  canSend: boolean;
  calendarWrite: boolean | null;
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
  can_send: boolean;
  calendar_write: boolean | null;
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
    canSend: row.can_send,
    calendarWrite: row.calendar_write,
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
    `select id, provider, email, display_name, tenant_id, status, scope_missing, can_send, calendar_write, refresh_token, access_token,
            access_token_expires_at, last_synced_at, last_attempt_at, last_error,
            feed_url_cipher, feed_host, feed_etag, feed_last_modified, feed_fetched_at
     from crm.calendar_accounts
     where user_id = $1
     order by created_at, email nulls last, id`,
    [actor.userId],
  );
  return result.rows.map(mapAccount);
}

export async function storeAccountToken(db: Db, accountId: string, token: MicrosoftToken) {
  await db.query(
    `update crm.calendar_accounts
     set refresh_token = $2, access_token = $3, access_token_expires_at = $4, calendar_write = coalesce($5::boolean, calendar_write),
         granted_scopes = coalesce($6, granted_scopes)
     where id = $1`,
    [
      accountId,
      encryptSecret(token.refreshToken),
      encryptSecret(token.accessToken),
      token.expiresAt,
      grantsCalendarWrite(token.scope),
      token.scope ? token.scope.replace(/\s+/g, " ").trim().slice(0, 2000) : null,
    ],
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
  return consentProblem(detail) ?? microsoftProblem(detail, MICROSOFT_CONNECT_FAILED);
}

export function calendarConnectFailure(error: unknown) {
  if (error instanceof MicrosoftTokenError) return calendarConnectError(error.detail);
  return consentProblem(error instanceof Error ? error.message : null) ?? microsoftErrorText(error, MICROSOFT_CONNECT_FAILED);
}

export async function connectCalendarAccount(
  actor: UserActor,
  input: { origin: string; code: string; purpose?: "calendar_account" | "send_account"; expected?: string | null },
  fetchImpl: typeof fetch = fetch,
) {
  const purpose = input.purpose ?? "calendar_account";
  let token: MicrosoftToken;
  try {
    token = await exchangeAuthorizationCode(input.origin, input.code, fetchImpl, purpose);
  } catch (error) {
    throw new CrmError("invalid_input", calendarConnectFailure(error), 400);
  }
  let identity: Awaited<ReturnType<typeof fetchMicrosoftIdentity>>;
  try {
    identity = await fetchMicrosoftIdentity(token.accessToken, fetchImpl);
  } catch (error) {
    throw new CrmError("invalid_input", calendarConnectFailure(error), 400);
  }
  const email = canonicalEmail(identity.email);
  if (!email) {
    throw new CrmError("invalid_input", "Couldn't read the account's email. Try again.", 400, { field: "email" });
  }
  const scopeMissing = grantsCalendar(token.scope) === false;
  const canSend = purpose === "send_account" ? grantsMailSend(token.scope) !== false : null;
  const calendarWrite = grantsCalendarWrite(token.scope);
  const expected = canonicalEmail(input.expected ?? "");
  const signedIn: SignedInAccount = { email, id: identity.id, aliases: identity.aliases };
  return withActor(actor, async (db) => {
    const primary = await readStored(db, actor);
    const isPrimary = Boolean(primary && sameMicrosoftAccount(primary, signedIn));
    const known = await readMicrosoftAccounts(db, actor);
    const match = known.find((account) => sameMicrosoftAccount(account, signedIn)) ?? null;
    if (expected) {
      const target = known.find((account) => canonicalEmail(account.email ?? "") === expected) ?? null;
      if (!sameMicrosoftAccount(target ?? { email: expected, microsoftUserId: null }, signedIn)) {
        throw wrongAccount(email, expected, !isPrimary && !match, !target);
      }
    }
    if (isPrimary) {
      throw new CrmError("conflict", SAME_AS_PRIMARY, 409, { field: "email" });
    }
    const values = [
      actor.workspaceId,
      actor.userId,
      email,
      identity.displayName,
      token.tenantId ?? null,
      scopeMissing,
      encryptSecret(token.refreshToken),
      encryptSecret(token.accessToken),
      token.expiresAt,
      canSend,
      calendarWrite,
      identity.id,
      token.scope ? token.scope.replace(/\s+/g, " ").trim().slice(0, 2000) : null,
    ];
    const saved = match
      ? await db.query<{ id: string }>(
          `update crm.calendar_accounts set
             email = $2,
             display_name = coalesce($3, display_name),
             tenant_id = coalesce($4, tenant_id),
             status = 'connected',
             scope_missing = $5,
             refresh_token = $6,
             access_token = $7,
             access_token_expires_at = $8,
             last_attempt_at = null,
             last_error = null,
             can_send = coalesce($9::boolean, can_send),
             calendar_write = coalesce($10::boolean, calendar_write),
             microsoft_user_id = coalesce($11, microsoft_user_id),
             granted_scopes = coalesce($12, granted_scopes)
           where id = $1 and user_id = $13
           returning id`,
          [match.id, ...values.slice(2), actor.userId],
        )
      : await db.query<{ id: string }>(
          `insert into crm.calendar_accounts (
             workspace_id, user_id, provider, email, display_name, tenant_id, status, scope_missing,
             refresh_token, access_token, access_token_expires_at, last_error, can_send, calendar_write,
             microsoft_user_id, granted_scopes
           ) values ($1, $2, 'microsoft', $3, $4, $5, 'connected', $6, $7, $8, $9, null, coalesce($10::boolean, false), $11::boolean, $12, $13)
           on conflict (user_id, provider, email) do update set
             display_name = coalesce(excluded.display_name, crm.calendar_accounts.display_name),
             tenant_id = coalesce(excluded.tenant_id, crm.calendar_accounts.tenant_id),
             status = 'connected',
             scope_missing = excluded.scope_missing,
             refresh_token = excluded.refresh_token,
             access_token = excluded.access_token,
             access_token_expires_at = excluded.access_token_expires_at,
             last_attempt_at = null,
             last_error = null,
             can_send = coalesce($10::boolean, crm.calendar_accounts.can_send),
             calendar_write = coalesce($11::boolean, crm.calendar_accounts.calendar_write),
             microsoft_user_id = coalesce(excluded.microsoft_user_id, crm.calendar_accounts.microsoft_user_id),
             granted_scopes = coalesce(excluded.granted_scopes, crm.calendar_accounts.granted_scopes)
           returning id`,
          values,
        );
    const id = saved.rows[0].id;
    await db.query("update crm.mail_sources set last_error = null where account_id = $1", [id]);
    return { id, email, scopeMissing, canSend };
  });
}

async function readMicrosoftAccounts(db: Db, actor: UserActor) {
  const result = await db.query<{ id: string; email: string | null; microsoft_user_id: string | null }>(
    "select id, email, microsoft_user_id from crm.calendar_accounts where user_id = $1 and provider = 'microsoft'",
    [actor.userId],
  );
  return result.rows.map((row) => ({ id: row.id, email: row.email, microsoftUserId: row.microsoft_user_id }));
}

export async function forgetInviteSender(db: Db, actor: UserActor, address: string | null) {
  const canonical = address ? canonicalEmail(address) : null;
  if (!canonical) return;
  await db.query("update crm.booking_pages set invite_sender = null where user_id = $1 and invite_sender = $2", [actor.userId, canonical]);
  await db.query("delete from crm.invite_sender_choices where user_id = $1 and address = $2", [actor.userId, canonical]);
}

export async function disconnectCalendarAccount(actor: UserActor, accountId: string, confirmed: { email?: string | null } = {}) {
  if (!isUuid(accountId)) throw notFound("calendar account");
  const removed = await withActor(actor, async (db) => {
    const found = await db.query<{ email: string | null; mail: boolean; addresses: string[] }>(
      `select a.email,
         exists (select 1 from crm.mail_sources s where s.account_id = a.id) as mail,
         coalesce((select array_agg(i.email) from crm.send_identities i join crm.mail_sources s on s.id = i.source_id where s.account_id = a.id), '{}') as addresses
       from crm.calendar_accounts a where a.id = $1 and a.user_id = $2`,
      [accountId, actor.userId],
    );
    const account = found.rows[0];
    if (!account) return 0;
    const cascades = account.mail || account.addresses.length > 0;
    const confirmedEmail = canonicalEmail(confirmed.email ?? "");
    const accountEmail = canonicalEmail(account.email ?? "");
    const confirmedThis = Boolean(confirmedEmail) && Boolean(accountEmail) && confirmedEmail === accountEmail;
    if (cascades && !confirmedThis) {
      throw new CrmError("conflict", `Confirm removing ${account.email ?? "this account"}. Its mail and sending addresses will be deleted from Orbit.`, 409);
    }
    const result = await db.query<{ email: string | null }>(
      "delete from crm.calendar_accounts where id = $1 and user_id = $2 returning email",
      [accountId, actor.userId],
    );
    for (const address of [...result.rows.map((row) => row.email), ...account.addresses]) await forgetInviteSender(db, actor, address);
    return result.rowCount ?? 0;
  });
  if (removed === 0) throw notFound("calendar account");
}

export async function hasCalendarAccounts(db: Db, actor: UserActor) {
  const result = await db.query(
    `select 1 from crm.calendar_accounts
     where user_id = $1 and provider = 'microsoft'
       and status = 'connected' and refresh_token is not null
     limit 1`,
    [actor.userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function hasCalendarFeeds(db: Db, actor: UserActor) {
  const result = await db.query(
    `select 1 from crm.calendar_accounts
     where user_id = $1 and provider = 'ics'
       and status = 'connected' and feed_url_cipher is not null
     limit 1`,
    [actor.userId],
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
