import { withActor } from "@/lib/crm/context";
import { FREE_MAIL_DOMAINS } from "@/lib/crm/communications";
import { CrmError } from "@/lib/crm/errors";
import { iso } from "@/lib/crm/mutate";
import { addWorkingDays, dayKeyAt, nonWorkingReason, shiftDay, wallClockAt } from "@/lib/crm/task-due";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { filingDomain, NOT_AUTOMATED, parseRouteKey, routedParams, routedSql } from "@/lib/mail/routing";
import { CALENDAR_SENDER, CALENDAR_SUBJECT, splitCase, splitJoin, UNSUBSCRIBE_TEXT } from "@/lib/mail/split";
import type { MailAddress } from "@/lib/mail/types";

const REPLY_LOOKBACK_DAYS = 30;
const REPLY_AFTER_WORKING_DAYS = 2;
const REPLY_LIMIT = 100;
const NUDGE_LIMIT = 50;
const CLOSED_ROLES = ["drafts", "outbox", "junk", "trash"];

export type WaitingReply = {
  kind: "reply";
  key: string;
  messageId: string;
  workspaceId: string;
  from: { name: string | null; email: string };
  company: string | null;
  subject: string | null;
  snippet: string | null;
  at: string;
  waitingDays: number;
  ready: boolean;
  arrivedAt: string;
};

export type WaitingNudge = {
  kind: "nudge";
  id: string;
  key: string;
  workspaceId: string;
  subject: string | null;
  to: MailAddress[];
  body: string;
  sentAt: string;
  opens: number;
  arrivedAt: string;
};

export function workingDaysSince(at: Date | string, now: Date) {
  const today = dayKeyAt(now);
  let count = 0;
  for (let key = shiftDay(dayKeyAt(new Date(at)), 1), guard = 0; key <= today && guard < 800; key = shiftDay(key, 1), guard += 1) {
    if (!nonWorkingReason(key)) count += 1;
  }
  return count;
}

function previousWorkingDay(key: string) {
  let next = key;
  for (let guard = 0; guard < 40 && nonWorkingReason(next); guard += 1) next = shiftDay(next, -1);
  return next;
}

export function workingDaysCutoff(now: Date, days: number) {
  let key = previousWorkingDay(dayKeyAt(now));
  for (let left = days - 1; left > 0; left -= 1) key = previousWorkingDay(shiftDay(key, -1));
  return new Date(wallClockAt(key, 0, 0));
}

export function replyArrival(at: Date | string) {
  return new Date(wallClockAt(addWorkingDays(dayKeyAt(new Date(at)), REPLY_AFTER_WORKING_DAYS), 0, 0)).toISOString();
}

type Placeable = { sourceId: string; key: string; counterpart: string | null; filedIn: string[] | null };

async function ownAddresses(db: Db, actor: UserActor) {
  const result = await db.query<{ email: string }>(
    "select lower(email) as email from crm.mail_sources where user_id = $1 union select lower(email) from crm.send_identities where user_id = $1",
    [actor.userId],
  );
  return new Set([...result.rows.map((row) => row.email), actor.email.toLowerCase()]);
}

async function placeThreads(db: Db, actor: UserActor, actors: UserActor[], threads: Placeable[]) {
  const ids = actors.map((item) => item.workspaceId);
  const placed = new Map<string, string>();
  const keyOf = (thread: Placeable) => `${thread.sourceId}|${thread.key}`;
  if (ids.length < 2) {
    for (const thread of threads) placed.set(keyOf(thread), actor.workspaceId);
    return placed;
  }
  const home = ids[0];
  const first = (list: string[] | null | undefined) => ids.find((id) => list?.includes(id)) ?? null;
  const own = await ownAddresses(db, actor);
  const rules = new Map(
    (
      await db.query<{ domain: string; workspace_ids: string[] }>("select domain, workspace_ids from crm.mail_domain_rules where user_id = $1", [actor.userId])
    ).rows.map((row) => [row.domain, row.workspace_ids]),
  );
  const open: Placeable[] = [];
  for (const thread of threads) {
    const domain = filingDomain(thread.counterpart, own);
    const chosen = first(thread.filedIn) ?? (domain ? first(rules.get(domain)) : null);
    if (chosen) placed.set(keyOf(thread), chosen);
    else open.push(thread);
  }
  if (open.length > 0) {
    const matched = await db.query<{ source_id: string; tk: string; workspace_id: string }>(
      `${routedSql("(m.source_id, coalesce(m.thread_key, 'm:' || m.id::text)) in (select * from unnest($6::uuid[], $7::text[]))")}
       select distinct x.source_id, x.tk, x.workspace_id from matched x`,
      routedParams(actor, ids, [open.map((thread) => thread.sourceId), open.map((thread) => thread.key)]),
    );
    const found = new Map<string, string[]>();
    for (const row of matched.rows) {
      const key = `${row.source_id}|${row.tk}`;
      found.set(key, [...(found.get(key) ?? []), row.workspace_id]);
    }
    for (const thread of open) placed.set(keyOf(thread), first(found.get(keyOf(thread))) ?? home);
  }
  return placed;
}

async function companyNames(db: Db, people: { email: string; workspaceId: string }[]) {
  if (people.length === 0) return new Map<string, string>();
  const emails = [...new Set(people.map((person) => person.email))];
  const workspaces = [...new Set(people.map((person) => person.workspaceId))];
  const domains = [...new Set(emails.map((email) => email.split("@")[1] ?? "").filter((domain) => domain && !FREE_MAIL_DOMAINS.has(domain)))];
  const result = await db.query<{ key: string; workspace_id: string; name: string; rank: number }>(
    `select c.normalized_email as key, c.workspace_id, co.name, 0 as rank
     from crm.contacts c join crm.companies co on co.id = c.company_id and co.archived_at is null
     where c.archived_at is null and c.normalized_email = any($1::text[]) and c.workspace_id = any($2::uuid[])
     union all
     select '@' || co.domain, co.workspace_id, co.name, 1
     from crm.companies co
     where co.archived_at is null and co.domain = any($3::text[]) and co.workspace_id = any($2::uuid[])
     order by rank`,
    [emails, workspaces, domains],
  );
  const names = new Map<string, string>();
  for (const row of result.rows) {
    const key = `${row.workspace_id}|${row.key}`;
    if (!names.has(key)) names.set(key, row.name);
  }
  return names;
}

type ReplyRow = {
  id: string;
  source_id: string;
  tk: string;
  subject: string | null;
  snippet: string | null;
  from_email: string;
  from_name: string | null;
  at: Date;
  filed_in: string[] | null;
  ready: boolean;
};

function repliesSql() {
  return `with own as (
      select lower(email) as email from crm.mail_sources where user_id = $1
      union select lower(email) from crm.send_identities where user_id = $1
      union select lower($2::text)
    ),
    candidates as materialized (
      select m.id, m.source_id, m.thread_key, coalesce(m.thread_key, 'm:' || m.id::text) as tk, m.subject, m.snippet,
        lower(m.from_email) as from_email, m.from_name, m.focused, m.received_at as at
      from crm.mail_messages m
      join crm.mail_folders f on f.id = m.folder_id
      where m.user_id = $1 and not m.is_draft and f.role = 'inbox'
        and m.received_at >= $3 and m.received_at < $4
        and nullif(m.from_email, '') is not null
        and lower(m.from_email) not in (select email from own)
        and ${NOT_AUTOMATED("lower(m.from_email)")}
        and coalesce(m.subject, '') !~* '${CALENDAR_SUBJECT}'
        and lower(m.from_email) !~* '${CALENDAR_SENDER}'
        and exists (
          select 1 from jsonb_array_elements(case when jsonb_typeof(m.to_recipients) = 'array' then m.to_recipients else '[]'::jsonb end) r
          where jsonb_typeof(r) = 'object' and lower(r->>'address') in (select email from own)
        )
    ),
    latest as (
      select n.* from candidates n
      where n.thread_key is null or not exists (
        select 1 from crm.mail_messages o join crm.mail_folders ofo on ofo.id = o.folder_id
        where o.source_id = n.source_id and o.thread_key = n.thread_key and o.id <> n.id and not o.is_draft
          and coalesce(o.received_at, o.sent_at, o.created_at) > n.at
          and (ofo.role <> all($5::text[]) or lower(coalesce(o.from_email, '')) in (select email from own))
      )
    )
    select n.id, n.source_id, n.tk, n.subject, n.snippet, n.from_email, n.from_name, n.at, rt.filed_in,
      exists (
        select 1 from crm.mail_prepared p
        where p.user_id = $1 and p.message_id = n.id and p.kind = 'reply' and p.state = 'ready' and p.body is not null
      ) as ready
    from latest n
    ${splitJoin("n", "$1")}
    left join crm.mail_thread_routes rt on rt.user_id = $1 and rt.source_id = n.source_id and rt.thread_key = n.tk
    where ${splitCase("n")} = 'important'
      and rt.ignored_at is null
      and not exists (
        select 1 from crm.capture_dismissals d
        where d.user_id = $1 and d.kind = 'reply' and d.source_id = n.source_id and d.thread_key = n.tk and d.message_at >= n.at
      )
      and not exists (
        select 1 from crm.mail_subscriptions ms
        where ms.user_id = $1 and (ms.sender = n.from_email or ms.sender = '@' || split_part(n.from_email, '@', 2))
          and (ms.status <> 'subscribed' or ms.cold_pitch_at is not null or ms.list_unsubscribe is not null)
      )
      and not exists (
        select 1 from crm.mail_prepared p
        where p.user_id = $1 and p.source_id = n.source_id and p.thread_key = n.tk and p.kind = 'pitch' and p.state = 'ready'
      )
      and not exists (
        select 1 from crm.mail_messages b where b.id = n.id and right(coalesce(b.body_text, ''), 4000) ~* '${UNSUBSCRIBE_TEXT}'
      )
    order by n.at asc
    limit $6`;
}

async function waitingRepliesInDb(db: Db, actor: UserActor, now: Date) {
  const result = await db.query<ReplyRow>(repliesSql(), [
    actor.userId,
    actor.email,
    new Date(now.getTime() - REPLY_LOOKBACK_DAYS * 86_400_000),
    workingDaysCutoff(now, REPLY_AFTER_WORKING_DAYS),
    CLOSED_ROLES,
    REPLY_LIMIT,
  ]);
  return result.rows;
}

type NudgeRow = {
  id: string;
  source_id: string;
  thread_key: string;
  body: string;
  updated_at: Date;
  subject: string | null;
  to_recipients: { name?: string | null; address?: string }[] | null;
  sent_at: Date;
  filed_in: string[] | null;
  opens: number;
};

async function readyNudgesInDb(db: Db, actor: UserActor) {
  const result = await db.query<NudgeRow>(
    `select p.id, p.source_id, p.thread_key, p.body, p.updated_at, m.subject, m.to_recipients,
       coalesce(m.sent_at, m.received_at, m.created_at) as sent_at, rt.filed_in,
       case when m.tracking_id is null then 0 else (select count(*)::int from crm.mail_opens o where o.tracking_id = m.tracking_id) end as opens
     from crm.mail_prepared p
     join crm.mail_messages m on m.id = p.message_id
     left join crm.mail_thread_routes rt on rt.user_id = $1 and rt.source_id = p.source_id and rt.thread_key = p.thread_key
     where p.user_id = $1 and p.kind = 'nudge' and p.state = 'ready' and p.body is not null
       and not exists (
         select 1 from crm.mail_messages o join crm.mail_folders ofo on ofo.id = o.folder_id
         where o.source_id = p.source_id and coalesce(o.thread_key, 'm:' || o.id::text) = p.thread_key and o.id <> m.id and not o.is_draft
           and ofo.role <> all($2::text[])
           and coalesce(o.received_at, o.sent_at, o.created_at) > coalesce(m.sent_at, m.received_at, m.created_at)
       )
     order by p.updated_at desc
     limit $3`,
    [actor.userId, CLOSED_ROLES, NUDGE_LIMIT],
  );
  return result.rows;
}

function addresses(value: NudgeRow["to_recipients"]): MailAddress[] {
  return (Array.isArray(value) ? value : [])
    .filter((entry) => typeof entry?.address === "string" && entry.address)
    .map((entry) => ({ name: entry.name?.trim() || null, address: entry.address!.toLowerCase() }));
}

export async function waitingMail(actor: UserActor, actors: UserActor[], now: Date) {
  return withActor(actor, async (db) => {
    const replyRows = await waitingRepliesInDb(db, actor, now);
    const nudgeRows = await readyNudgesInDb(db, actor);
    const replies = replyRows;
    const own = actors.length > 1 ? await ownAddresses(db, actor) : new Set<string>();
    const nudgeTo = nudgeRows.map((row) => addresses(row.to_recipients));
    const placed = await placeThreads(db, actor, actors, [
      ...replies.map((row) => ({ sourceId: row.source_id, key: row.tk, counterpart: row.from_email, filedIn: row.filed_in })),
      ...nudgeRows.map((row, index) => ({
        sourceId: row.source_id,
        key: row.thread_key,
        counterpart: nudgeTo[index].find((entry) => !own.has(entry.address))?.address ?? null,
        filedIn: row.filed_in,
      })),
    ]);
    const workspaceOf = (key: string) => placed.get(key) ?? actor.workspaceId;
    const names = await companyNames(
      db,
      replies.map((row) => ({ email: row.from_email, workspaceId: workspaceOf(`${row.source_id}|${row.tk}`) })),
    );
    const waitingReplies: WaitingReply[] = replies.map((row) => {
      const key = `${row.source_id}|${row.tk}`;
      const workspaceId = workspaceOf(key);
      const domain = row.from_email.split("@")[1] ?? "";
      return {
        kind: "reply",
        key,
        messageId: row.id,
        workspaceId,
        from: { name: row.from_name?.trim() || null, email: row.from_email },
        company: names.get(`${workspaceId}|${row.from_email}`) ?? names.get(`${workspaceId}|@${domain}`) ?? null,
        subject: row.subject,
        snippet: row.snippet,
        at: new Date(row.at).toISOString(),
        waitingDays: workingDaysSince(row.at, now),
        ready: row.ready,
        arrivedAt: replyArrival(row.at),
      };
    });
    const nudges: WaitingNudge[] = nudgeRows.map((row, index) => ({
      kind: "nudge",
      id: row.id,
      key: `${row.source_id}|${row.thread_key}`,
      workspaceId: workspaceOf(`${row.source_id}|${row.thread_key}`),
      subject: row.subject,
      to: nudgeTo[index],
      body: row.body,
      sentAt: new Date(row.sent_at).toISOString(),
      opens: row.opens,
      arrivedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    }));
    return { replies: waitingReplies, nudges };
  });
}

export async function dismissReply(actor: UserActor, thread: string, messageAt: string) {
  const { sourceId, key } = parseRouteKey(thread);
  const at = new Date(messageAt);
  if (Number.isNaN(at.getTime())) throw new CrmError("invalid_input", "That email has changed. Reload Capture and try again.", 400);
  await withActor(actor, async (db) => {
    const source = await db.query("select 1 from crm.mail_sources where id = $1 and user_id = $2", [sourceId, actor.userId]);
    if (!source.rowCount) throw new CrmError("not_found", "Conversation not found.", 404);
    await db.query(
      `insert into crm.capture_dismissals (workspace_id, user_id, kind, source_id, thread_key, message_at)
       values ($1, $2, 'reply', $3, $4, $5)
       on conflict (user_id, kind, source_id, thread_key) do update set message_at = greatest(crm.capture_dismissals.message_at, excluded.message_at)`,
      [actor.workspaceId, actor.userId, sourceId, key, at],
    );
  });
  return { key: thread };
}
