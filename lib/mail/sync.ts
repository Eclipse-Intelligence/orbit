import { withActor } from "@/lib/crm/context";
import { storeAccountToken } from "@/lib/crm/calendar-accounts";
import { currentToken, readStored, storeToken, type StoredTokens } from "@/lib/crm/inbox";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { randomBytes } from "node:crypto";
import { mailOrigin } from "@/lib/mail/origin";
import {
  classificationUrl,
  createMailSubscription,
  deleteMailSubscription,
  MAILBOX_SUBSCRIPTION_SCOPE,
  renewMailSubscription,
  fetchMicrosoftClassifications,
  fetchMicrosoftDelta,
  fetchMicrosoftMessageFolder,
  disconnectedMessage,
  GraphMailError,
  GraphOutOfTime,
  reconnectProblem,
  initialDeltaUrl,
  listMicrosoftFolders,
} from "@/lib/mail/microsoft";
import { graphReconnect, readReconnectSource, reconnectError } from "@/lib/mail/accounts";
import { trackingIdIn } from "@/lib/mail/html";
import { classifyEmailTones } from "@/lib/crm/email-tone";
import { fileMailOnTimeline } from "@/lib/mail/timeline";
import { notifyNewMail } from "@/lib/mail/notify";
import { routeArrivedMail } from "@/lib/mail/subscriptions";
import { queueMailWorkflowEvents } from "@/lib/workflows/mail-events";
import type { PushSender } from "@/lib/push";
import { MailSyncReset, type MailRole, type ProviderMessage } from "@/lib/mail/types";
import { SYNC_RETRYING } from "@/lib/mail/view";
import { grantsMailWrite, type MicrosoftToken } from "@/lib/microsoft/oauth";
import { announceSharedThreads, ownsShares, shareVisibleRole } from "@/lib/mail/share-live";
import { signalSynced } from "@/lib/sync-signals";

const FOLDER_REFRESH_MS = 6 * 60 * 60 * 1000;
const FOLDER_LIST_RETRY_MS = 15 * 60 * 1000;
const FOLDER_RETRY_FIRST_MS = 60 * 1000;
const FOLDER_RETRY_MAX_MS = 30 * 60 * 1000;
const PRIORITY_RETRY_MAX_MS = 2 * 60 * 1000;
const THROTTLE_MIN_MS = 30 * 1000;
const THROTTLE_DEFAULT_MS = 60 * 1000;
const THROTTLE_MAX_MS = 15 * 60 * 1000;
const PRIORITY_ROLES: MailRole[] = ["inbox", "sent", "drafts", "snoozed"];
const LOCK_GRACE_SECONDS = 60;
const LOOKUP_BATCH = 4;
const SKIPPED_ROLES: MailRole[] = ["outbox"];
const ROLE_ORDER: MailRole[] = ["inbox", "sent", "drafts", "snoozed", "archive", "other", "trash", "junk"];
const DEFAULT_STORAGE_LIMIT_MB = 400;
const MAX_PASSES = 2;
const AGAIN_MIN_MS = 4_000;
const ARRIVAL_SLACK_MS = 5 * 60 * 1000;

type SourceRow = {
  id: string;
  email: string;
  connection_id: string | null;
  account_id: string | null;
  folders_synced_at: Date | string | null;
  snooze_folder_id: string | null;
  graph_subscription_id: string | null;
  graph_subscription_expires_at: Date | string | null;
  graph_subscription_scope: string | null;
  graph_subscription_retry_at: Date | string | null;
  retry_at: Date | string | null;
  last_synced_at: Date | string | null;
  last_full_synced_at: Date | string | null;
  resync_pending: boolean;
  resync_full: boolean;
  backfilling: boolean;
};

const SOURCE_COLUMNS = `s.id, s.email, s.connection_id, s.account_id, s.folders_synced_at, s.snooze_folder_id, s.graph_subscription_id,
  s.graph_subscription_expires_at, s.graph_subscription_scope, s.graph_subscription_retry_at, s.retry_at, s.last_synced_at, s.last_full_synced_at,
  s.resync_pending, s.resync_full,
  exists (select 1 from crm.mail_folders f where f.source_id = s.id and f.sync_state in ('pending', 'backfill')) as backfilling`;

type FolderRow = {
  id: string;
  provider_folder_id: string;
  name: string;
  role: MailRole;
  sync_state: "pending" | "backfill" | "live" | "skipped";
  sync_link: string | null;
  classified_at: Date | string | null;
  last_synced_at: Date | string | null;
  failures: number;
  retry_at: Date | string | null;
  walk_started_at: Date | string | null;
  walk_was_live: boolean;
  classify_link: string | null;
};

type Source = SourceRow & { tokens: StoredTokens };

type Places = { folders: Map<string, string>; skipped: Set<string>; refreshed: boolean; mailScope: boolean | null };

function placesOf(folders: FolderRow[]) {
  return {
    folders: new Map(folders.filter((folder) => folder.sync_state !== "skipped").map((folder) => [folder.provider_folder_id, folder.id])),
    skipped: new Set(folders.filter((folder) => folder.sync_state === "skipped").map((folder) => folder.provider_folder_id)),
  };
}

type Removals = { deleted: string[]; moved: { id: string; folder_id: string }[] };

export type MailSyncReport = {
  sources: number;
  stored: number;
  removed: number;
  moved: number;
  changed: number;
  backfilling: number;
  paused: boolean;
  errors: string[];
  reconnect: string[];
  arrived: string[];
  routed: number;
  filed: number;
  workflowEvents: number;
  busy: string[];
  waiting: string[];
  synced: string[];
  recent: string[];
  passes: number;
  lookups: number;
};

function mailStorageLimitBytes() {
  const raw = Number(process.env.MAIL_STORAGE_LIMIT_MB);
  const megabytes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STORAGE_LIMIT_MB;
  return megabytes * 1024 * 1024;
}

function mailHardStopBytes() {
  const raw = Number(process.env.MAIL_HARD_STOP_MB);
  return Number.isFinite(raw) && raw > 0 ? raw * 1024 * 1024 : mailStorageLimitBytes() * 1.18;
}

async function databaseBytes(db: Db) {
  const result = await db.query<{ size: string }>("select pg_database_size(current_database())::text as size");
  return Number(result.rows[0]?.size ?? 0);
}

async function storageFull(db: Db) {
  return (await databaseBytes(db)) >= mailStorageLimitBytes();
}

export const MAIL_HARD_STOP =
  "Mail sync is paused because the database is nearly full. Upgrade Supabase to Pro and raise MAIL_STORAGE_LIMIT_MB to keep syncing.";
export const SYNC_PAUSED = "Mail sync is paused because storage is full.";

export function syncProblems(report: Pick<MailSyncReport, "paused" | "errors" | "reconnect">) {
  if (report.paused) return [SYNC_PAUSED];
  if (report.reconnect.length) return [...new Set(report.reconnect)];
  return report.errors.length ? [SYNC_RETRYING] : [];
}

async function loadSources(actor: UserActor): Promise<Source[]> {
  return withActor(actor, async (db) => {
    const mailbox = await readStored(db, actor);
    if (mailbox && mailbox.status === "connected" && mailbox.refreshTokenCipher) {
      await db.query(
        `insert into crm.mail_sources (workspace_id, user_id, connection_id, email)
         values ($1, $2, $3, $4)
         on conflict (connection_id) where connection_id is not null do update set email = excluded.email`,
        [actor.workspaceId, actor.userId, mailbox.id, mailbox.email],
      );
    }
    const accounts = await db.query<{
      id: string;
      email: string;
      refresh_token: string | null;
      access_token: string | null;
      access_token_expires_at: Date | string | null;
    }>(
      `select id, email, refresh_token, access_token, access_token_expires_at
       from crm.calendar_accounts
       where user_id = $1 and provider = 'microsoft' and status = 'connected'
         and can_send and email is not null and refresh_token is not null`,
      [actor.userId],
    );
    for (const account of accounts.rows) {
      await db.query(
        `insert into crm.mail_sources (workspace_id, user_id, account_id, email)
         values ($1, $2, $3, $4)
         on conflict (account_id) where account_id is not null do update set email = excluded.email`,
        [actor.workspaceId, actor.userId, account.id, account.email],
      );
    }
    const rows = await db.query<SourceRow>(
      `select ${SOURCE_COLUMNS}
       from crm.mail_sources s where s.user_id = $1
       order by s.last_synced_at nulls first, s.connection_id is null, s.created_at`,
      [actor.userId],
    );
    const sources: Source[] = [];
    for (const row of rows.rows) {
      if (row.connection_id && mailbox && mailbox.id === row.connection_id && mailbox.status === "connected" && mailbox.refreshTokenCipher) {
        sources.push({ ...row, tokens: mailbox });
        continue;
      }
      const account = accounts.rows.find((item) => item.id === row.account_id);
      if (account) {
        sources.push({
          ...row,
          tokens: {
            refreshTokenCipher: account.refresh_token,
            accessTokenCipher: account.access_token,
            accessTokenExpiresAt: account.access_token_expires_at ? new Date(account.access_token_expires_at).toISOString() : null,
          },
        });
      }
    }
    return sources;
  });
}

async function saveToken(db: Db, source: Source, token: MicrosoftToken) {
  if (source.connection_id) {
    await storeToken(db, source.connection_id, token, source.tokens.refreshTokenCipher);
    return;
  }
  if (source.account_id) await storeAccountToken(db, source.account_id, token, source.tokens.refreshTokenCipher);
}

async function loadSource(actor: UserActor, sourceId: string): Promise<Source | null> {
  return withActor(actor, async (db) => {
    const found = await db.query<SourceRow>(
      `select ${SOURCE_COLUMNS}
       from crm.mail_sources s where s.id = $1 and s.user_id = $2`,
      [sourceId, actor.userId],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (row.connection_id) {
      const mailbox = await readStored(db, actor);
      return mailbox && mailbox.id === row.connection_id && mailbox.status === "connected" && mailbox.refreshTokenCipher ? { ...row, tokens: mailbox } : null;
    }
    const account = await db.query<{ refresh_token: string | null; access_token: string | null; access_token_expires_at: Date | string | null }>(
      `select refresh_token, access_token, access_token_expires_at from crm.calendar_accounts
       where id = $1 and user_id = $2 and provider = 'microsoft' and status = 'connected' and can_send and refresh_token is not null`,
      [row.account_id, actor.userId],
    );
    const tokens = account.rows[0];
    if (!tokens) return null;
    return {
      ...row,
      tokens: {
        refreshTokenCipher: tokens.refresh_token,
        accessTokenCipher: tokens.access_token,
        accessTokenExpiresAt: tokens.access_token_expires_at ? new Date(tokens.access_token_expires_at).toISOString() : null,
      },
    };
  });
}

export async function mailSourceToken(actor: UserActor, sourceId: string, fetchImpl: typeof fetch = fetch) {
  const source = await loadSource(actor, sourceId);
  if (!source) {
    const known = await withActor(actor, (db) => readReconnectSource(db, actor, sourceId));
    if (known) throw reconnectError(disconnectedMessage(known.email), known);
    throw new CrmError("not_found", "That mail account isn't in Orbit any more. Choose another one to send from.", 404);
  }
  const token = await currentToken(source.tokens, fetchImpl).catch((error) => {
    throw graphReconnect(error, { id: source.id, email: source.email, main: Boolean(source.connection_id) }) ?? error;
  });
  if (token.expiresAt !== source.tokens.accessTokenExpiresAt) await withActor(actor, (db) => saveToken(db, source, token));
  return token.accessToken;
}

async function claim(actor: UserActor, sourceId: string, until: number) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000)) + LOCK_GRACE_SECONDS;
  return withActor(actor, async (db) => {
    const result = await db.query(
      `update crm.mail_sources set locked_until = now() + make_interval(secs => $2), resync_pending = false
       where id = $1 and (locked_until is null or locked_until < now())
       returning id`,
      [sourceId, seconds],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

async function refreshFolders(actor: UserActor, source: Source, token: string, fetchImpl: typeof fetch, deadline: number) {
  const folders = await listMicrosoftFolders(token, fetchImpl, { deadline });
  return withActor(actor, async (db) => {
    const ids: string[] = [];
    const known = await db.query<{ provider_folder_id: string; name: string; role: string; parent_provider_id: string | null; skipped: boolean }>(
      "select provider_folder_id, name, role, parent_provider_id, sync_state = 'skipped' as skipped from crm.mail_folders where source_id = $1",
      [source.id],
    );
    const before = new Map(known.rows.map((row) => [row.provider_folder_id, row]));
    let changed = false;
    for (const folder of folders) {
      ids.push(folder.providerId);
      const existing = before.get(folder.providerId);
      const role = folder.providerId === source.snooze_folder_id ? "snoozed" : folder.role;
      const skipped = SKIPPED_ROLES.includes(folder.role);
      if (!existing || existing.name !== folder.name || existing.role !== role || existing.parent_provider_id !== folder.parentProviderId || existing.skipped !== skipped) changed = true;
      await db.query(
        `insert into crm.mail_folders (
           workspace_id, user_id, source_id, provider_folder_id, parent_provider_id, name, role,
           total_count, unread_count, sync_state
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (source_id, provider_folder_id) do update set
           parent_provider_id = excluded.parent_provider_id,
           name = excluded.name,
           role = excluded.role,
           total_count = excluded.total_count,
           unread_count = excluded.unread_count,
           sync_state = case
             when excluded.sync_state = 'skipped' then 'skipped'
             when crm.mail_folders.sync_state = 'skipped' then 'pending'
             else crm.mail_folders.sync_state
           end`,
        [
          actor.workspaceId,
          actor.userId,
          source.id,
          folder.providerId,
          folder.parentProviderId,
          folder.name,
          folder.providerId === source.snooze_folder_id ? "snoozed" : folder.role,
          folder.total,
          folder.unread,
          SKIPPED_ROLES.includes(folder.role) ? "skipped" : "pending",
        ],
      );
    }
    const removed = await db.query("delete from crm.mail_folders where source_id = $1 and not (provider_folder_id = any($2::text[]))", [source.id, ids]);
    await db.query("update crm.mail_sources set folders_synced_at = now() where id = $1", [source.id]);
    return changed || (removed.rowCount ?? 0) > 0;
  });
}

function messageRows(messages: ProviderMessage[], ownEmail: string) {
  const own = ownEmail.toLowerCase();
  return messages
    .filter((message) => !message.partial)
    .map((message) => ({
      provider_message_id: message.providerId,
      internet_message_id: message.internetMessageId,
      thread_key: message.threadKey,
      subject: message.subject,
      snippet: message.snippet,
      body_html: message.bodyHtml,
      body_text: message.bodyText,
      body_truncated: message.bodyTruncated,
      from_email: message.from?.address ?? null,
      from_name: message.from?.name ?? null,
      to_recipients: message.to,
      cc_recipients: message.cc,
      bcc_recipients: message.bcc,
      sent_at: message.sentAt,
      received_at: message.receivedAt,
      is_read: message.isRead,
      is_draft: message.isDraft,
      is_flagged: message.isFlagged,
      importance: message.importance,
      has_attachments: message.hasAttachments,
      categories: message.categories,
      web_link: message.webLink,
      tracking_id: message.from?.address === own ? trackingIdIn(message.bodyHtml) : null,
      focused: message.focused,
    }));
}

async function storePage(
  db: Db,
  actor: UserActor,
  source: Source,
  folder: FolderRow,
  messages: ProviderMessage[],
  removals: Removals,
  arrival: { arrivals: boolean; since: Date | null },
  walk: { startedAt: Date | string; finished: boolean } | null,
) {
  const rows = messageRows(messages, source.email);
  const inserted: string[] = [];
  const touched = new Set<string>();
  const quiet = !shareVisibleRole(folder.role);
  let changed = 0;
  const others = new Set<string>();
  let exact = false;
  if (rows.length > 0) {
    const result = await db.query<{ id: string; inserted: boolean; thread_key: string | null; before_thread: string | null; changed: boolean; differs: boolean; before_folder: string | null }>(
      `with before as (
         select m.provider_message_id, m.folder_id, m.is_draft, m.thread_key, m.is_read, m.is_flagged, m.has_attachments, m.subject, m.snippet,
           m.from_email, m.from_name, m.received_at, m.sent_at, m.focused, m.tracking_id
         from crm.mail_messages m
         where m.source_id = $3 and m.provider_message_id in (select x.provider_message_id from jsonb_to_recordset($5::jsonb) as x(provider_message_id text))
       ),
       stored as (
       insert into crm.mail_messages (
         workspace_id, user_id, source_id, folder_id, arrival_pending, provider_message_id, internet_message_id, thread_key, subject, snippet,
         body_html, body_text, body_truncated, from_email, from_name, to_recipients, cc_recipients, bcc_recipients,
         sent_at, received_at, is_read, is_draft, is_flagged, importance, has_attachments, categories, web_link, tracking_id, focused
       )
       select $1, $2, $3, $4, coalesce($6 and ($7::timestamptz is null or x.received_at > $7::timestamptz), false), x.provider_message_id, x.internet_message_id, x.thread_key, x.subject, x.snippet,
         x.body_html, x.body_text, coalesce(x.body_truncated, false), x.from_email, x.from_name,
         coalesce(x.to_recipients, '[]'), coalesce(x.cc_recipients, '[]'), coalesce(x.bcc_recipients, '[]'),
         x.sent_at, x.received_at, coalesce(x.is_read, false), coalesce(x.is_draft, false), coalesce(x.is_flagged, false),
         x.importance, coalesce(x.has_attachments, false), coalesce(x.categories, '{}'), x.web_link, x.tracking_id, x.focused
       from jsonb_to_recordset($5::jsonb) as x(
         provider_message_id text, internet_message_id text, thread_key text, subject text, snippet text,
         body_html text, body_text text, body_truncated boolean, from_email text, from_name text,
         to_recipients jsonb, cc_recipients jsonb, bcc_recipients jsonb, sent_at timestamptz, received_at timestamptz,
         is_read boolean, is_draft boolean, is_flagged boolean, importance text, has_attachments boolean,
         categories text[], web_link text, tracking_id uuid, focused boolean
       )
       on conflict (source_id, provider_message_id) do update set
         folder_id = excluded.folder_id,
         internet_message_id = excluded.internet_message_id,
         thread_key = excluded.thread_key,
         subject = excluded.subject,
         snippet = excluded.snippet,
         body_html = excluded.body_html,
         body_text = excluded.body_text,
         body_truncated = excluded.body_truncated,
         from_email = excluded.from_email,
         from_name = excluded.from_name,
         to_recipients = excluded.to_recipients,
         cc_recipients = excluded.cc_recipients,
         bcc_recipients = excluded.bcc_recipients,
         sent_at = excluded.sent_at,
         received_at = excluded.received_at,
         is_read = excluded.is_read,
         is_draft = excluded.is_draft,
         is_flagged = excluded.is_flagged,
         importance = excluded.importance,
         has_attachments = excluded.has_attachments,
         categories = excluded.categories,
         web_link = excluded.web_link,
         tracking_id = excluded.tracking_id,
         focused = coalesce(excluded.focused, crm.mail_messages.focused)
       where (
         crm.mail_messages.folder_id, crm.mail_messages.internet_message_id, crm.mail_messages.thread_key, crm.mail_messages.subject, crm.mail_messages.snippet,
         crm.mail_messages.body_html, crm.mail_messages.body_text, crm.mail_messages.body_truncated, crm.mail_messages.from_email, crm.mail_messages.from_name,
         crm.mail_messages.to_recipients, crm.mail_messages.cc_recipients, crm.mail_messages.bcc_recipients, crm.mail_messages.sent_at, crm.mail_messages.received_at,
         crm.mail_messages.is_read, crm.mail_messages.is_draft, crm.mail_messages.is_flagged, crm.mail_messages.importance, crm.mail_messages.has_attachments,
         crm.mail_messages.categories, crm.mail_messages.web_link, crm.mail_messages.tracking_id, crm.mail_messages.focused
       ) is distinct from (
         excluded.folder_id, excluded.internet_message_id, excluded.thread_key, excluded.subject, excluded.snippet,
         excluded.body_html, excluded.body_text, excluded.body_truncated, excluded.from_email, excluded.from_name,
         excluded.to_recipients, excluded.cc_recipients, excluded.bcc_recipients, excluded.sent_at, excluded.received_at,
         excluded.is_read, excluded.is_draft, excluded.is_flagged, excluded.importance, excluded.has_attachments,
         excluded.categories, excluded.web_link, excluded.tracking_id, coalesce(excluded.focused, crm.mail_messages.focused)
       )
       returning id, provider_message_id, folder_id, is_draft, thread_key, is_read, is_flagged, has_attachments, subject, snippet,
         from_email, from_name, received_at, sent_at, focused, tracking_id, (xmax = 0) as inserted
       )
       select s.id, s.inserted, s.thread_key, b.thread_key as before_thread,
         b.folder_id as before_folder,
         (b.provider_message_id is not null and (b.folder_id <> s.folder_id or b.is_draft <> s.is_draft or b.thread_key is distinct from s.thread_key)) as changed,
         (b.provider_message_id is not null and (b.folder_id, b.thread_key, b.is_draft, b.is_read, b.is_flagged, b.has_attachments, b.subject, b.snippet, b.from_email, b.from_name, b.received_at, b.sent_at, b.focused, b.tracking_id)
           is distinct from (s.folder_id, s.thread_key, s.is_draft, s.is_read, s.is_flagged, s.has_attachments, s.subject, s.snippet, s.from_email, s.from_name, s.received_at, s.sent_at, s.focused, s.tracking_id)) as differs
       from stored s left join before b on b.provider_message_id = s.provider_message_id`,
      [actor.workspaceId, actor.userId, source.id, folder.id, JSON.stringify(rows), arrival.arrivals, arrival.since],
    );
    for (const row of result.rows) {
      if (row.inserted) inserted.push(row.id);
      if (row.inserted || row.differs) changed += 1;
      if (!row.inserted && row.differs) exact = true;
      if (row.before_folder && row.before_folder !== folder.id) others.add(row.before_folder);
      if (row.inserted && quiet) continue;
      if (!row.inserted && !row.changed) continue;
      if (row.thread_key) touched.add(row.thread_key);
      if (row.before_thread) touched.add(row.before_thread);
    }
  }
  for (const message of messages.filter((item) => item.partial)) {
    const partial = await db.query(
      `update crm.mail_messages set is_read = $3, is_flagged = $4, focused = coalesce($5, focused)
       where source_id = $1 and provider_message_id = $2 and (is_read, is_flagged, focused) is distinct from ($3, $4, coalesce($5, focused))`,
      [source.id, message.providerId, message.isRead, message.isFlagged, message.focused],
    );
    changed += partial.rowCount ?? 0;
  }
  if (walk && messages.length > 0) {
    await db.query(
      `update crm.mail_messages set walk_seen_at = $3::timestamptz
       where source_id = $1 and provider_message_id = any($2::text[]) and walk_seen_at is distinct from $3::timestamptz`,
      [source.id, messages.map((message) => message.providerId), walk.startedAt],
    );
  }
  if (removals.moved.length > 0) {
    const moved = await db.query<{ thread_key: string | null }>(
      `update crm.mail_messages m set folder_id = x.folder_id
       from jsonb_to_recordset($3::jsonb) as x(id text, folder_id uuid)
       where m.source_id = $1 and m.folder_id = $2 and m.provider_message_id = x.id
       returning m.thread_key`,
      [source.id, folder.id, JSON.stringify(removals.moved)],
    );
    for (const row of moved.rows) if (row.thread_key) touched.add(row.thread_key);
    changed += moved.rows.length;
    if (moved.rows.length > 0) {
      exact = true;
      for (const item of removals.moved) others.add(item.folder_id);
    }
  }
  if (removals.deleted.length > 0) {
    const deleted = await db.query<{ thread_key: string | null }>(
      "delete from crm.mail_messages where source_id = $1 and folder_id = $2 and provider_message_id = any($3::text[]) returning thread_key",
      [source.id, folder.id, removals.deleted],
    );
    if (!quiet) for (const row of deleted.rows) if (row.thread_key) touched.add(row.thread_key);
    changed += deleted.rows.length;
    if (deleted.rows.length > 0) exact = true;
  }
  if (walk?.finished) {
    const vanished = await db.query<{ thread_key: string | null }>(
      `delete from crm.mail_messages
       where source_id = $1 and folder_id = $2 and (walk_seen_at is null or walk_seen_at < $3::timestamptz) and updated_at < $3::timestamptz
       returning thread_key`,
      [source.id, folder.id, walk.startedAt],
    );
    if (!quiet) for (const row of vanished.rows) if (row.thread_key) touched.add(row.thread_key);
    changed += vanished.rows.length;
    if (vanished.rows.length > 0) exact = true;
  }
  others.delete(folder.id);
  if (others.size > 0) await recountFolders(db, [...others]);
  return { stored: rows.length, inserted, touched: [...touched], changed, exact, added: inserted.length };
}

export async function recountFolders(db: Db, folderIds: string[]) {
  if (folderIds.length === 0) return;
  await db.query(
    "update crm.mail_folders f set synced_count = (select count(*)::int from crm.mail_messages m where m.folder_id = f.id) where f.id = any($1::uuid[])",
    [folderIds],
  );
}

async function folderPlaces(actor: UserActor, sourceId: string) {
  return placesOf(await loadFolders(actor, sourceId));
}

async function placeRemoved(
  actor: UserActor,
  source: Source,
  folder: FolderRow,
  removed: string[],
  token: string,
  places: Places,
  fetchImpl: typeof fetch,
  deadline: number,
): Promise<Removals | null> {
  if (removed.length === 0) return { deleted: [], moved: [] };
  const held = await withActor(actor, async (db) => {
    const result = await db.query<{ provider_message_id: string }>(
      "select provider_message_id from crm.mail_messages where source_id = $1 and folder_id = $2 and provider_message_id = any($3::text[])",
      [source.id, folder.id, removed],
    );
    return result.rows.map((row) => row.provider_message_id);
  });
  const parents = new Map<string, string | null>();
  for (let index = 0; index < held.length; index += LOOKUP_BATCH) {
    if (Date.now() >= deadline) return null;
    const batch = held.slice(index, index + LOOKUP_BATCH);
    const found = await Promise.all(batch.map((id) => fetchMicrosoftMessageFolder(token, id, fetchImpl, { deadline, mailScope: places.mailScope })));
    batch.forEach((id, position) => parents.set(id, found[position]));
  }
  const unknown = [...parents.values()].some((parent) => parent && !places.folders.has(parent) && !places.skipped.has(parent));
  if (unknown && !places.refreshed) {
    places.refreshed = true;
    await refreshFolders(actor, source, token, fetchImpl, deadline);
    Object.assign(places, await folderPlaces(actor, source.id));
  }
  const removals: Removals = { deleted: [], moved: [] };
  for (const [id, parent] of parents) {
    const target = parent ? places.folders.get(parent) : undefined;
    if (target === folder.id) continue;
    if (target) removals.moved.push({ id, folder_id: target });
    else removals.deleted.push(id);
  }
  return removals;
}

function arrivalRule(folder: FolderRow): { arrivals: boolean; since: Date | null } {
  if (folder.role !== "inbox") return { arrivals: false, since: null };
  if (folder.sync_state === "live") return { arrivals: true, since: null };
  if (folder.walk_was_live && folder.last_synced_at) return { arrivals: true, since: new Date(new Date(folder.last_synced_at).getTime() - ARRIVAL_SLACK_MS) };
  return { arrivals: false, since: null };
}

function syncedAt(folder: FolderRow) {
  return folder.last_synced_at ? new Date(folder.last_synced_at).getTime() : 0;
}

function folderOrder(folders: FolderRow[]) {
  const rank = (folder: FolderRow) => ROLE_ORDER.indexOf(folder.role) === -1 ? ROLE_ORDER.length : ROLE_ORDER.indexOf(folder.role);
  const priority = (folder: FolderRow) => {
    const index = PRIORITY_ROLES.indexOf(folder.role);
    return index === -1 ? PRIORITY_ROLES.length : index;
  };
  const live = folders
    .filter((folder) => folder.sync_state === "live")
    .sort((a, b) => priority(a) - priority(b) || syncedAt(a) - syncedAt(b) || rank(a) - rank(b));
  const backfill = folders
    .filter((folder) => folder.sync_state === "pending" || folder.sync_state === "backfill")
    .sort((a, b) => (a.sync_state === b.sync_state ? rank(a) - rank(b) : a.sync_state === "backfill" ? -1 : 1));
  return { live, backfill };
}

async function syncFolder(
  actor: UserActor,
  source: Source,
  folder: FolderRow,
  token: string,
  options: { deadline: number; fetchImpl: typeof fetch; guard: boolean; places: Places; shares: boolean },
  report: MailSyncReport,
) {
  let link = folder.sync_link ?? initialDeltaUrl(folder.provider_folder_id);
  const live = folder.sync_state === "live";
  const arrival = arrivalRule(folder);
  while (Date.now() < options.deadline) {
    let page;
    try {
      page = await fetchMicrosoftDelta(link, token, options.fetchImpl, { deadline: options.deadline });
    } catch (error) {
      if (error instanceof MailSyncReset) {
        await withActor(actor, (db) =>
          db.query(
            `update crm.mail_folders set sync_link = null, sync_state = 'pending', last_error = null, failures = 0, retry_at = null,
               walk_started_at = now(), walk_was_live = walk_was_live or sync_state = 'live', classify_link = null
             where id = $1`,
            [folder.id],
          ),
        );
        return;
      }
      throw error;
    }
    const removals = await placeRemoved(actor, source, folder, page.removed, token, options.places, options.fetchImpl, options.deadline);
    if (!removals) break;
    let touched: string[] = [];
    const full = await withActor(actor, async (db) => {
      const walk = folder.walk_started_at ? { startedAt: folder.walk_started_at, finished: Boolean(page.deltaLink) } : null;
      const stored = await storePage(db, actor, source, folder, page.messages, removals, arrival, walk);
      touched = stored.touched;
      report.stored += stored.stored;
      report.removed += removals.deleted.length;
      report.moved += removals.moved.length;
      report.changed += stored.changed;
      const next = page.deltaLink ?? page.nextLink;
      const state = live || page.deltaLink ? "live" : "backfill";
      const walkEnds = Boolean(page.deltaLink) || !page.nextLink;
      await db.query(
        `update crm.mail_folders set
           sync_link = $2,
           sync_state = $3,
           synced_count = case
             when $5::boolean then (select count(*)::int from crm.mail_messages where folder_id = $1)
             else synced_count + $6::int
           end,
           last_synced_at = case when $4 then now() else last_synced_at end,
           classified_at = case when $4 and not $7::boolean and classified_at is null then now() else classified_at end,
           walk_started_at = case when $4 then null else walk_started_at end,
           walk_was_live = case when $4 then false else walk_was_live end,
           last_error = null,
           failures = 0,
           retry_at = null
         where id = $1`,
        [folder.id, next, state, Boolean(page.deltaLink), stored.exact || (walkEnds && stored.changed > 0), stored.added, live],
      );
      return options.guard && state === "backfill" ? storageFull(db) : false;
    });
    if (options.shares && touched.length > 0) {
      await announceSharedThreads(actor.userId, source.id, touched).catch((error) => console.error("Couldn't check shared threads after sync", error instanceof Error ? error.name : "unknown"));
    }
    if (page.deltaLink) return;
    if (!page.nextLink) return;
    link = page.nextLink;
    if (full) {
      report.paused = true;
      await withActor(actor, (db) =>
        db.query("update crm.mail_folders set last_error = $2 where id = $1", [
          folder.id,
          "Paused: the database reached its mail storage limit (MAIL_STORAGE_LIMIT_MB).",
        ]),
      );
      return;
    }
  }
  report.backfilling += 1;
}

const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

const SUBSCRIBE_RETRY_MS = 6 * 60 * 60 * 1000;

export function subscriptionRefused(error: unknown) {
  return error instanceof GraphMailError && (error.status === 400 || error.status === 403) && !/validat/i.test(`${error.message} ${error.code}`);
}

async function renewLegacy(actor: UserActor, source: Source, id: string, token: string, fetchImpl: typeof fetch, deadline: number) {
  try {
    const expiresAt = await renewMailSubscription(token, id, fetchImpl, { deadline });
    await withActor(actor, (db) =>
      db.query("update crm.mail_sources set graph_subscription_expires_at = $3 where id = $1 and graph_subscription_id = $2", [source.id, id, expiresAt]),
    );
  } catch (error) {
    if (!(error instanceof GraphMailError && error.status === 404)) throw error;
    await withActor(actor, (db) =>
      db.query("update crm.mail_sources set graph_subscription_id = null, graph_subscription_expires_at = null where id = $1 and graph_subscription_id = $2", [source.id, id]),
    );
  }
}

async function keepSubscription(actor: UserActor, source: Source, token: string, fetchImpl: typeof fetch, deadline: number) {
  const origin = mailOrigin();
  if (!origin) return;
  const current = source.graph_subscription_scope === MAILBOX_SUBSCRIPTION_SCOPE;
  const expires = source.graph_subscription_expires_at ? new Date(source.graph_subscription_expires_at).getTime() : 0;
  const due = expires - Date.now() <= RENEW_BEFORE_MS;
  if (source.graph_subscription_id && current && !due) return;
  let gone = false;
  if (source.graph_subscription_id && current) {
    try {
      const expiresAt = await renewMailSubscription(token, source.graph_subscription_id, fetchImpl, { deadline });
      await withActor(actor, (db) =>
        db.query("update crm.mail_sources set graph_subscription_expires_at = $3 where id = $1 and graph_subscription_id = $2", [source.id, source.graph_subscription_id, expiresAt]),
      );
      return;
    } catch (error) {
      if (!(error instanceof GraphMailError && error.status === 404)) throw error;
      gone = true;
    }
  }
  const legacy = source.graph_subscription_id && !current ? source.graph_subscription_id : null;
  if (waitingUntil(source.graph_subscription_retry_at)) {
    if (legacy && due) await renewLegacy(actor, source, legacy, token, fetchImpl, deadline);
    return;
  }
  const clientState = randomBytes(24).toString("hex");
  let created: { id: string; expiresAt: string };
  try {
    created = await createMailSubscription(token, { notificationUrl: `${origin}/api/microsoft/mail-webhook`, clientState }, fetchImpl, { deadline });
  } catch (error) {
    if (!subscriptionRefused(error)) throw error;
    const message = `Microsoft refused mail notifications: ${error instanceof Error ? error.message : "unknown"}`.slice(0, 480);
    console.error("Mail subscription refused", source.email, message);
    await withActor(actor, (db) =>
      db.query("update crm.mail_sources set graph_subscription_error = $2, graph_subscription_retry_at = now() + make_interval(secs => $3) where id = $1", [
        source.id,
        message,
        SUBSCRIBE_RETRY_MS / 1000,
      ]),
    );
    if (legacy && due) await renewLegacy(actor, source, legacy, token, fetchImpl, deadline);
    return;
  }
  const stored = await withActor(actor, (db) =>
    db.query(
      `update crm.mail_sources set graph_subscription_id = $2, graph_subscription_expires_at = $3, graph_client_state = $4, graph_subscription_scope = $5,
         graph_subscription_error = null, graph_subscription_retry_at = null
       where id = $1 and graph_subscription_id is not distinct from $6
       returning id`,
      [source.id, created.id, created.expiresAt, clientState, MAILBOX_SUBSCRIPTION_SCOPE, source.graph_subscription_id],
    ),
  );
  if ((stored.rowCount ?? 0) === 0) {
    await deleteMailSubscription(token, created.id, fetchImpl, { deadline }).catch((error) =>
      console.error("Couldn't remove a spare mail subscription", error instanceof Error ? error.message : error),
    );
    return;
  }
  if (source.graph_subscription_id && !gone) {
    await deleteMailSubscription(token, source.graph_subscription_id, fetchImpl, { deadline }).catch((error) =>
      console.error("Couldn't remove the old mail subscription", error instanceof Error ? error.message : error),
    );
  }
}

async function classifyFolder(actor: UserActor, source: Source, folder: FolderRow, token: string, deadline: number, fetchImpl: typeof fetch) {
  let url: string | null = folder.classify_link ?? classificationUrl(folder.provider_folder_id);
  while (url && Date.now() < deadline) {
    const page = await fetchMicrosoftClassifications(url, token, fetchImpl, { deadline });
    await withActor(actor, async (db) => {
      if (page.items.length) {
        await db.query(
          `update crm.mail_messages m set focused = x.focused
           from jsonb_to_recordset($2::jsonb) as x(id text, focused boolean)
           where m.source_id = $1 and m.provider_message_id = x.id`,
          [source.id, JSON.stringify(page.items)],
        );
      }
      await db.query(
        `update crm.mail_folders set classify_link = $2, classified_at = case when $2::text is null then now() else classified_at end where id = $1`,
        [folder.id, page.next],
      );
    });
    url = page.next;
  }
}

function throttled(error: unknown) {
  return error instanceof GraphMailError && (error.status === 429 || error.retryAfterMs !== null);
}

function throttleUntil(error: unknown) {
  const asked = error instanceof GraphMailError && error.retryAfterMs !== null ? error.retryAfterMs : THROTTLE_DEFAULT_MS;
  return new Date(Date.now() + Math.min(THROTTLE_MAX_MS, Math.max(THROTTLE_MIN_MS, asked)));
}

function waitingUntil(value: Date | string | null) {
  return value !== null && new Date(value).getTime() > Date.now();
}

function problemText(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 480) : "Mail sync failed.";
}

async function sourceProblem(actor: UserActor, source: Source, error: unknown) {
  const scopes =
    error instanceof GraphMailError && error.status === 403 ? (await withActor(actor, (db) => readReconnectSource(db, actor, source.id)).catch(() => null))?.scopes : null;
  return reconnectProblem(error, source.email, grantsMailWrite(scopes));
}

async function stopsSource(actor: UserActor, source: Source, error: unknown) {
  if (throttled(error)) return true;
  if (error instanceof GraphMailError && error.status === 401) return true;
  return (await sourceProblem(actor, source, error)) !== null;
}

export function folderRetryAt(failures: number, role: MailRole, now = Date.now()) {
  if (failures < 2) return null;
  const longest = PRIORITY_ROLES.includes(role) ? PRIORITY_RETRY_MAX_MS : FOLDER_RETRY_MAX_MS;
  return new Date(now + Math.min(longest, FOLDER_RETRY_FIRST_MS * 2 ** (failures - 2)));
}

async function folderFailed(actor: UserActor, source: Source, folder: FolderRow, error: unknown, report: MailSyncReport) {
  const failures = folder.failures + 1;
  const message = problemText(error);
  console.error(
    "Mail folder sync failed",
    source.email,
    folder.role,
    folder.name,
    error instanceof GraphMailError ? `${error.status} ${error.code}`.trim() : error instanceof Error ? error.name : "unknown",
    message,
  );
  report.errors.push(`${source.email}: ${message}`);
  await withActor(actor, (db) =>
    db.query("update crm.mail_folders set failures = $2, retry_at = $3, last_error = $4 where id = $1", [folder.id, failures, folderRetryAt(failures, folder.role), message]),
  ).catch((failure) => console.error("Couldn't record a mail folder failure", failure instanceof Error ? failure.message : failure));
}

type FolderRun = { deadline: number; fetchImpl: typeof fetch; guard: boolean; places: Places; shares: boolean };

async function runFolder(actor: UserActor, source: Source, folder: FolderRow, token: string, options: FolderRun, report: MailSyncReport) {
  try {
    await syncFolder(actor, source, folder, token, options, report);
    return true;
  } catch (error) {
    if (error instanceof GraphOutOfTime) {
      report.backfilling += 1;
      return true;
    }
    if (await stopsSource(actor, source, error)) throw error;
    await folderFailed(actor, source, folder, error, report);
    return false;
  }
}

async function refreshFoldersSafely(actor: UserActor, source: Source, token: string, fetchImpl: typeof fetch, deadline: number, report: MailSyncReport) {
  try {
    if (await refreshFolders(actor, source, token, fetchImpl, deadline)) report.changed += 1;
    return true;
  } catch (error) {
    if (error instanceof GraphOutOfTime || !source.folders_synced_at || (await stopsSource(actor, source, error))) throw error;
    const message = problemText(error);
    console.error("Listing mail folders failed", source.email, message);
    report.errors.push(`${source.email}: ${message}`);
    await withActor(actor, (db) =>
      db.query("update crm.mail_sources set folders_synced_at = now() - make_interval(secs => $2) where id = $1", [
        source.id,
        (FOLDER_REFRESH_MS - FOLDER_LIST_RETRY_MS) / 1000,
      ]),
    );
    return false;
  }
}

async function classifyFolderSafely(actor: UserActor, source: Source, folder: FolderRow, token: string, deadline: number, fetchImpl: typeof fetch) {
  try {
    await classifyFolder(actor, source, folder, token, deadline, fetchImpl);
  } catch (error) {
    if (error instanceof GraphOutOfTime) return;
    console.error("Sorting Focused mail failed", source.email, problemText(error));
  }
}

async function changedAgain(actor: UserActor, sourceId: string, until: number) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000)) + LOCK_GRACE_SECONDS;
  const result = await withActor(actor, (db) =>
    db.query(
      `update crm.mail_sources set resync_pending = false, locked_until = now() + make_interval(secs => $2)
       where id = $1 and resync_pending
       returning id`,
      [sourceId, seconds],
    ),
  );
  return (result.rowCount ?? 0) > 0;
}

async function readMailVersion(actor: UserActor) {
  const result = await withActor(actor, (db) =>
    db.query<{ version: string }>("select version::text as version from crm.mail_versions where user_id = $1", [actor.userId]),
  ).catch(() => null);
  return result?.rows[0]?.version ?? "0";
}

function syncedWithin(value: Date | string | null, ms: number) {
  return value !== null && Date.now() - new Date(value).getTime() < ms;
}

async function loadFolders(actor: UserActor, sourceId: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<FolderRow>(
      `select id, provider_folder_id, name, role, sync_state, sync_link, classified_at, last_synced_at, failures, retry_at, walk_started_at, walk_was_live, classify_link
       from crm.mail_folders where source_id = $1`,
      [sourceId],
    );
    return result.rows;
  });
}

async function remarkFolders(actor: UserActor, sourceId: string, folderIds: string[]) {
  await withActor(actor, (db) =>
    db.query("update crm.mail_folders set resync_pending = true where source_id = $1 and id = any($2::uuid[])", [sourceId, folderIds]),
  ).catch((error) => console.error("Couldn't mark a failed mail folder", error instanceof Error ? error.message : error));
}

async function changePending(actor: UserActor, sourceId: string) {
  const result = await withActor(actor, (db) => db.query<{ pending: boolean }>("select resync_pending as pending from crm.mail_sources where id = $1", [sourceId]));
  return result.rows[0]?.pending === true;
}

async function releaseSource(
  actor: UserActor,
  sourceId: string,
  lastError: string | null,
  retryAt: Date | null,
  { unfinished = false, redo = false, walkedAll = false }: { unfinished?: boolean; redo?: boolean; walkedAll?: boolean } = {},
) {
  try {
    await withActor(actor, (db) =>
      db.query(
        `update crm.mail_sources set locked_until = null,
           last_synced_at = case when $2::text is null then now() else last_synced_at end,
           last_error = $2,
           retry_at = $3,
           resync_pending = resync_pending or $4,
           resync_full = resync_full or $5,
           last_full_synced_at = case when $2::text is null and $6 then now() else last_full_synced_at end
         where id = $1`,
        [sourceId, lastError, retryAt, unfinished, unfinished || redo, walkedAll],
      ),
    );
  } catch (error) {
    console.error("Couldn't release the mail sync lock", error instanceof Error ? error.message : error);
  }
}

async function claimArrivals(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(
      "update crm.mail_messages set arrival_pending = false where user_id = $1 and arrival_pending returning id",
      [actor.userId],
    );
    return result.rows.map((row) => row.id);
  });
}

const LOOKUP_LIMIT = 20;
export const ECHO_WINDOW_MS = 2 * 60_000;

type Work = { full: boolean; lookups: string[]; folderIds: string[] };

export type MailChange = { sourceId: string; full: boolean; folderIds: string[]; lookups: string[] };

async function takeWork(actor: UserActor, sourceId: string): Promise<Work> {
  return withActor(actor, async (db) => {
    const source = await db.query<{ resync_full: boolean; resync_lookups: string[] }>(
      `update crm.mail_sources s set resync_full = false, resync_lookups = '{}'
       from (select id, resync_full, resync_lookups from crm.mail_sources where id = $1 for update) o
       where s.id = o.id
       returning o.resync_full, o.resync_lookups`,
      [sourceId],
    );
    const folders = await db.query<{ id: string }>(
      "update crm.mail_folders set resync_pending = false where source_id = $1 and resync_pending returning id",
      [sourceId],
    );
    return {
      full: source.rows[0]?.resync_full ?? false,
      lookups: source.rows[0]?.resync_lookups ?? [],
      folderIds: folders.rows.map((row) => row.id),
    };
  });
}

async function targetFolders(
  actor: UserActor,
  source: Source,
  folders: FolderRow[],
  work: Work,
  token: string,
  places: Places,
  limit: { fetchImpl: typeof fetch; deadline: number },
  report: MailSyncReport,
): Promise<{ walk: FolderRow[]; all: boolean }> {
  const live = folderOrder(folders).live;
  if (work.full || work.lookups.length > LOOKUP_LIMIT) return { walk: live, all: true };
  let known = folders;
  const skipped = () => new Set(known.filter((folder) => folder.sync_state === "skipped").map((folder) => folder.provider_folder_id));
  const wanted = new Set(work.folderIds);
  for (const id of work.lookups) {
    report.lookups += 1;
    let parent: string | null;
    try {
      parent = await fetchMicrosoftMessageFolder(token, id, limit.fetchImpl, { deadline: limit.deadline, mailScope: places.mailScope });
    } catch (error) {
      if (error instanceof GraphOutOfTime || (await stopsSource(actor, source, error))) throw error;
      return { walk: live, all: true };
    }
    if (!parent || skipped().has(parent)) continue;
    if (!places.folders.has(parent) && !places.refreshed) {
      places.refreshed = true;
      try {
        await refreshFolders(actor, source, token, limit.fetchImpl, limit.deadline);
      } catch (error) {
        if (error instanceof GraphOutOfTime || (await stopsSource(actor, source, error))) throw error;
        return { walk: live, all: true };
      }
      known = await loadFolders(actor, source.id);
      Object.assign(places, placesOf(known));
    }
    const folder = places.folders.get(parent);
    if (folder) wanted.add(folder);
  }
  const ordered = [...folderOrder(known).live, ...known.filter((folder) => folder.sync_state === "pending" || folder.sync_state === "backfill")];
  return { walk: ordered.filter((folder) => wanted.has(folder.id)), all: false };
}

export async function noteMailChanges(actor: UserActor, changes: MailChange[]) {
  if (changes.length === 0) return;
  await withActor(actor, async (db) => {
    for (const change of changes) {
      if (change.folderIds.length > 0) {
        await db.query("update crm.mail_folders set resync_pending = true where source_id = $1 and user_id = $2 and id = any($3::uuid[])", [
          change.sourceId,
          actor.userId,
          change.folderIds,
        ]);
      }
      await db.query(
        `update crm.mail_sources set
           resync_pending = true,
           resync_full = resync_full or $3 or cardinality(resync_lookups) + cardinality($4::text[]) > $5,
           resync_lookups = case when cardinality(resync_lookups) + cardinality($4::text[]) > $5 then '{}'
             else array(select distinct unnest(resync_lookups || $4::text[])) end
         where id = $1 and user_id = $2`,
        [change.sourceId, actor.userId, change.full, change.lookups, LOOKUP_LIMIT],
      );
    }
  });
}

export async function recordMailEchoes(db: Db, actor: UserActor, sourceId: string, providerMessageIds: string[]) {
  const ids = [...new Set(providerMessageIds.filter((id) => id && id.length <= 400))];
  if (ids.length === 0) return;
  await db.query("delete from crm.mail_echoes where user_id = $1 and changed_at < now() - interval '1 hour'", [actor.userId]);
  await db.query(
    `insert into crm.mail_echoes (source_id, user_id, provider_message_id)
     select $1, $2, unnest($3::text[])
     on conflict (source_id, provider_message_id) do update set changed_at = now()`,
    [sourceId, actor.userId, ids],
  );
}

export type MailSyncOptions = {
  deadline?: number;
  budgetMs?: number;
  fetchImpl?: typeof fetch;
  backfill?: boolean;
  push?: PushSender;
  sourceIds?: string[];
  ignoreFolderWaits?: boolean;
  skipRecentMs?: number;
  announce?: boolean;
  targeted?: boolean;
};

export async function syncMail(actor: UserActor, options: MailSyncOptions): Promise<MailSyncReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = options.deadline ?? Date.now() + (options.budgetMs ?? 20_000);
  const report: MailSyncReport = {
    sources: 0,
    stored: 0,
    removed: 0,
    moved: 0,
    changed: 0,
    backfilling: 0,
    paused: false,
    errors: [],
    reconnect: [],
    arrived: [],
    routed: 0,
    workflowEvents: 0,
    filed: 0,
    busy: [],
    synced: [],
    waiting: [],
    recent: [],
    passes: 0,
    lookups: 0,
  };
  const sources = (await loadSources(actor)).filter((source) => !options.sourceIds || options.sourceIds.includes(source.id));
  const hardStop = await withActor(actor, async (db) => (await databaseBytes(db)) >= mailHardStopBytes());
  if (hardStop) {
    report.paused = true;
    await withActor(actor, (db) =>
      db.query("update crm.mail_sources set last_error = $2 where user_id = $1", [actor.userId, MAIL_HARD_STOP]),
    );
    return report;
  }
  const backfillWanted = options.backfill !== false;
  const due = sources.filter((source) => {
    if (!options.skipRecentMs || source.resync_pending || source.resync_full || (backfillWanted && source.backfilling)) return true;
    if (!syncedWithin(source.last_full_synced_at, options.skipRecentMs)) return true;
    report.recent.push(source.id);
    return false;
  });
  let seenVersion = options.announce && due.length > 0 ? await readMailVersion(actor) : null;
  let announcedWork = 0;
  const announce = async () => {
    if (seenVersion === null) return;
    const version = await readMailVersion(actor);
    if (version === seenVersion) return;
    seenVersion = version;
    const work = report.changed + report.filed + report.routed;
    if (work === announcedWork) return;
    announcedWork = work;
    await signalSynced(actor.userId, "mail");
  };
  const unclassified: { source: Source; folder: FolderRow; token: string }[] = [];
  for (const [index, source] of due.entries()) {
    if (Date.now() >= deadline) break;
    if (waitingUntil(source.retry_at)) {
      report.waiting.push(source.id);
      continue;
    }
    const share = Math.max(5_000, Math.floor((deadline - Date.now()) / (due.length - index)));
    const sourceDeadline = Math.min(deadline, Date.now() + share);
    const claimed = await claim(actor, source.id, sourceDeadline).catch((error) => {
      console.error("Couldn't take the mail sync lock", source.email, problemText(error));
      report.errors.push(`${source.email}: ${problemText(error)}`);
      return null;
    });
    if (claimed === null) continue;
    if (!claimed) {
      report.busy.push(source.id);
      continue;
    }
    report.sources += 1;
    report.synced.push(source.id);
    let lastError: string | null = null;
    let retryAt: Date | null = null;
    let unfinished = false;
    let walkedAll = false;
    const failedFolders = new Set<string>();
    try {
      const token = await currentToken(source.tokens, fetchImpl);
      if (token.expiresAt !== source.tokens.accessTokenExpiresAt) await withActor(actor, (db) => saveToken(db, source, token));
      await keepSubscription(actor, source, token.accessToken, fetchImpl, sourceDeadline).catch((error) =>
        console.error("Mail subscription failed", error instanceof Error ? error.message : error),
      );
      const stale = !source.folders_synced_at || Date.now() - new Date(source.folders_synced_at).getTime() > FOLDER_REFRESH_MS;
      const refreshed = stale ? await refreshFoldersSafely(actor, source, token.accessToken, fetchImpl, sourceDeadline, report) : false;
      const mailScope = grantsMailWrite((await withActor(actor, (db) => readReconnectSource(db, actor, source.id)).catch(() => null))?.scopes);
      const shares = await ownsShares(actor);
      const ready = (folder: FolderRow) => options.ignoreFolderWaits === true || !waitingUntil(folder.retry_at);
      const places: Places = { folders: new Map(), skipped: new Set(), refreshed, mailScope };
      for (let pass = 1; ; pass += 1) {
        report.passes += 1;
        const folders = await loadFolders(actor, source.id);
        const { live, backfill } = folderOrder(folders);
        Object.assign(places, placesOf(folders));
        const work = await takeWork(actor, source.id);
        const plan = options.targeted
          ? await targetFolders(actor, source, folders, work, token.accessToken, places, { fetchImpl, deadline: sourceDeadline }, report)
          : { walk: live, all: true };
        const cutBefore = report.backfilling;
        let cut = false;
        for (const folder of plan.walk.filter(ready)) {
          if (Date.now() >= sourceDeadline) {
            cut = true;
            break;
          }
          const options = { deadline: sourceDeadline, fetchImpl, guard: folder.sync_state !== "live", places, shares };
          if (!(await runFolder(actor, source, folder, token.accessToken, options, report))) failedFolders.add(folder.id);
        }
        if (cut || report.backfilling > cutBefore) unfinished = true;
        else if (plan.all) walkedAll = true;
        if (pass === 1) {
          for (const folder of live.filter((item) => item.role === "inbox" && !item.classified_at)) {
            unclassified.push({ source, folder, token: token.accessToken });
          }
          if (backfillWanted) {
            const backfillDeadline = sourceDeadline - AGAIN_MIN_MS;
            for (const folder of backfill.filter(ready)) {
              if (Date.now() >= backfillDeadline || report.paused || (await changePending(actor, source.id))) break;
              await runFolder(actor, source, folder, token.accessToken, { deadline: backfillDeadline, fetchImpl, guard: true, places, shares }, report);
            }
          }
        }
        if (pass >= MAX_PASSES || sourceDeadline - Date.now() < AGAIN_MIN_MS) break;
        if (!(await changedAgain(actor, source.id, sourceDeadline))) break;
      }
    } catch (error) {
      if (error instanceof GraphOutOfTime) unfinished = true;
      else {
        const reconnect = await sourceProblem(actor, source, error);
        lastError = reconnect ?? problemText(error);
        report.errors.push(reconnect ?? `${source.email}: ${lastError}`);
        if (reconnect) report.reconnect.push(reconnect);
        if (throttled(error)) retryAt = throttleUntil(error);
      }
    } finally {
      if (failedFolders.size > 0) await remarkFolders(actor, source.id, [...failedFolders]);
      await releaseSource(actor, source.id, lastError, retryAt, { unfinished, redo: lastError !== null, walkedAll: walkedAll && !unfinished });
    }
  }
  await announce();
  report.arrived = await claimArrivals(actor);
  const routed = report.arrived.length
    ? await routeArrivedMail(actor, report.arrived, { fetchImpl, deadline }).catch((error) => {
        console.error("Routing new mail failed", error instanceof Error ? error.message : error);
        return [] as string[];
      })
    : [];
  report.routed = routed.length;
  report.filed = await fileMailOnTimeline(actor, { deadline, fetchImpl: options.fetchImpl })
    .then((result) => result.filed)
    .catch((error) => {
      console.error("Filing mail on contacts failed", error);
      return 0;
    });
  if (report.arrived.length) {
    const fresh = report.arrived.filter((id) => !routed.includes(id));
    if (fresh.length) await notifyNewMail(actor, fresh, { send: options.push }).catch((error) => console.error("Mail notification failed", error));
    report.workflowEvents = await queueMailWorkflowEvents(actor, report.arrived, { deadline, fetchImpl: options.fetchImpl }).catch((error) => {
      console.error("Queueing mail workflows failed", error);
      return 0;
    });
  }
  if (deadline - Date.now() > 10_000) {
    await classifyEmailTones(actor, { deadline, fetchImpl: options.fetchImpl }).catch((error) => console.error("Reading email tone failed", error));
  }
  for (const item of unclassified) {
    if (Date.now() >= deadline) break;
    await classifyFolderSafely(actor, item.source, item.folder, item.token, deadline, fetchImpl);
  }
  await announce();
  return report;
}

const NOTIFIED_SYNC_MS = 15_000;
const NOTIFIED_POLL_MS = 1_000;
const NOTIFIED_SYNC_LIMIT = 4;
const SHORTEST_NOTIFIED_SYNC_MS = 3_000;

type PendingSource = { id: string; held: boolean; throttled: boolean };

async function pendingSources(actor: UserActor, sourceIds: string[]) {
  const result = await withActor(actor, (db) =>
    db.query<PendingSource>(
      `select id, coalesce(locked_until > now(), false) as held, coalesce(retry_at > now(), false) as throttled
       from crm.mail_sources where user_id = $1 and id = any($2::uuid[]) and resync_pending`,
      [actor.userId, sourceIds],
    ),
  );
  return result.rows;
}

export async function syncNotifiedMailboxes(
  actor: UserActor,
  sourceIds: string[],
  options: { deadline: number; fetchImpl?: typeof fetch; pollMs?: number; noted?: boolean },
) {
  const pollMs = options.pollMs ?? NOTIFIED_POLL_MS;
  let waiting = [...new Set(sourceIds)];
  let stored = 0;
  let workflowEvents = 0;
  let syncs = 0;
  if (!options.noted) await noteMailChanges(actor, waiting.map((sourceId) => ({ sourceId, full: true, folderIds: [], lookups: [] })));
  while (waiting.length > 0) {
    const pending = await pendingSources(actor, waiting);
    waiting = pending.filter((source) => !source.throttled).map((source) => source.id);
    if (waiting.length === 0) break;
    const free = pending.filter((source) => !source.held && !source.throttled).map((source) => source.id);
    const left = options.deadline - Date.now();
    if (free.length > 0 && syncs < NOTIFIED_SYNC_LIMIT && left >= SHORTEST_NOTIFIED_SYNC_MS) {
      syncs += 1;
      const report = await syncMail(actor, {
        deadline: Math.min(options.deadline, Date.now() + NOTIFIED_SYNC_MS),
        backfill: false,
        sourceIds: free,
        ignoreFolderWaits: true,
        fetchImpl: options.fetchImpl,
        announce: true,
        targeted: true,
      });
      stored += report.stored;
      workflowEvents += report.workflowEvents;
      const reached = new Set([...report.synced, ...report.busy, ...report.waiting]);
      waiting = waiting.filter((id) => !free.includes(id) || reached.has(id));
      continue;
    }
    if (left < pollMs + SHORTEST_NOTIFIED_SYNC_MS) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { stored, workflowEvents, unreached: waiting };
}

export const SCHEDULED_FLOOR_MS = 60_000;
export const REFRESH_FLOOR_MS = 2 * 60_000;

export function screenSyncOptions(body: unknown): MailSyncOptions {
  const manual = typeof body === "object" && body !== null && (body as { manual?: unknown }).manual === true;
  return { budgetMs: 8_000, backfill: false, ignoreFolderWaits: manual, skipRecentMs: REFRESH_FLOOR_MS, announce: true };
}
