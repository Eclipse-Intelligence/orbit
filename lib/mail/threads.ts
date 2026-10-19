import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { cleanEmailHtml, richEmail } from "@/lib/mail/html";
import type { MailAddress, MailRole } from "@/lib/mail/types";
import type { MailNav, MailView, ThreadCursor, ThreadDetail, ThreadSummary } from "@/lib/mail/view";

const THREAD_KEY = "coalesce(m.thread_key, 'm:' || m.id::text)";

export function threadKey(sourceId: string, key: string) {
  return `${sourceId}|${key}`;
}

export function parseThreadKey(value: string) {
  const split = value.indexOf("|");
  if (split <= 0) throw new CrmError("not_found", "Conversation not found.", 404);
  const sourceId = value.slice(0, split);
  const key = value.slice(split + 1);
  if (!isUuid(sourceId) || !key || key.length > 450) throw new CrmError("not_found", "Conversation not found.", 404);
  return { sourceId, key };
}

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

type ThreadRow = {
  source_id: string;
  tk: string;
  account: string;
  id: string;
  subject: string | null;
  snippet: string | null;
  from_email: string | null;
  from_name: string | null;
  to_recipients: MailAddress[];
  n: number;
  unread: boolean;
  flagged: boolean;
  attachments: boolean;
  is_draft: boolean;
  at: Date | string | null;
};

export async function listThreads(
  actor: UserActor,
  input: { view?: MailView; sourceId?: string | null; query?: string; before?: ThreadCursor | null; limit?: number },
): Promise<{ threads: ThreadSummary[]; next: ThreadCursor | null }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.userId];
    const where = ["m.user_id = $1"];
    const text = input.query?.trim().slice(0, 300);
    if (text) {
      values.push(text);
      where.push(`m.search @@ websearch_to_tsquery('english', $${values.length})`);
      where.push("f.role not in ('junk', 'outbox')");
    } else if (input.view && "folderId" in input.view) {
      if (!isUuid(input.view.folderId)) return { threads: [], next: null };
      values.push(input.view.folderId);
      where.push(`m.folder_id = $${values.length}`);
    } else {
      values.push(input.view && "role" in input.view ? input.view.role : "inbox");
      where.push(`f.role = $${values.length}`);
    }
    if (input.sourceId) {
      if (!isUuid(input.sourceId)) return { threads: [], next: null };
      values.push(input.sourceId);
      where.push(`m.source_id = $${values.length}`);
    }
    const cursor: string[] = [];
    if (input.before) {
      values.push(input.before.at, input.before.key);
      cursor.push(`(r.at, r.source_id::text || '|' || r.tk) < ($${values.length - 1}::timestamptz, $${values.length})`);
    }
    values.push(limit + 1);
    const result = await db.query<ThreadRow>(
      `with scoped as (
         select m.id, m.source_id, ${THREAD_KEY} as tk, m.subject, m.snippet, m.from_email, m.from_name, m.to_recipients,
           m.is_read, m.is_flagged, m.has_attachments, m.is_draft, coalesce(m.received_at, m.sent_at, m.created_at) as at
         from crm.mail_messages m
         join crm.mail_folders f on f.id = m.folder_id
         where ${where.join(" and ")}
       ),
       ranked as (
         select s.*,
           row_number() over (partition by s.source_id, s.tk order by s.at desc, s.id desc) as rn,
           count(*) over w as n,
           bool_or(not s.is_read) over w as unread,
           bool_or(s.is_flagged) over w as flagged,
           bool_or(s.has_attachments) over w as attachments
         from scoped s
         window w as (partition by s.source_id, s.tk)
       )
       select r.source_id, r.tk, src.email as account, r.id, r.subject, r.snippet, r.from_email, r.from_name, r.to_recipients,
         r.n::int as n, r.unread, r.flagged, r.attachments, r.is_draft, r.at
       from ranked r
       join crm.mail_sources src on src.id = r.source_id
       where r.rn = 1 ${cursor.length ? `and ${cursor.join(" and ")}` : ""}
       order by r.at desc, r.source_id::text || '|' || r.tk desc
       limit $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, limit);
    const threads = rows.map((row) => ({
      key: threadKey(row.source_id, row.tk),
      sourceId: row.source_id,
      account: row.account,
      latestId: row.id,
      subject: row.subject,
      snippet: row.snippet,
      from: row.from_email ? { name: row.from_name, address: row.from_email } : null,
      to: row.to_recipients ?? [],
      count: row.n,
      unread: row.unread,
      flagged: row.flagged,
      hasAttachments: row.attachments,
      draft: row.is_draft,
      latestAt: iso(row.at),
    }));
    const last = threads[threads.length - 1];
    return {
      threads,
      next: result.rows.length > limit && last?.latestAt ? { at: last.latestAt, key: last.key } : null,
    };
  });
}

export async function getThread(actor: UserActor, key: string): Promise<ThreadDetail> {
  const { sourceId, key: tk } = parseThreadKey(key);
  return withActor(actor, async (db) => {
    const result = await db.query<{
      id: string;
      role: MailRole;
      folder: string;
      account: string;
      subject: string | null;
      from_email: string | null;
      from_name: string | null;
      to_recipients: MailAddress[];
      cc_recipients: MailAddress[];
      at: Date | string | null;
      is_read: boolean;
      is_draft: boolean;
      is_flagged: boolean;
      has_attachments: boolean;
      snippet: string | null;
      body_html: string | null;
      body_text: string | null;
      web_link: string | null;
    }>(
      `select m.id, f.role, f.name as folder, src.email as account, m.subject, m.from_email, m.from_name, m.to_recipients, m.cc_recipients,
         coalesce(m.received_at, m.sent_at, m.created_at) as at, m.is_read, m.is_draft, m.is_flagged, m.has_attachments, m.snippet,
         m.body_html, m.body_text, m.web_link
       from crm.mail_messages m
       join crm.mail_folders f on f.id = m.folder_id
       join crm.mail_sources src on src.id = m.source_id
       where m.user_id = $1 and m.source_id = $2 and ${THREAD_KEY} = $3 and f.role not in ('junk', 'outbox')
       order by at asc, m.id asc
       limit 200`,
      [actor.userId, sourceId, tk],
    );
    if (result.rows.length === 0) throw new CrmError("not_found", "Conversation not found.", 404);
    const latest = result.rows[result.rows.length - 1];
    return {
      key,
      account: latest.account,
      subject: latest.subject,
      messages: result.rows.map((row) => {
        const html = row.body_html ? cleanEmailHtml(row.body_html) : null;
        return {
          id: row.id,
          folderRole: row.role,
          folder: row.folder,
          from: row.from_email ? { name: row.from_name, address: row.from_email } : null,
          to: row.to_recipients ?? [],
          cc: row.cc_recipients ?? [],
          at: iso(row.at),
          isRead: row.is_read,
          isDraft: row.is_draft,
          isFlagged: row.is_flagged,
          hasAttachments: row.has_attachments,
          snippet: row.snippet,
          html,
          rich: html ? richEmail(html) : false,
          text: row.body_text,
          webLink: row.web_link,
        };
      }),
    };
  });
}

export async function mailNav(actor: UserActor): Promise<MailNav> {
  return withActor(actor, async (db) => {
    const accounts = await db.query<{ id: string; email: string }>(
      "select id, email from crm.mail_sources where user_id = $1 order by connection_id is null, created_at",
      [actor.userId],
    );
    const folders = await db.query<{ id: string; source_id: string; name: string; role: MailRole; unread: number }>(
      `select f.id, f.source_id, f.name, f.role,
         (select count(distinct ${THREAD_KEY})::int from crm.mail_messages m where m.folder_id = f.id and not m.is_read) as unread
       from crm.mail_folders f
       where f.user_id = $1 and f.sync_state <> 'skipped'
       order by f.name`,
      [actor.userId],
    );
    const inboxUnread = (sourceId: string | null) =>
      folders.rows.filter((folder) => folder.role === "inbox" && (!sourceId || folder.source_id === sourceId)).reduce((sum, folder) => sum + folder.unread, 0);
    return {
      accounts: accounts.rows.map((row) => ({ id: row.id, email: row.email, unread: inboxUnread(row.id) })),
      folders: folders.rows.map((row) => ({ id: row.id, sourceId: row.source_id, name: row.name, role: row.role, unread: row.unread })),
      unread: inboxUnread(null),
    };
  });
}

export async function mailUnreadCount(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ unread: number }>(
      `select count(distinct (m.source_id, ${THREAD_KEY}))::int as unread
       from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
       where m.user_id = $1 and f.role = 'inbox' and not m.is_read`,
      [actor.userId],
    );
    return result.rows[0]?.unread ?? 0;
  });
}
