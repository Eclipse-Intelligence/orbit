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

type SourceRow = {
  id: string;
  email: string;
  connection_id: string | null;
  account_id: string | null;
  folders_synced_at: Date | string | null;
  snooze_folder_id: string | null;
  graph_subscription_id: string | null;
  graph_subscription_expires_at: Date | string | null;
  retry_at: Date | string | null;
};

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
};

type Source = SourceRow & { tokens: StoredTokens };

type Places = { folders: Map<string, string>; refreshed: boolean; mailScope: boolean | null };

type Removals = { deleted: string[]; moved: { id: string; folder_id: string }[] };

export type MailSyncReport = {
  sources: number;
  stored: number;
  removed: number;
  moved: number;
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
      `select id, email, connection_id, account_id, folders_synced_at, snooze_folder_id, graph_subscription_id, graph_subscription_expires_at, retry_at
       from crm.mail_sources where user_id = $1
       order by last_synced_at nulls first, connection_id is null, created_at`,
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
    await storeToken(db, source.connection_id, token);
    return;
  }
  if (source.account_id) await storeAccountToken(db, source.account_id, token);
}

async function loadSource(actor: UserActor, sourceId: string): Promise<Source | null> {
  return withActor(actor, async (db) => {
    const found = await db.query<SourceRow>(
      `select id, email, connection_id, account_id, folders_synced_at, snooze_folder_id, graph_subscription_id, graph_subscription_expires_at, retry_at
       from crm.mail_sources where id = $1 and user_id = $2`,
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
      `update crm.mail_sources set locked_until = now() + make_interval(secs => $2)
       where id = $1 and (locked_until is null or locked_until < now())
       returning id`,
      [sourceId, seconds],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

async function refreshFolders(actor: UserActor, source: Source, token: string, fetchImpl: typeof fetch, deadline: number) {
  const folders = await listMicrosoftFolders(token, fetchImpl, { deadline });
  await withActor(actor, async (db) => {
    const ids: string[] = [];
    for (const folder of folders) {
      ids.push(folder.providerId);
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
    await db.query("delete from crm.mail_folders where source_id = $1 and not (provider_folder_id = any($2::text[]))", [source.id, ids]);
    await db.query("update crm.mail_sources set folders_synced_at = now() where id = $1", [source.id]);
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
  arrivals: boolean,
) {
  const rows = messageRows(messages, source.email);
  const inserted: string[] = [];
  const touched = new Set<string>();
  const quiet = !shareVisibleRole(folder.role);
  if (rows.length > 0) {
    const result = await db.query<{ id: string; inserted: boolean; thread_key: string | null; before_thread: string | null; changed: boolean }>(
      `with before as (
         select m.provider_message_id, m.folder_id, m.is_draft, m.thread_key
         from crm.mail_messages m
         where m.source_id = $3 and m.provider_message_id in (select x.provider_message_id from jsonb_to_recordset($5::jsonb) as x(provider_message_id text))
       ),
       stored as (
       insert into crm.mail_messages (
         workspace_id, user_id, source_id, folder_id, arrival_pending, provider_message_id, internet_message_id, thread_key, subject, snippet,
         body_html, body_text, body_truncated, from_email, from_name, to_recipients, cc_recipients, bcc_recipients,
         sent_at, received_at, is_read, is_draft, is_flagged, importance, has_attachments, categories, web_link, tracking_id, focused
       )
       select $1, $2, $3, $4, $6, x.provider_message_id, x.internet_message_id, x.thread_key, x.subject, x.snippet,
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
       returning id, provider_message_id, folder_id, is_draft, thread_key, (xmax = 0) as inserted
       )
       select s.id, s.inserted, s.thread_key, b.thread_key as before_thread,
         (b.provider_message_id is not null and (b.folder_id <> s.folder_id or b.is_draft <> s.is_draft or b.thread_key is distinct from s.thread_key)) as changed
       from stored s left join before b on b.provider_message_id = s.provider_message_id`,
      [actor.workspaceId, actor.userId, source.id, folder.id, JSON.stringify(rows), arrivals],
    );
    for (const row of result.rows) {
      if (row.inserted) inserted.push(row.id);
      if (row.inserted && quiet) continue;
      if (!row.inserted && !row.changed) continue;
      if (row.thread_key) touched.add(row.thread_key);
      if (row.before_thread) touched.add(row.before_thread);
    }
  }
  for (const message of messages.filter((item) => item.partial)) {
    await db.query(
      "update crm.mail_messages set is_read = $3, is_flagged = $4, focused = coalesce($5, focused) where source_id = $1 and provider_message_id = $2",
      [source.id, message.providerId, message.isRead, message.isFlagged, message.focused],
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
  }
  if (removals.deleted.length > 0) {
    const deleted = await db.query<{ thread_key: string | null }>(
      "delete from crm.mail_messages where folder_id = $1 and provider_message_id = any($2::text[]) returning thread_key",
      [folder.id, removals.deleted],
    );
    if (!quiet) for (const row of deleted.rows) if (row.thread_key) touched.add(row.thread_key);
  }
  return { stored: rows.length, inserted, touched: [...touched] };
}

async function folderPlaces(actor: UserActor, sourceId: string): Promise<Map<string, string>> {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; provider_folder_id: string }>(
      "select id, provider_folder_id from crm.mail_folders where source_id = $1 and sync_state <> 'skipped'",
      [sourceId],
    );
    return new Map(result.rows.map((row) => [row.provider_folder_id, row.id]));
  });
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
      "select provider_message_id from crm.mail_messages where folder_id = $1 and provider_message_id = any($2::text[])",
      [folder.id, removed],
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
  const unknown = [...parents.values()].some((parent) => parent && !places.folders.has(parent));
  if (unknown && !places.refreshed) {
    places.refreshed = true;
    await refreshFolders(actor, source, token, fetchImpl, deadline);
    places.folders = await folderPlaces(actor, source.id);
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
  while (Date.now() < options.deadline) {
    let page;
    try {
      page = await fetchMicrosoftDelta(link, token, options.fetchImpl, { deadline: options.deadline });
    } catch (error) {
      if (error instanceof MailSyncReset) {
        await withActor(actor, (db) =>
          db.query("update crm.mail_folders set sync_link = null, sync_state = 'pending', last_error = null, failures = 0, retry_at = null where id = $1", [folder.id]),
        );
        return;
      }
      throw error;
    }
    const removals = await placeRemoved(actor, source, folder, page.removed, token, options.places, options.fetchImpl, options.deadline);
    if (!removals) break;
    let touched: string[] = [];
    const full = await withActor(actor, async (db) => {
      const stored = await storePage(db, actor, source, folder, page.messages, removals, live && folder.role === "inbox");
      touched = stored.touched;
      report.stored += stored.stored;
      report.removed += removals.deleted.length;
      report.moved += removals.moved.length;
      const next = page.deltaLink ?? page.nextLink;
      const state = live || page.deltaLink ? "live" : "backfill";
      await db.query(
        `update crm.mail_folders set
           sync_link = $2,
           sync_state = $3,
           synced_count = (select count(*) from crm.mail_messages where folder_id = $1),
           last_synced_at = case when $4 then now() else last_synced_at end,
           last_error = null,
           failures = 0,
           retry_at = null
         where id = $1`,
        [folder.id, next, state, Boolean(page.deltaLink)],
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

async function keepSubscription(actor: UserActor, source: Source, token: string, fetchImpl: typeof fetch, deadline: number) {
  const origin = mailOrigin();
  if (!origin) return;
  const expires = source.graph_subscription_expires_at ? new Date(source.graph_subscription_expires_at).getTime() : 0;
  if (source.graph_subscription_id && expires - Date.now() > RENEW_BEFORE_MS) return;
  if (source.graph_subscription_id) {
    try {
      const expiresAt = await renewMailSubscription(token, source.graph_subscription_id, fetchImpl, { deadline });
      await withActor(actor, (db) => db.query("update crm.mail_sources set graph_subscription_expires_at = $2 where id = $1", [source.id, expiresAt]));
      return;
    } catch (error) {
      if (!(error instanceof GraphMailError && error.status === 404)) throw error;
    }
  }
  const clientState = randomBytes(24).toString("hex");
  const created = await createMailSubscription(token, { notificationUrl: `${origin}/api/microsoft/mail-webhook`, clientState }, fetchImpl, { deadline });
  await withActor(actor, (db) =>
    db.query(
      "update crm.mail_sources set graph_subscription_id = $2, graph_subscription_expires_at = $3, graph_client_state = $4 where id = $1",
      [source.id, created.id, created.expiresAt, clientState],
    ),
  );
}

async function classifyFolder(actor: UserActor, source: Source, folder: FolderRow, token: string, deadline: number, fetchImpl: typeof fetch) {
  let url: string | null = classificationUrl(folder.provider_folder_id);
  while (url && Date.now() < deadline) {
    const page = await fetchMicrosoftClassifications(url, token, fetchImpl, { deadline });
    if (page.items.length) {
      await withActor(actor, (db) =>
        db.query(
          `update crm.mail_messages m set focused = x.focused
           from jsonb_to_recordset($2::jsonb) as x(id text, focused boolean)
           where m.source_id = $1 and m.provider_message_id = x.id`,
          [source.id, JSON.stringify(page.items)],
        ),
      );
    }
    url = page.next;
  }
  if (!url) await withActor(actor, (db) => db.query("update crm.mail_folders set classified_at = now() where id = $1", [folder.id]));
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
  } catch (error) {
    if (error instanceof GraphOutOfTime) {
      report.backfilling += 1;
      return;
    }
    if (await stopsSource(actor, source, error)) throw error;
    await folderFailed(actor, source, folder, error, report);
  }
}

async function refreshFoldersSafely(actor: UserActor, source: Source, token: string, fetchImpl: typeof fetch, deadline: number, report: MailSyncReport) {
  try {
    await refreshFolders(actor, source, token, fetchImpl, deadline);
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
    if (await stopsSource(actor, source, error)) throw error;
    console.error("Sorting Focused mail failed", source.email, problemText(error));
  }
}

async function releaseSource(actor: UserActor, sourceId: string, lastError: string | null, retryAt: Date | null) {
  try {
    await withActor(actor, (db) =>
      db.query(
        `update crm.mail_sources set locked_until = null,
           last_synced_at = case when $2::text is null then now() else last_synced_at end,
           last_error = $2,
           retry_at = $3
         where id = $1`,
        [sourceId, lastError, retryAt],
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

export async function syncMail(
  actor: UserActor,
  options: { deadline?: number; budgetMs?: number; fetchImpl?: typeof fetch; backfill?: boolean; push?: PushSender; sourceIds?: string[]; ignoreFolderWaits?: boolean },
): Promise<MailSyncReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = options.deadline ?? Date.now() + (options.budgetMs ?? 20_000);
  const report: MailSyncReport = {
    sources: 0,
    stored: 0,
    removed: 0,
    moved: 0,
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
  for (const [index, source] of sources.entries()) {
    if (Date.now() >= deadline) break;
    if (waitingUntil(source.retry_at)) {
      report.waiting.push(source.id);
      continue;
    }
    const share = Math.max(5_000, Math.floor((deadline - Date.now()) / (sources.length - index)));
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
    try {
      const token = await currentToken(source.tokens, fetchImpl);
      await withActor(actor, (db) => saveToken(db, source, token));
      await keepSubscription(actor, source, token.accessToken, fetchImpl, sourceDeadline).catch((error) =>
        console.error("Mail subscription failed", error instanceof Error ? error.message : error),
      );
      const stale = !source.folders_synced_at || Date.now() - new Date(source.folders_synced_at).getTime() > FOLDER_REFRESH_MS;
      const refreshed = stale ? await refreshFoldersSafely(actor, source, token.accessToken, fetchImpl, sourceDeadline, report) : false;
      const folders = await withActor(actor, async (db) => {
        const result = await db.query<FolderRow>(
          `select id, provider_folder_id, name, role, sync_state, sync_link, classified_at, last_synced_at, failures, retry_at
           from crm.mail_folders where source_id = $1`,
          [source.id],
        );
        return result.rows;
      });
      const { live, backfill } = folderOrder(folders);
      const places: Places = {
        folders: new Map(folders.filter((folder) => folder.sync_state !== "skipped").map((folder) => [folder.provider_folder_id, folder.id])),
        refreshed,
        mailScope: grantsMailWrite((await withActor(actor, (db) => readReconnectSource(db, actor, source.id)).catch(() => null))?.scopes),
      };
      const shares = await ownsShares(actor);
      const ready = (folder: FolderRow) => options.ignoreFolderWaits === true || !waitingUntil(folder.retry_at);
      for (const folder of live.filter(ready)) {
        if (Date.now() >= sourceDeadline) break;
        await runFolder(actor, source, folder, token.accessToken, { deadline: sourceDeadline, fetchImpl, guard: false, places, shares }, report);
      }
      for (const folder of live.filter((item) => item.role === "inbox" && !item.classified_at)) {
        if (Date.now() >= sourceDeadline) break;
        await classifyFolderSafely(actor, source, folder, token.accessToken, sourceDeadline, fetchImpl);
      }
      if (options.backfill !== false) {
        for (const folder of backfill.filter(ready)) {
          if (Date.now() >= sourceDeadline || report.paused) break;
          await runFolder(actor, source, folder, token.accessToken, { deadline: sourceDeadline, fetchImpl, guard: true, places, shares }, report);
        }
      }
    } catch (error) {
      if (!(error instanceof GraphOutOfTime)) {
        const reconnect = await sourceProblem(actor, source, error);
        lastError = reconnect ?? problemText(error);
        report.errors.push(reconnect ?? `${source.email}: ${lastError}`);
        if (reconnect) report.reconnect.push(reconnect);
        if (throttled(error)) retryAt = throttleUntil(error);
      }
    } finally {
      await releaseSource(actor, source.id, lastError, retryAt);
    }
  }
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
  if (deadline - Date.now() > 10_000) {
    await classifyEmailTones(actor, { deadline, fetchImpl: options.fetchImpl }).catch((error) => console.error("Reading email tone failed", error));
  }
  if (report.arrived.length) {
    const fresh = report.arrived.filter((id) => !routed.includes(id));
    if (fresh.length) await notifyNewMail(actor, fresh, { send: options.push }).catch((error) => console.error("Mail notification failed", error));
    report.workflowEvents = await queueMailWorkflowEvents(actor, report.arrived, { deadline, fetchImpl: options.fetchImpl }).catch((error) => {
      console.error("Queueing mail workflows failed", error);
      return 0;
    });
  }
  return report;
}

const NOTIFIED_SYNC_MS = 15_000;
const NOTIFIED_ATTEMPTS = 3;
const NOTIFIED_RETRY_MS = 4_000;
const SHORTEST_NOTIFIED_SYNC_MS = 3_000;

export async function syncNotifiedMailboxes(
  actor: UserActor,
  sourceIds: string[],
  options: { deadline: number; fetchImpl?: typeof fetch; retryMs?: number },
) {
  const retryMs = options.retryMs ?? NOTIFIED_RETRY_MS;
  let pending = [...new Set(sourceIds)];
  let stored = 0;
  let workflowEvents = 0;
  for (let attempt = 0; pending.length > 0 && attempt < NOTIFIED_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      if (options.deadline - Date.now() < retryMs + SHORTEST_NOTIFIED_SYNC_MS) break;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
    const report = await syncMail(actor, {
      deadline: Math.min(options.deadline, Date.now() + NOTIFIED_SYNC_MS),
      backfill: false,
      sourceIds: pending,
      ignoreFolderWaits: true,
      fetchImpl: options.fetchImpl,
    });
    stored += report.stored;
    workflowEvents += report.workflowEvents;
    pending = pending.filter((id) => !report.synced.includes(id) && !report.waiting.includes(id));
  }
  return { stored, workflowEvents, unreached: pending };
}

export function screenSyncOptions(body: unknown) {
  const manual = typeof body === "object" && body !== null && (body as { manual?: unknown }).manual === true;
  return { budgetMs: 8_000, backfill: false, ignoreFolderWaits: manual };
}
