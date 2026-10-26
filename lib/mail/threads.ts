import { withActor } from "@/lib/crm/context";
import type { Db } from "@/lib/db/pool";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { threadDrafts } from "@/lib/mail/compose";
import { freshPrepared, preparedFor } from "@/lib/mail/prepare";
import { cleanEmailHtml, richEmail } from "@/lib/mail/html";
import type { MailAddress, MailRole } from "@/lib/mail/types";
import { splitCase, splitJoin } from "@/lib/mail/split";
import type { MailNav, MailSplit, MailView, ThreadCursor, ThreadDetail, ThreadPerson, ThreadSummary } from "@/lib/mail/view";

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
  sort_at: Date | string | null;
  reminder_kind: "snooze" | "follow_up" | null;
  surfaced_at: Date | string | null;
  snoozed_until: Date | string | null;
  split: MailSplit | null;
  reads: { count: number; last: string | null } | null;
  prepared: boolean;
};

export async function listThreads(
  actor: UserActor,
  input: { view?: MailView; sourceId?: string | null; query?: string; before?: ThreadCursor | null; limit?: number },
): Promise<{ threads: ThreadSummary[]; next: ThreadCursor | null }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.userId, actor.workspaceId];
    const where = ["m.user_id = $1", "m.workspace_id = $2"];
    let split: MailSplit | null = null;
    let splitting = false;
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
      const role = input.view && "role" in input.view ? input.view.role : "inbox";
      split = role === "inbox" && input.view && "role" in input.view ? (input.view.split ?? null) : null;
      splitting = role === "inbox";
      values.push(role);
      where.push(
        role === "inbox"
          ? `(f.role = $${values.length} or (f.role not in ('trash', 'junk', 'outbox', 'drafts') and exists (
              select 1 from crm.mail_reminders rm
              where rm.user_id = m.user_id and rm.source_id = m.source_id and rm.thread_key = ${THREAD_KEY}
                and rm.state = 'due' and rm.kind = 'follow_up'
            )))`
          : `f.role = $${values.length}`,
      );
    }
    if (input.sourceId) {
      if (!isUuid(input.sourceId)) return { threads: [], next: null };
      values.push(input.sourceId);
      where.push(`m.source_id = $${values.length}`);
    }
    const cursor: string[] = [];
    if (split) {
      values.push(split);
      cursor.push(`l.split = $${values.length}`);
    }
    if (input.before) {
      values.push(input.before.at, input.before.key);
      cursor.push(`(l.sort_at, l.source_id::text || '|' || l.tk) < ($${values.length - 1}::timestamptz, $${values.length})`);
    }
    values.push(limit + 1);
    const result = await db.query<ThreadRow>(
      `with scoped as (
         select m.id, m.source_id, ${THREAD_KEY} as tk, m.subject, m.snippet, m.from_email, m.from_name, m.to_recipients,
           m.is_read, m.is_flagged, m.has_attachments, (m.is_draft and f.role = 'drafts') as is_draft, coalesce(m.received_at, m.sent_at, m.created_at) as at,
           m.tracking_id, m.focused
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
       ),
       listed as (
         select r.*, rem.kind as reminder_kind, rem.surfaced_at, snz.until as snoozed_until,
           greatest(r.at, coalesce(rem.surfaced_at, r.at)) as sort_at,
           ${splitting ? splitCase("r", "$2") : "null"} as split
         from ranked r
         ${splitting ? splitJoin("r", "$1") : ""}
         left join lateral (
           select rm.kind, rm.surfaced_at from crm.mail_reminders rm
           where rm.user_id = $1 and rm.source_id = r.source_id and rm.thread_key = r.tk and rm.state = 'due'
           order by rm.surfaced_at desc limit 1
         ) rem on true
         left join lateral (
           select min(rm.due_at) as until from crm.mail_reminders rm
           where rm.user_id = $1 and rm.source_id = r.source_id and rm.thread_key = r.tk and rm.state = 'waiting' and rm.kind = 'snooze'
         ) snz on true
         where r.rn = 1
       )
       select l.source_id, l.tk, src.email as account, l.id, l.subject, l.snippet, l.from_email, l.from_name, l.to_recipients,
         l.n::int as n, l.unread, l.flagged, l.attachments, l.is_draft, l.at, l.sort_at, l.reminder_kind, l.surfaced_at, l.snoozed_until, l.split,
         case when l.tracking_id is not null then (
           select json_build_object('count', count(*)::int, 'last', max(o.opened_at)) from crm.mail_opens o where o.tracking_id = l.tracking_id
         ) end as reads,
         exists (
           select 1 from crm.mail_prepared p
           where p.message_id = l.id and p.kind in ('reply', 'nudge') and p.state in ('ready', 'used')
         ) as prepared
       from listed l
       join crm.mail_sources src on src.id = l.source_id
       ${cursor.length ? `where ${cursor.join(" and ")}` : ""}
       order by l.sort_at desc, l.source_id::text || '|' || l.tk desc
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
      reads: row.reads ? { count: row.reads.count, last: iso(row.reads.last) } : null,
      reminder: row.reminder_kind && row.surfaced_at ? { kind: row.reminder_kind, at: iso(row.surfaced_at)! } : null,
      snoozedUntil: iso(row.snoozed_until),
      split: row.split,
      prepared: row.prepared,
    }));
    const lastRow = rows[rows.length - 1];
    return {
      threads,
      next: result.rows.length > limit && lastRow?.sort_at ? { at: iso(lastRow.sort_at)!, key: threadKey(lastRow.source_id, lastRow.tk) } : null,
    };
  });
}

export async function getThread(actor: UserActor, key: string): Promise<ThreadDetail> {
  const detail = await readThread(actor, key);
  if (detail.prepared?.times) {
    detail.prepared = (await freshPrepared(actor, detail.prepared.id).catch(() => null)) ?? detail.prepared;
  }
  return detail;
}

const PEOPLE_MAX = 4;

async function threadPeople(
  db: Db,
  actor: UserActor,
  rows: { from_email: string | null; from_name: string | null; to_recipients: MailAddress[]; cc_recipients: MailAddress[] }[],
): Promise<ThreadPerson[]> {
  const own = new Set(
    (await db.query<{ email: string }>("select lower(email) as email from crm.mail_sources where user_id = $1", [actor.userId])).rows.map((row) => row.email),
  );
  const seen = new Map<string, string | null>();
  for (const row of rows) {
    const addresses = [{ address: row.from_email ?? "", name: row.from_name }, ...(row.to_recipients ?? []), ...(row.cc_recipients ?? [])];
    for (const entry of addresses) {
      const email = (entry.address ?? "").trim().toLowerCase();
      if (!email || own.has(email) || seen.has(email)) continue;
      seen.set(email, entry.name ?? null);
    }
  }
  const emails = [...seen.keys()].slice(0, 20);
  if (emails.length === 0) return [];
  const matched = await db.query<{
    email: string;
    id: string;
    name: string | null;
    job_title: string | null;
    company_id: string | null;
    company_name: string | null;
    deal_id: string | null;
    deal_name: string | null;
    deal_stage: string | null;
  }>(
    `select distinct on (lower(c.email)) lower(c.email) as email, c.id,
       nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') as name, c.job_title, c.company_id, co.name as company_name,
       deal.id as deal_id, deal.name as deal_name, deal.stage_name as deal_stage
     from crm.contacts c
     left join crm.companies co on co.id = c.company_id
     left join lateral (
       select o.id, o.name, s.name as stage_name from crm.opportunities o
       left join crm.pipeline_stages s on s.id = o.stage_id
       join crm.pipelines p on p.id = o.pipeline_id and p.kind = 'sales'
       where o.company_id = c.company_id and o.status = 'open' and o.archived_at is null
       order by o.updated_at desc limit 1
     ) deal on true
     where c.workspace_id = $1 and c.archived_at is null and lower(c.email) = any($2::text[])
     order by lower(c.email), c.updated_at desc`,
    [actor.workspaceId, emails],
  );
  const contacts = new Map(matched.rows.map((row) => [row.email, row]));
  const ordered = [...emails].sort((a, b) => Number(contacts.has(b)) - Number(contacts.has(a)));
  return ordered.slice(0, PEOPLE_MAX).map((email) => {
    const contact = contacts.get(email);
    return {
      email,
      name: contact?.name ?? seen.get(email) ?? null,
      contactId: contact?.id ?? null,
      title: contact?.job_title ?? null,
      companyId: contact?.company_id ?? null,
      companyName: contact?.company_name ?? null,
      dealId: contact?.deal_id ?? null,
      dealName: contact?.deal_name ?? null,
      dealStage: contact?.deal_stage ?? null,
    };
  });
}

async function readThread(actor: UserActor, key: string): Promise<ThreadDetail> {
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
      provider_message_id: string;
      opens: { at: string; agent: string | null }[] | null;
    }>(
      `select m.id, f.role, f.name as folder, src.email as account, m.subject, m.from_email, m.from_name, m.to_recipients, m.cc_recipients,
         coalesce(m.received_at, m.sent_at, m.created_at) as at, m.is_read, m.is_draft, m.is_flagged, m.has_attachments, m.snippet,
         m.body_html, m.body_text, m.web_link, m.provider_message_id,
         case when m.tracking_id is not null then (
           select coalesce(json_agg(json_build_object('at', o.opened_at, 'agent', o.agent) order by o.opened_at desc), '[]'::json)
           from crm.mail_opens o where o.tracking_id = m.tracking_id
         ) end as opens
       from crm.mail_messages m
       join crm.mail_folders f on f.id = m.folder_id
       join crm.mail_sources src on src.id = m.source_id
       where m.user_id = $1 and m.source_id = $2 and ${THREAD_KEY} = $3 and f.role not in ('junk', 'outbox')
       order by at asc, m.id asc
       limit 200`,
      [actor.userId, sourceId, tk],
    );
    if (result.rows.length === 0) throw new CrmError("not_found", "Conversation not found.", 404);
    const { drafts, providerIds } = await threadDrafts(db, actor, sourceId, tk);
    const rows = result.rows.filter((row) => !providerIds.includes(row.provider_message_id));
    const latest = rows[rows.length - 1] ?? result.rows[result.rows.length - 1];
    const target = rows.filter((row) => !(row.is_draft && row.role === "drafts")).at(-1);
    const prepared = target ? await preparedFor(db, actor, target.id) : null;
    const reminder = await db.query<{ id: string; due_at: Date | string; automatic: boolean }>(
      `select id, due_at, automatic from crm.mail_reminders
       where user_id = $1 and source_id = $2 and thread_key = $3 and kind = 'follow_up' and state = 'waiting'
       order by due_at limit 1`,
      [actor.userId, sourceId, tk],
    );
    const followUp = reminder.rows[0];
    const people = await threadPeople(db, actor, rows.length ? rows : result.rows);
    return {
      key,
      account: latest.account,
      subject: latest.subject,
      people,
      drafts,
      prepared,
      followUp: followUp ? { id: followUp.id, at: iso(followUp.due_at)!, automatic: followUp.automatic } : null,
      messages: rows.map((row) => {
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
          opens: row.opens ? row.opens.map((open) => ({ at: iso(open.at)!, agent: open.agent })) : null,
        };
      }),
    };
  });
}

async function splitCounts(db: Db, actor: UserActor) {
  const result = await db.query<{ source_id: string; split: MailSplit; total: number; unread: number }>(
    `with scoped as (
       select m.id, m.source_id, ${THREAD_KEY} as tk, m.subject, m.from_email, m.focused, m.is_read,
         coalesce(m.received_at, m.sent_at, m.created_at) as at
       from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
       where m.user_id = $1 and f.role = 'inbox'
     ),
     ranked as (
       select s.*, row_number() over (partition by s.source_id, s.tk order by s.at desc, s.id desc) as rn,
         bool_or(not s.is_read) over (partition by s.source_id, s.tk) as unread
       from scoped s
     ),
     listed as (
       select r.source_id, r.unread, ${splitCase("r", "$2")} as split
       from ranked r
       ${splitJoin("r", "$1")}
       where r.rn = 1
     )
     select source_id, split, count(*)::int as total, count(*) filter (where unread)::int as unread
     from listed group by source_id, split`,
    [actor.userId, actor.workspaceId],
  );
  return result.rows.map((row) => ({ sourceId: row.source_id, split: row.split, total: row.total, unread: row.unread }));
}

export async function mailNav(actor: UserActor): Promise<MailNav> {
  return withActor(actor, async (db) => {
    const accounts = await db.query<{ id: string; email: string; connected: boolean }>(
      `select s.id, s.email,
         coalesce(
           (select c.status = 'connected' and c.refresh_token is not null from crm.mailbox_connections c where c.id = s.connection_id),
           (select a.status = 'connected' and a.can_send and a.refresh_token is not null from crm.calendar_accounts a where a.id = s.account_id),
           false
         ) as connected
       from crm.mail_sources s where s.user_id = $1 order by s.connection_id is null, s.created_at`,
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
    const counts = await db.query<{ snoozed: number; scheduled: number }>(
      `select
         (select count(distinct (source_id, thread_key))::int from crm.mail_reminders where user_id = $1 and kind = 'snooze' and state = 'waiting') as snoozed,
         (select count(*)::int from crm.mail_drafts where user_id = $1 and (send_at is not null or send_error is not null)) as scheduled`,
      [actor.userId],
    );
    const inboxUnread = (sourceId: string | null) =>
      folders.rows.filter((folder) => folder.role === "inbox" && (!sourceId || folder.source_id === sourceId)).reduce((sum, folder) => sum + folder.unread, 0);
    return {
      accounts: accounts.rows.map((row) => ({ id: row.id, email: row.email, unread: inboxUnread(row.id), connected: row.connected })),
      folders: folders.rows.map((row) => ({ id: row.id, sourceId: row.source_id, name: row.name, role: row.role, unread: row.unread })),
      unread: inboxUnread(null),
      snoozed: counts.rows[0]?.snoozed ?? 0,
      scheduled: counts.rows[0]?.scheduled ?? 0,
      splits: await splitCounts(db, actor),
    };
  });
}

export async function mailUnreadCount(actor: UserActor) {
  return withActor(actor, async (db) =>
    (await splitCounts(db, actor)).filter((row) => row.split === "important").reduce((sum, row) => sum + row.unread, 0),
  );
}
