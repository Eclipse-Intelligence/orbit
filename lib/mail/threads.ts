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
import { opensSql, readsSql } from "@/lib/mail/tracking";
import { threadSubscription } from "@/lib/mail/subscriptions";
import { firstName } from "@/lib/mail/format";
import { replyAfterSql } from "@/lib/mail/follow-up-rules";
import { threadDeferral } from "@/lib/mail/deferrals";
import type { CachedSummary, MailNav, MailSplit, MailView, ThreadCursor, ThreadDetail, ThreadPerson, ThreadSummary } from "@/lib/mail/view";
import { workspaceActors } from "@/lib/crm/workspaces";
import { threadFilingInDb } from "@/lib/mail/routing";


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
  follow_up_at: Date | string | null;
};

const SCOPED_COLUMNS = `m.id, m.source_id, m.thread_key as tk, m.subject, m.snippet, m.from_email, m.from_name, m.to_recipients,
  m.is_read, m.is_flagged, m.has_attachments, (m.is_draft and f.role = 'drafts') as is_draft, coalesce(m.received_at, m.sent_at, m.created_at) as at,
  m.tracking_id, m.focused`;

export async function listThreads(
  actor: UserActor,
  input: { view?: MailView; sourceId?: string | null; query?: string; before?: ThreadCursor | null; limit?: number },
): Promise<{ threads: ThreadSummary[]; next: ThreadCursor | null }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.userId];
    const where = ["m.user_id = $1"];
    let split: MailSplit | null = null;
    let splitting = false;
    let inbox = false;
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
      inbox = role === "inbox";
      if (!inbox) {
        values.push(role);
        where.push(`f.role = $${values.length}`);
      }
    }
    if (input.sourceId) {
      if (!isUuid(input.sourceId)) return { threads: [], next: null };
      values.push(input.sourceId);
      where.push(`m.source_id = $${values.length}`);
    }
    const scoped = inbox
      ? `select ${SCOPED_COLUMNS} from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
         where ${where.join(" and ")} and f.role = 'inbox'
         union all
         select ${SCOPED_COLUMNS} from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
         where ${where.join(" and ")} and f.role not in ('inbox', 'trash', 'junk', 'outbox', 'drafts')
           and (m.source_id, m.thread_key) in (
             select rm.source_id, rm.thread_key from crm.mail_reminders rm
             where rm.user_id = $1 and rm.state = 'due' and rm.kind = 'follow_up'
           )`
      : `select ${SCOPED_COLUMNS} from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id where ${where.join(" and ")}`;
    const cursor: string[] = [];
    if (split) {
      values.push(split);
      cursor.push(`l.split = $${values.length}`);
    }
    if (input.before) {
      values.push(input.before.at, input.before.key);
      cursor.push(`(l.sort_at, l.source_id::text || '|' || l.tk) < ($${values.length - 1}::timestamptz, $${values.length})`);
    }
    values.push(actor.email);
    const emailParam = `$${values.length}`;
    values.push(limit + 1);
    const splitEarly = Boolean(split);
    const result = await db.query<ThreadRow>(
      `with scoped as (${scoped}),
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
       due as (
         select distinct on (rm.source_id, rm.thread_key) rm.source_id, rm.thread_key, rm.kind, rm.surfaced_at
         from crm.mail_reminders rm
         where rm.user_id = $1 and rm.state = 'due'
         order by rm.source_id, rm.thread_key, rm.surfaced_at desc
       ),
       listed as (
         select r.*, due.kind as reminder_kind, due.surfaced_at,
           greatest(r.at, coalesce(due.surfaced_at, r.at)) as sort_at,
           ${splitEarly ? splitCase("r") : "null::text"} as split
         from ranked r
         ${splitEarly ? splitJoin("r", "$1") : ""}
         left join due on due.source_id = r.source_id and due.thread_key = r.tk
         where r.rn = 1
       ),
       page as (
         select l.* from listed l
         ${cursor.length ? `where ${cursor.join(" and ")}` : ""}
         order by l.sort_at desc, l.source_id::text || '|' || l.tk desc
         limit $${values.length}
       )
       select l.source_id, l.tk, src.email as account, l.id, l.subject, l.snippet, l.from_email, l.from_name, l.to_recipients,
         l.n::int as n, l.unread, l.flagged, l.attachments, l.is_draft, l.at, l.sort_at, l.reminder_kind, l.surfaced_at, snz.until as snoozed_until,
         ${splitEarly ? "l.split" : splitting ? splitCase("l") : "null"} as split, fu.at as follow_up_at,
         ${readsSql("l")} as reads,
         exists (
           select 1 from crm.mail_prepared p
           where p.message_id = l.id and p.kind in ('reply', 'nudge') and p.state in ('ready', 'used')
         ) as prepared
       from page l
       join crm.mail_sources src on src.id = l.source_id
       ${!splitEarly && splitting ? splitJoin("l", "$1") : ""}
       left join lateral (
         select min(rm.due_at) as until from crm.mail_reminders rm
         where rm.user_id = $1 and rm.source_id = l.source_id and rm.thread_key = l.tk and rm.state = 'waiting' and rm.kind = 'snooze'
       ) snz on true
       left join lateral (
         select min(rm.due_at) as at from crm.mail_reminders rm
         where rm.user_id = $1 and rm.source_id = l.source_id and rm.thread_key = l.tk and rm.state = 'waiting'
           and rm.kind = 'follow_up' and rm.action = 'send'
           and not exists (${replyAfterSql("rm", "$1", emailParam)})
       ) fu on true
       order by l.sort_at desc, l.source_id::text || '|' || l.tk desc`,
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
      followUpAt: iso(row.follow_up_at),
    }));
    const lastRow = rows[rows.length - 1];
    return {
      threads,
      next: result.rows.length > limit && lastRow?.sort_at ? { at: iso(lastRow.sort_at)!, key: threadKey(lastRow.source_id, lastRow.tk) } : null,
    };
  });
}

export type ThreadOptions = { reader?: boolean };

const SHORT_SUMMARY = 280;

export async function getThread(actor: UserActor, key: string, options: ThreadOptions = {}): Promise<ThreadDetail> {
  const actors = workspaceActors(actor);
  actors.catch(() => null);
  const detail = await readThread(actor, key, actors, options);
  if (detail.prepared?.times) {
    detail.prepared = (await freshPrepared(actor, detail.prepared.id).catch(() => null)) ?? detail.prepared;
  }
  return detail;
}

const PEOPLE_MAX = 4;

async function threadPeople(
  db: Db,
  actor: UserActor,
  actors: UserActor[],
  rows: { from_email: string | null; from_name: string | null; to_recipients: MailAddress[]; cc_recipients: MailAddress[] }[],
  own: Set<string>,
): Promise<ThreadPerson[]> {
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
    workspace_id: string;
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
    `select distinct on (c.workspace_id, lower(c.email)) c.workspace_id, lower(c.email) as email, c.id,
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
     where c.workspace_id = any($1::uuid[]) and c.archived_at is null and lower(c.email) = any($2::text[])
     order by c.workspace_id, lower(c.email), c.updated_at desc`,
    [actors.map((item) => item.workspaceId), emails],
  );
  const contacts = new Map(matched.rows.filter((row) => row.workspace_id === actor.workspaceId).map((row) => [row.email, row]));
  const elsewhere = new Map<string, { id: string; name: string }[]>();
  for (const item of actors) {
    if (item.workspaceId === actor.workspaceId) continue;
    for (const row of matched.rows) {
      if (row.workspace_id !== item.workspaceId || contacts.has(row.email)) continue;
      elsewhere.set(row.email, [...(elsewhere.get(row.email) ?? []), { id: item.workspaceId, name: item.workspaceName }]);
    }
  }
  const outside = new Map(matched.rows.filter((row) => row.workspace_id !== actor.workspaceId).map((row) => [row.email, row]));
  const rank = (email: string) => (contacts.has(email) ? 2 : elsewhere.has(email) ? 1 : 0);
  const ordered = [...emails].sort((a, b) => rank(b) - rank(a));
  return ordered.slice(0, PEOPLE_MAX).map((email) => {
    const contact = contacts.get(email);
    const other = outside.get(email);
    const person: ThreadPerson = {
      email,
      name: contact?.name ?? other?.name ?? seen.get(email) ?? null,
      contactId: contact?.id ?? null,
      title: contact?.job_title ?? other?.job_title ?? null,
      companyId: contact?.company_id ?? null,
      companyName: contact?.company_name ?? other?.company_name ?? null,
      dealId: contact?.deal_id ?? null,
      dealName: contact?.deal_name ?? null,
      dealStage: contact?.deal_stage ?? null,
    };
    const places = elsewhere.get(email);
    return places ? { ...person, elsewhere: places } : person;
  });
}

async function readThread(actor: UserActor, key: string, actorsReady: Promise<UserActor[]>, options: ThreadOptions) {
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
         ${opensSql("m")} as opens
       from crm.mail_messages m
       join crm.mail_folders f on f.id = m.folder_id
       join crm.mail_sources src on src.id = m.source_id
       where m.user_id = $1 and m.source_id = $2 and m.thread_key = $3 and f.role <> 'outbox'
         and (f.role <> 'junk' or not exists (
           select 1 from crm.mail_messages o join crm.mail_folders ofo on ofo.id = o.folder_id
           where o.user_id = m.user_id and o.source_id = m.source_id and o.thread_key = $3
             and ofo.role not in ('junk', 'outbox')
         ))
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
    const reminder = await db.query<{
      id: string;
      due_at: Date | string;
      automatic: boolean;
      action: "remind" | "send";
      follow_up_body: string | null;
      recipients: { to?: MailAddress[] } | null;
    }>(
      `select id, due_at, automatic, action, follow_up_body, recipients from crm.mail_reminders
       where user_id = $1 and source_id = $2 and thread_key = $3 and kind = 'follow_up' and state = 'waiting' and not deferral
       order by action = 'send' desc, due_at limit 1`,
      [actor.userId, sourceId, tk],
    );
    const replied = await db.query<{ reminder_id: string; id: string; from_name: string | null; from_email: string | null }>(
      `with newest as (
         select * from crm.mail_reminders
         where user_id = $1 and source_id = $2 and thread_key = $3 and kind = 'follow_up' and action = 'send'
         order by created_at desc, id desc limit 1
       )
       select r.id as reminder_id, x.id, x.from_name, x.from_email from newest r
       cross join lateral (${replyAfterSql("r", "$1", "$4")} limit 1) x
       where r.state in ('waiting', 'replied')
         and not exists (
           select 1 from crm.mail_reminders o
           where o.user_id = $1 and o.source_id = $2 and o.thread_key = $3 and o.kind = 'follow_up' and o.state = 'waiting'
             and not o.deferral and o.id <> r.id
         )`,
      [actor.userId, sourceId, tk, actor.email],
    );
    const reply = replied.rows[0] ?? null;
    const followUp = reminder.rows[0] && !(reply && reply.reminder_id === reminder.rows[0].id) ? reminder.rows[0] : undefined;
    const deferral = await threadDeferral(db, actor, sourceId, tk);
    const addresses = (
      await db.query<{ email: string }>(
        "select lower(email) as email from crm.mail_sources where user_id = $1 union select lower(email) from crm.send_identities where user_id = $1",
        [actor.userId],
      )
    ).rows.map((row) => row.email);
    const actors = await actorsReady;
    const people = await threadPeople(db, actor, actors, rows.length ? rows : result.rows, new Set(addresses));
    const own = new Set([...addresses, actor.email.toLowerCase()]);
    const fromThem = rows.filter((row) => row.from_email && !own.has(row.from_email.toLowerCase()));
    const sender = fromThem.at(-1)?.from_email ?? null;
    const deferredOn =
      deferral && !rows.some((row) => row.id === deferral.messageId)
        ? { ...deferral, messageId: fromThem.filter((row) => !row.is_draft).at(-1)?.id ?? target?.id ?? deferral.messageId }
        : deferral;
    const subscription = await threadSubscription(db, actor, sender);
    const filing = await threadFilingInDb(db, actor, actors, sourceId, tk, {
      latestId: (fromThem.at(-1) ?? latest).id,
      counterpart: sender ?? people[0]?.email ?? null,
      own,
    });
    const cachedSummary = options.reader && target ? await readerSummary(db, sourceId, tk, target.id, rows) : undefined;
    const detail: ThreadDetail = {
      subscription,
      filing,
      key,
      account: latest.account,
      subject: latest.subject,
      people,
      drafts,
      prepared,
      followUp: followUp
        ? {
            id: followUp.id,
            at: iso(followUp.due_at)!,
            automatic: followUp.automatic,
            action: followUp.action,
            body: followUp.action === "send" ? followUp.follow_up_body : null,
            to: followUp.action === "send" ? (followUp.recipients?.to ?? []) : [],
          }
        : null,
      followUpReplied: reply ? { name: firstName(reply.from_email ? { address: reply.from_email, name: reply.from_name } : null), messageId: reply.id } : null,
      deferral: deferredOn,
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
          text: options.reader && html && !row.is_draft ? null : row.body_text,
          webLink: row.web_link,
          opens: row.opens ? row.opens.map((open) => ({ at: iso(open.at)!, agent: open.agent })) : null,
        };
      }),
      ...(cachedSummary !== undefined ? { cachedSummary } : {}),
    };
    return detail;
  });
}

async function readerSummary(
  db: Db,
  sourceId: string,
  tk: string,
  latestId: string,
  rows: { id: string; is_draft: boolean; body_text: string | null; snippet: string | null; has_attachments: boolean }[],
): Promise<CachedSummary | null> {
  if (!process.env.LLM_API_KEY?.trim()) return { latestId, summary: null, todo: null };
  const sent = rows.filter((row) => !row.is_draft);
  if (sent.length === 1 && !sent[0].has_attachments && (sent[0].body_text ?? sent[0].snippet ?? "").length < SHORT_SUMMARY) {
    return { latestId, summary: null, todo: null };
  }
  const stored = await db.query<{ summary: string; todo: string | null }>(
    "select summary, todo from crm.mail_summaries where source_id = $1 and thread_key = $2 and latest_message_id = $3 limit 1",
    [sourceId, tk, latestId],
  );
  const row = stored.rows[0];
  return row ? { latestId, summary: row.summary, todo: row.todo } : null;
}

async function splitCounts(db: Db, actor: UserActor, unreadOnly = false) {
  const inbox = "m.user_id = $1 and f.role = 'inbox'";
  const result = await db.query<{ source_id: string; split: MailSplit; total: number; unread: number }>(
    `with scoped as (
       select m.id, m.source_id, m.thread_key as tk, m.subject, m.from_email, m.focused, m.is_read,
         coalesce(m.received_at, m.sent_at, m.created_at) as at
       from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
       where ${inbox}
         ${
           unreadOnly
             ? `and (m.source_id, m.thread_key) in (
                  select m.source_id, m.thread_key from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
                  where ${inbox} and not m.is_read
                )`
             : ""
         }
     ),
     ranked as (
       select s.*, row_number() over (partition by s.source_id, s.tk order by s.at desc, s.id desc) as rn,
         bool_or(not s.is_read) over (partition by s.source_id, s.tk) as unread
       from scoped s
     ),
     listed as (
       select r.source_id, r.unread, ${splitCase("r")} as split
       from ranked r
       ${splitJoin("r", "$1")}
       where r.rn = 1
     )
     select source_id, split, count(*)::int as total, count(*) filter (where unread)::int as unread
     from listed group by source_id, split`,
    [actor.userId],
  );
  return result.rows.map((row) => ({ sourceId: row.source_id, split: row.split, total: row.total, unread: row.unread }));
}

async function readVersion(db: Db, actor: UserActor) {
  const result = await db.query<{ version: string }>("select version::text as version from crm.mail_versions where user_id = $1", [actor.userId]);
  return result.rows[0]?.version ?? "0";
}

export async function mailVersion(actor: UserActor) {
  return withActor(actor, (db) => readVersion(db, actor));
}

export async function mailNav(actor: UserActor): Promise<MailNav> {
  return withActor(actor, async (db) => {
    const version = await readVersion(db, actor);
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
         (select count(distinct m.thread_key)::int from crm.mail_messages m where m.folder_id = f.id and not m.is_read) as unread
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
      version,
    };
  });
}

export async function mailUnreadCount(actor: UserActor) {
  return withActor(actor, async (db) =>
    (await splitCounts(db, actor, true)).filter((row) => row.split === "important").reduce((sum, row) => sum + row.unread, 0),
  );
}

