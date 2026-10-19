import { withActor } from "@/lib/crm/context";
import { currentToken, readStored, storeToken, type StoredTokens } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { encryptSecret } from "@/lib/crypto/secret";
import type { Db } from "@/lib/db/pool";
import { fetchMicrosoftDelta, GraphMailError, initialDeltaUrl, listMicrosoftFolders } from "@/lib/mail/microsoft";
import { MailSyncReset, type MailRole, type ProviderMessage } from "@/lib/mail/types";
import type { MicrosoftToken } from "@/lib/microsoft/oauth";

const FOLDER_REFRESH_MS = 6 * 60 * 60 * 1000;
const LOCK_SECONDS = 300;
const SKIPPED_ROLES: MailRole[] = ["junk", "outbox"];
const ROLE_ORDER: MailRole[] = ["inbox", "sent", "drafts", "archive", "other", "trash"];
const DEFAULT_STORAGE_LIMIT_MB = 400;

type SourceRow = {
  id: string;
  email: string;
  connection_id: string | null;
  account_id: string | null;
  folders_synced_at: Date | string | null;
};

type FolderRow = {
  id: string;
  provider_folder_id: string;
  role: MailRole;
  sync_state: "pending" | "backfill" | "live" | "skipped";
  sync_link: string | null;
};

type Source = SourceRow & { tokens: StoredTokens };

export type MailSyncReport = {
  sources: number;
  stored: number;
  removed: number;
  backfilling: number;
  paused: boolean;
  errors: string[];
};

export function mailStorageLimitBytes() {
  const raw = Number(process.env.MAIL_STORAGE_LIMIT_MB);
  const megabytes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STORAGE_LIMIT_MB;
  return megabytes * 1024 * 1024;
}

export function mailHardStopBytes() {
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
       where user_id = $1 and workspace_id = $2 and provider = 'microsoft' and status = 'connected'
         and can_send and email is not null and refresh_token is not null`,
      [actor.userId, actor.workspaceId],
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
      `select id, email, connection_id, account_id, folders_synced_at
       from crm.mail_sources where user_id = $1 and workspace_id = $2
       order by connection_id is null, created_at`,
      [actor.userId, actor.workspaceId],
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
  await db.query(
    "update crm.calendar_accounts set refresh_token = $2, access_token = $3, access_token_expires_at = $4 where id = $1",
    [source.account_id, encryptSecret(token.refreshToken), encryptSecret(token.accessToken), token.expiresAt],
  );
}

async function claim(actor: UserActor, sourceId: string) {
  return withActor(actor, async (db) => {
    const result = await db.query(
      `update crm.mail_sources set locked_until = now() + make_interval(secs => $2)
       where id = $1 and (locked_until is null or locked_until < now())
       returning id`,
      [sourceId, LOCK_SECONDS],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

async function refreshFolders(actor: UserActor, source: Source, token: string, fetchImpl: typeof fetch) {
  const folders = await listMicrosoftFolders(token, fetchImpl);
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
          folder.role,
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

function messageRows(messages: ProviderMessage[]) {
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
    }));
}

async function storePage(db: Db, actor: UserActor, source: Source, folder: FolderRow, messages: ProviderMessage[], removed: string[]) {
  const rows = messageRows(messages);
  if (rows.length > 0) {
    await db.query(
      `insert into crm.mail_messages (
         workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
         body_html, body_text, body_truncated, from_email, from_name, to_recipients, cc_recipients, bcc_recipients,
         sent_at, received_at, is_read, is_draft, is_flagged, importance, has_attachments, categories, web_link
       )
       select $1, $2, $3, $4, x.provider_message_id, x.internet_message_id, x.thread_key, x.subject, x.snippet,
         x.body_html, x.body_text, coalesce(x.body_truncated, false), x.from_email, x.from_name,
         coalesce(x.to_recipients, '[]'), coalesce(x.cc_recipients, '[]'), coalesce(x.bcc_recipients, '[]'),
         x.sent_at, x.received_at, coalesce(x.is_read, false), coalesce(x.is_draft, false), coalesce(x.is_flagged, false),
         x.importance, coalesce(x.has_attachments, false), coalesce(x.categories, '{}'), x.web_link
       from jsonb_to_recordset($5::jsonb) as x(
         provider_message_id text, internet_message_id text, thread_key text, subject text, snippet text,
         body_html text, body_text text, body_truncated boolean, from_email text, from_name text,
         to_recipients jsonb, cc_recipients jsonb, bcc_recipients jsonb, sent_at timestamptz, received_at timestamptz,
         is_read boolean, is_draft boolean, is_flagged boolean, importance text, has_attachments boolean,
         categories text[], web_link text
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
         web_link = excluded.web_link`,
      [actor.workspaceId, actor.userId, source.id, folder.id, JSON.stringify(rows)],
    );
  }
  for (const message of messages.filter((item) => item.partial)) {
    await db.query(
      "update crm.mail_messages set is_read = $3, is_flagged = $4 where source_id = $1 and provider_message_id = $2",
      [source.id, message.providerId, message.isRead, message.isFlagged],
    );
  }
  if (removed.length > 0) {
    await db.query("delete from crm.mail_messages where folder_id = $1 and provider_message_id = any($2::text[])", [folder.id, removed]);
  }
  return rows.length;
}

function folderOrder(folders: FolderRow[]) {
  const rank = (folder: FolderRow) => ROLE_ORDER.indexOf(folder.role) === -1 ? ROLE_ORDER.length : ROLE_ORDER.indexOf(folder.role);
  const live = folders.filter((folder) => folder.sync_state === "live").sort((a, b) => rank(a) - rank(b));
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
  options: { deadline: number; fetchImpl: typeof fetch; guard: boolean },
  report: MailSyncReport,
) {
  let link = folder.sync_link ?? initialDeltaUrl(folder.provider_folder_id);
  let backfilling = folder.sync_state !== "live";
  while (Date.now() < options.deadline) {
    let page;
    try {
      page = await fetchMicrosoftDelta(link, token, options.fetchImpl);
    } catch (error) {
      if (error instanceof MailSyncReset) {
        await withActor(actor, (db) =>
          db.query("update crm.mail_folders set sync_link = null, sync_state = 'pending', last_error = null where id = $1", [folder.id]),
        );
        return;
      }
      throw error;
    }
    const full = await withActor(actor, async (db) => {
      report.stored += await storePage(db, actor, source, folder, page.messages, page.removed);
      report.removed += page.removed.length;
      const next = page.deltaLink ?? page.nextLink;
      const state = page.deltaLink ? "live" : backfilling ? "backfill" : "live";
      await db.query(
        `update crm.mail_folders set
           sync_link = $2,
           sync_state = $3,
           synced_count = (select count(*) from crm.mail_messages where folder_id = $1),
           last_synced_at = case when $4 then now() else last_synced_at end,
           last_error = null
         where id = $1`,
        [folder.id, next, state, Boolean(page.deltaLink)],
      );
      return options.guard && state === "backfill" ? storageFull(db) : false;
    });
    if (page.deltaLink) return;
    if (!page.nextLink) return;
    link = page.nextLink;
    backfilling = true;
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

export async function syncMail(
  actor: UserActor,
  options: { deadline?: number; budgetMs?: number; fetchImpl?: typeof fetch; backfill?: boolean },
): Promise<MailSyncReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = options.deadline ?? Date.now() + (options.budgetMs ?? 20_000);
  const report: MailSyncReport = { sources: 0, stored: 0, removed: 0, backfilling: 0, paused: false, errors: [] };
  const sources = await loadSources(actor);
  const hardStop = await withActor(actor, async (db) => (await databaseBytes(db)) >= mailHardStopBytes());
  if (hardStop) {
    report.paused = true;
    await withActor(actor, (db) =>
      db.query("update crm.mail_sources set last_error = $3 where user_id = $1 and workspace_id = $2", [actor.userId, actor.workspaceId, MAIL_HARD_STOP]),
    );
    return report;
  }
  for (const [index, source] of sources.entries()) {
    if (Date.now() >= deadline) break;
    if (!(await claim(actor, source.id))) continue;
    report.sources += 1;
    const share = Math.max(5_000, Math.floor((deadline - Date.now()) / (sources.length - index)));
    const sourceDeadline = Math.min(deadline, Date.now() + share);
    let lastError: string | null = null;
    try {
      const token = await currentToken(source.tokens, fetchImpl);
      await withActor(actor, (db) => saveToken(db, source, token));
      const stale = !source.folders_synced_at || Date.now() - new Date(source.folders_synced_at).getTime() > FOLDER_REFRESH_MS;
      if (stale) await refreshFolders(actor, source, token.accessToken, fetchImpl);
      const folders = await withActor(actor, async (db) => {
        const result = await db.query<FolderRow>(
          "select id, provider_folder_id, role, sync_state, sync_link from crm.mail_folders where source_id = $1",
          [source.id],
        );
        return result.rows;
      });
      const { live, backfill } = folderOrder(folders);
      for (const folder of live) {
        if (Date.now() >= sourceDeadline) break;
        await syncFolder(actor, source, folder, token.accessToken, { deadline: sourceDeadline, fetchImpl, guard: false }, report);
      }
      if (options.backfill !== false) {
        for (const folder of backfill) {
          if (Date.now() >= sourceDeadline || report.paused) break;
          await syncFolder(actor, source, folder, token.accessToken, { deadline: sourceDeadline, fetchImpl, guard: true }, report);
        }
      }
    } catch (error) {
      lastError = error instanceof GraphMailError || error instanceof Error ? error.message.slice(0, 500) : "Mail sync failed.";
      report.errors.push(`${source.email}: ${lastError}`);
    } finally {
      await withActor(actor, (db) =>
        db.query(
          "update crm.mail_sources set locked_until = null, last_synced_at = case when $2::text is null then now() else last_synced_at end, last_error = $2 where id = $1",
          [source.id, lastError],
        ),
      );
    }
  }
  return report;
}
