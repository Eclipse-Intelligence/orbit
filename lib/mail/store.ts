import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { opensSql, readsSql } from "@/lib/mail/tracking";
import type { MailAddress, MailRole } from "@/lib/mail/types";

type MailSummary = {
  id: string;
  account: string;
  folder: string;
  folderRole: MailRole;
  threadKey: string | null;
  subject: string | null;
  snippet: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  receivedAt: string | null;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  opens?: { count: number; lastAt: string | null } | null;
};

type MailMessage = Omit<MailSummary, "opens"> & {
  cc: MailAddress[];
  sentAt: string | null;
  bodyText: string | null;
  webLink: string | null;
  opens: { at: string; device: string | null }[] | null;
};

export type MailSourceStatus = {
  email: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  stored: number;
  total: number;
  folders: { name: string; role: MailRole; state: string; stored: number; total: number; error: string | null }[];
};

type Row = {
  id: string;
  account: string;
  folder: string;
  folder_role: MailRole;
  thread_key: string | null;
  subject: string | null;
  snippet: string | null;
  from_email: string | null;
  from_name: string | null;
  to_recipients: MailAddress[];
  cc_recipients?: MailAddress[];
  received_at: Date | string | null;
  sent_at?: Date | string | null;
  is_read: boolean;
  is_flagged: boolean;
  has_attachments: boolean;
  body_text?: string | null;
  web_link?: string | null;
  reads?: { count: number; last: string | null } | null;
  opens?: { at: string; agent: string | null }[] | null;
};

const SUMMARY_COLUMNS = `
  m.id, s.email as account, f.name as folder, f.role as folder_role, m.thread_key, m.subject, m.snippet,
  m.from_email, m.from_name, m.to_recipients, m.received_at, m.is_read, m.is_flagged, m.has_attachments
`;

const FROM = `
  from crm.mail_messages m
  join crm.mail_sources s on s.id = m.source_id
  join crm.mail_folders f on f.id = m.folder_id
`;

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function summary(row: Row): MailSummary {
  return {
    id: row.id,
    account: row.account,
    folder: row.folder,
    folderRole: row.folder_role,
    threadKey: row.thread_key,
    subject: row.subject,
    snippet: row.snippet,
    from: row.from_email ? { name: row.from_name, address: row.from_email } : null,
    to: row.to_recipients ?? [],
    receivedAt: iso(row.received_at),
    isRead: row.is_read,
    isFlagged: row.is_flagged,
    hasAttachments: row.has_attachments,
  };
}

export async function searchMail(
  actor: UserActor,
  input: { query?: string; from?: string; account?: string; folder?: MailRole; limit?: number },
): Promise<MailSummary[]> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.userId];
    const where = ["m.user_id = $1"];
    const text = input.query?.trim().slice(0, 300);
    let rank = "0";
    if (text) {
      values.push(text);
      where.push(`m.search @@ websearch_to_tsquery('english', $${values.length})`);
      rank = `ts_rank(m.search, websearch_to_tsquery('english', $${values.length}))`;
    }
    if (input.from?.trim()) {
      values.push(`%${input.from.trim().toLowerCase().replace(/[%_\\]/g, "\\$&")}%`);
      where.push(`(m.from_email ilike $${values.length} or coalesce(m.from_name, '') ilike $${values.length})`);
    }
    if (input.account?.trim()) {
      values.push(input.account.trim().toLowerCase());
      where.push(`lower(s.email) = $${values.length}`);
    }
    if (input.folder) {
      values.push(input.folder);
      where.push(`f.role = $${values.length}`);
    }
    values.push(limit);
    const result = await db.query<Row>(
      `select ${SUMMARY_COLUMNS}, ${readsSql("m")} as reads ${FROM}
       where ${where.join(" and ")}
       order by ${text ? `${rank} desc, ` : ""}m.received_at desc nulls last
       limit $${values.length}`,
      values,
    );
    return result.rows.map((row) => ({ ...summary(row), opens: row.reads ? { count: row.reads.count, lastAt: iso(row.reads.last) } : null }));
  });
}

export async function getMailThread(actor: UserActor, messageId: string): Promise<MailMessage[]> {
  if (!isUuid(messageId)) throw new CrmError("not_found", "Email not found.", 404);
  return withActor(actor, async (db) => {
    const anchor = await db.query<{ source_id: string; thread_key: string | null }>(
      "select source_id, thread_key from crm.mail_messages where id = $1 and user_id = $2",
      [messageId, actor.userId],
    );
    const found = anchor.rows[0];
    if (!found) throw new CrmError("not_found", "Email not found.", 404);
    const result = await db.query<Row>(
      `select ${SUMMARY_COLUMNS}, m.cc_recipients, m.sent_at, m.body_text, m.web_link, ${opensSql("m")} as opens ${FROM}
       where m.user_id = $1 and ${found.thread_key ? "m.source_id = $2 and m.thread_key = $3" : "m.id = $2"}
       order by coalesce(m.received_at, m.sent_at) asc
       limit 100`,
      found.thread_key ? [actor.userId, found.source_id, found.thread_key] : [actor.userId, messageId],
    );
    return result.rows.map((row) => ({
      ...summary(row),
      cc: row.cc_recipients ?? [],
      sentAt: iso(row.sent_at),
      bodyText: row.body_text ?? null,
      webLink: row.web_link ?? null,
      opens: row.opens ? row.opens.map((open) => ({ at: iso(open.at)!, device: open.agent })) : null,
    }));
  });
}

export async function mailSyncStatus(actor: UserActor): Promise<MailSourceStatus[]> {
  return withActor(actor, async (db) => {
    const sources = await db.query<{ id: string; email: string; last_synced_at: Date | string | null; last_error: string | null }>(
      "select id, email, last_synced_at, last_error from crm.mail_sources where user_id = $1 order by connection_id is null, created_at",
      [actor.userId],
    );
    const folders = await db.query<{
      source_id: string;
      name: string;
      role: MailRole;
      sync_state: string;
      synced_count: number;
      total_count: number;
      last_error: string | null;
    }>(
      `select source_id, name, role, sync_state, synced_count, total_count, last_error
       from crm.mail_folders where user_id = $1 order by name`,
      [actor.userId],
    );
    return sources.rows.map((source) => {
      const own = folders.rows.filter((folder) => folder.source_id === source.id && folder.sync_state !== "skipped");
      return {
        email: source.email,
        lastSyncedAt: iso(source.last_synced_at),
        lastError: source.last_error,
        stored: own.reduce((sum, folder) => sum + folder.synced_count, 0),
        total: own.reduce((sum, folder) => sum + folder.total_count, 0),
        folders: own.map((folder) => ({
          name: folder.name,
          role: folder.role,
          state: folder.sync_state,
          stored: folder.synced_count,
          total: folder.total_count,
          error: folder.last_error,
        })),
      };
    });
  });
}
