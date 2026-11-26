import { createEmailActivityOnce, emailActivityFor } from "@/lib/crm/activities";
import { dismissActivityContactsInDb, linkEmailPeopleInDb, removedActivityContactIds } from "@/lib/crm/activity-contacts";
import { companyHasOpenTask, createFollowUpUnlessOpen, isRecent } from "@/lib/crm/communications";
import { withActor } from "@/lib/crm/context";
import { recordAudit } from "@/lib/crm/mutate";
import { hasScope } from "@/lib/crm/scopes";
import { scheduleTaskDue, withDueNote } from "@/lib/crm/task-due";
import { MAIL_SUGGESTION_NOTE } from "@/lib/crm/suggested-task";
import { createTaskInDb } from "@/lib/crm/tasks";
import { emailPeopleInDb } from "@/lib/mail/email-people";
import { followUpTitle } from "@/lib/mail/follow-up-title";
import type { UserActor } from "@/lib/crm/types";
import { workspaceActors } from "@/lib/crm/workspaces";
import type { Db } from "@/lib/db/pool";
import { stripQuoted } from "@/lib/mail/format";
import { mailWorthATask } from "@/lib/mail/task-gate";
import { addressHomesInDb, captureWorkspaces, contactElsewhere, ensureContactInDb, NOT_AUTOMATED, routedParams, routedSql } from "@/lib/mail/routing";

const WINDOW_DAYS = 60;
export const RECENT_FILING_DAYS = 2;
const BATCH = 100;
const FRESH_MS = 24 * 3_600_000;

type Candidate = {
  message_id: string;
  internet_message_id: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  at: Date;
  account: string;
  folder_role: string;
  workspace_id: string;
  contact_id: string | null;
  company_id: string | null;
  address: string;
  direction: "inbound" | "outbound";
  attachments: boolean;
};

type RuledSender = { message_id: string; address: string; from_name: string | null; workspace_id: string };

export type MailFilter = { thread?: { sourceId: string; key: string }; messageIds?: string[] };

function bodyOf(row: Pick<Candidate, "body_text" | "snippet">) {
  const text = row.body_text ? stripQuoted(row.body_text) : "";
  return (text || row.snippet?.trim() || "").slice(0, 4000) || null;
}

export function mailFilter(filter: MailFilter, now: number, days: number) {
  if (filter.thread) {
    return { sql: "m.source_id = $6 and m.thread_key = $7", params: [filter.thread.sourceId, filter.thread.key] };
  }
  if (filter.messageIds) return { sql: "m.id = any($6::uuid[])", params: [filter.messageIds] };
  return {
    sql: "coalesce(m.sent_at, m.received_at, m.created_at) > to_timestamp($6::double precision / 1000) - make_interval(days => $7)",
    params: [now, days],
  };
}

async function ruledSenders(db: Db, actor: UserActor, workspaceIds: string[], filter: { sql: string; params: unknown[] }) {
  const result = await db.query<RuledSender>(
    `${routedSql(filter.sql)}
     select distinct on (t.id, w.id) t.id as message_id, t.address, m.from_name, w.id as workspace_id
     from targeted t
     join crm.mail_messages m on m.id = t.id
     cross join lateral unnest(t.ruled) as w(id)
     where t.chosen is null and t.route_contact is null and t.ruled is not null and t.direction = 'inbound'
       and t.at >= t.ruled_at - interval '5 minutes'
       and w.id = any($3::uuid[])
       and ${NOT_AUTOMATED("t.address")}
       and not exists (
         select 1 from crm.mail_subscriptions ms
         where ms.user_id = $1 and (ms.sender = t.address or ms.sender = '@' || split_part(t.address, '@', 2))
           and (ms.status <> 'subscribed' or ms.cold_pitch_at is not null)
       )
       and not exists (select 1 from matched x where x.id = t.id and x.workspace_id = w.id)
     order by t.id, w.id
     limit 50`,
    routedParams(actor, workspaceIds, filter.params),
  );
  return result.rows;
}

const LOGGED_AT_SEND = `a.metadata->>'mailMessageId' is null and a.metadata->>'internetMessageId' is null
  and (a.metadata->>'direction' = 'outbound') = (x.direction = 'outbound')
  and a.title = left(coalesce(nullif(trim(x.subject), ''), '(no subject)'), 200)
  and abs(extract(epoch from a.occurred_at - x.at)) < 180`;

const SAME_MESSAGE = `(a.metadata->>'mailMessageId' = x.id::text or (x.internet_message_id is not null and a.metadata->>'internetMessageId' = x.internet_message_id))`;

const SENT_POSITION = `(
  select min(e.ord) from jsonb_array_elements(coalesce(x.to_recipients, '[]'::jsonb) || coalesce(x.cc_recipients, '[]'::jsonb)) with ordinality as e(p, ord)
  where jsonb_typeof(e.p) = 'object' and lower(e.p->>'address') = x.address
)`;

async function candidates(db: Db, actor: UserActor, workspaceIds: string[], filter: { sql: string; params: unknown[] }, limit: number) {
  const limitParam = `$${6 + filter.params.length}`;
  const result = await db.query<Candidate>(
    `${routedSql(filter.sql)},
     company_logged as materialized (
       select a.metadata->>'mailMessageId' as mail_id, a.metadata->>'internetMessageId' as internet_id, a.workspace_id
       from crm.activities a
       where a.type = 'email' and a.workspace_id = any($3::uuid[])
         and exists (select 1 from matched m where m.contact_id is null)
     )
     select picked.*, (select b.body_text from crm.mail_messages b where b.id = picked.message_id) as body_text
     from (
     select distinct on (x.id, x.workspace_id, case when x.contact_id is null then x.company_id end)
       x.id as message_id, x.internet_message_id, x.subject, x.snippet, x.at, x.account, x.folder_role,
       x.workspace_id, x.contact_id, x.company_id, x.address, x.direction, x.has_attachments as attachments
     from matched x
     where (
       x.contact_id is not null and not exists (
         select 1 from crm.activities a
         join (
           select s.activity_id, s.contact_id from crm.activity_contacts s
           union all select d.activity_id, d.contact_id from crm.activity_contact_dismissals d
             where d.kind = 'removed' or (d.kind = 'skipped' and d.user_id = $1)
         ) l on l.activity_id = a.id and l.contact_id = x.contact_id
         where a.workspace_id = x.workspace_id and a.type = 'email'
           and (${SAME_MESSAGE} or (${LOGGED_AT_SEND} and a.contact_id in (
             select y.contact_id from matched y where y.id = x.id and y.workspace_id = x.workspace_id and y.contact_id is not null
           )))
       )
     ) or (
       x.contact_id is null
       and not exists (select 1 from company_logged l where l.mail_id = x.id::text and l.workspace_id = x.workspace_id)
       and not (x.internet_message_id is not null and exists (
         select 1 from company_logged l where l.internet_id = x.internet_message_id and l.workspace_id = x.workspace_id
       ))
       and not exists (
         select 1 from crm.activities a
         where a.company_id = x.company_id and a.contact_id is null and a.workspace_id = x.workspace_id and a.type = 'email' and ${LOGGED_AT_SEND}
       )
     )
     order by x.id, x.workspace_id, case when x.contact_id is null then x.company_id end, x.contact_id is null,
       case when x.direction = 'outbound' then ${SENT_POSITION} end, x.at desc
     limit ${limitParam}
     ) picked`,
    routedParams(actor, workspaceIds, [...filter.params, limit]),
  );
  return result.rows;
}

type Existing = { id: string; contact_id: string | null; company_id: string | null; archived_contact_email: string | null; archived_at: Date | null };

async function existingActivity(db: Db, workspaceId: string, row: Candidate, contactIds: string[]) {
  const byMessage = await emailActivityFor(db, workspaceId, { internetMessageId: row.internet_message_id, mailMessageId: row.message_id }, null);
  const found = await db.query<Existing>(
    `select a.id, a.contact_id, a.company_id, a.archived_at, case when ac.archived_at is not null then ac.normalized_email end as archived_contact_email
     from crm.activities a
     left join crm.contacts ac on ac.id = a.contact_id
     where a.workspace_id = $1 and a.type = 'email'
       and (
         a.id = $2
         or (
           a.metadata->>'mailMessageId' is null and a.metadata->>'internetMessageId' is null
           and (a.metadata->>'direction' = 'outbound') = ($3 = 'outbound')
           and a.title = left(coalesce(nullif(trim($4::text), ''), '(no subject)'), 200)
           and abs(extract(epoch from a.occurred_at - $5::timestamptz)) < 180
           and (a.contact_id = any($6::uuid[]) or (a.contact_id is null and a.company_id = $7))
         )
       )
     order by (a.id = $2) desc, a.archived_at is not null, a.created_at
     limit 1`,
    [workspaceId, byMessage, row.direction, row.subject, new Date(row.at).toISOString(), contactIds, row.company_id],
  );
  return found.rows[0] ?? null;
}

async function relinkActivity(db: Db, actor: UserActor, existing: Existing, mainId: string, row: Candidate) {
  const before = await db.query<{ contact_id: string | null; company_id: string | null }>(
    "select contact_id, company_id from crm.activities where id = $1 and workspace_id = $2 for update",
    [existing.id, actor.workspaceId],
  );
  const current = before.rows[0];
  if (!current) return false;
  const companyId = current.company_id ?? row.company_id;
  const updated = await db.query("update crm.activities set contact_id = $3, company_id = $4 where id = $1 and workspace_id = $2", [
    existing.id,
    actor.workspaceId,
    mainId,
    companyId,
  ]);
  if (!updated.rowCount) return false;
  const fields = ["contactId", ...(companyId !== current.company_id ? ["companyId"] : [])];
  await recordAudit(db, actor, "activity.updated", "activity", existing.id, { operation: "relink_mail", source: "microsoft" }, {
    fields,
    before: { contactId: current.contact_id, ...(fields.includes("companyId") ? { companyId: current.company_id } : {}) },
    after: { contactId: mainId, ...(fields.includes("companyId") ? { companyId } : {}) },
  });
  return true;
}

async function needsFollowUp(actor: UserActor, row: Candidate, at: Date) {
  if (!row.company_id || row.direction !== "inbound" || row.folder_role !== "inbox") return false;
  if (!isRecent(at.toISOString()) || !hasScope(actor.scopes, "tasks:write")) return false;
  return !(await companyHasOpenTask(actor.workspaceId, row.company_id));
}

async function followUpWho(db: Db, row: Candidate) {
  const names = await db.query<{ contact: string | null; company: string | null }>(
    `select (select coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email) from crm.contacts c where c.id = $1) as contact,
       (select co.name from crm.companies co where co.id = $2) as company`,
    [row.contact_id, row.company_id],
  );
  return names.rows[0]?.contact || names.rows[0]?.company || "them";
}

async function suggestFollowUp(actor: UserActor, row: Candidate, title: string) {
  const companyId = row.company_id;
  if (!companyId) return null;
  const due = await scheduleTaskDue(actor, { days: 2 });
  const task = await createFollowUpUnlessOpen(actor, companyId, async (db) => {
    const thread = await db.query<{ source_id: string; thread_key: string | null }>(
      "select source_id, thread_key from crm.mail_messages where id = $1",
      [row.message_id],
    );
    const mail = thread.rows[0];
    return createTaskInDb(
      db,
      actor,
      {
        title: title.slice(0, 200),
        description: withDueNote(MAIL_SUGGESTION_NOTE, due),
        mailThreadKey: mail?.thread_key ? `${mail.source_id}|${mail.thread_key}` : null,
        dueDate: due?.dueDate ?? null,
        companyId,
        contactId: row.contact_id,
        priority: "normal",
      },
      { operation: "suggest_follow_up", source: "microsoft" },
      { ownThread: true },
    );
  });
  return task?.id ?? null;
}

async function sendFollowUpsToClickUp(actor: UserActor, taskIds: string[]) {
  if (taskIds.length === 0) return;
  const { sendTaskToDefaultList } = await import("@/lib/crm/clickup");
  for (const taskId of taskIds) {
    try {
      await sendTaskToDefaultList(actor, taskId);
    } catch (error) {
      console.error("Could not send the follow-up task to ClickUp", error);
    }
  }
}

const COLLEAGUE_SQL = `exists (
           select 1 from crm.workspace_members w
           join crm.profiles p on p.id = w.user_id
           where w.user_id <> $1
             and w.workspace_id in (select o.workspace_id from crm.workspace_members o where o.user_id = $1)
             and (lower(p.email) = lower(m.from_email) or lower(m.from_email) = any (select lower(o) from unnest(coalesce(p.other_emails, '{}')) as o))
         )`;

type OwnDomainThread = { colleague: boolean; id: string; source_id: string; thread_key: string; address: string; from_name: string | null; subject: string | null; snippet: string | null; body_text: string | null; at: Date };

async function ownDomainAndColleagueThreads(db: Db, actor: UserActor, workspaceIds: string[], filter: { sql: string; params: unknown[] }) {
  const result = await db.query<OwnDomainThread>(
    `select * from (
     select distinct on (m.source_id, m.thread_key) m.id, m.source_id, m.thread_key, lower(m.from_email) as address, ${COLLEAGUE_SQL} as colleague, m.from_name, m.subject, m.snippet, m.body_text,
       coalesce(m.sent_at, m.received_at, m.created_at) as at
     from crm.mail_messages m
     join crm.mail_folders f on f.id = m.folder_id
     where m.user_id = $1 and not m.is_draft and f.role = 'inbox' and f.role <> all($5::text[]) and cardinality($3::uuid[]) > 0 and (${filter.sql})
       and m.thread_key is not null and m.from_email is not null
       and lower(m.from_email) <> lower($2::text)
       and ${NOT_AUTOMATED("lower(m.from_email)")}
       and (
         (split_part(lower(m.from_email), '@', 2) <> all($4::text[]) and split_part(lower(m.from_email), '@', 2) in (
           select d.domain from crm.workspace_brands b
           cross join lateral unnest(b.own_domains) as d(domain)
           where b.workspace_id in (select w.workspace_id from crm.workspace_members w where w.user_id = $1)
         ))
         or ${COLLEAGUE_SQL}
       )
       and not exists (select 1 from crm.mail_sources s where s.user_id = $1 and lower(s.email) = lower(m.from_email))
       and not exists (select 1 from crm.send_identities i where i.user_id = $1 and lower(i.email) = lower(m.from_email))
       and coalesce(m.sent_at, m.received_at, m.created_at) > now() - interval '48 hours'
       and not exists (select 1 from crm.tasks t where t.mail_thread_key = m.source_id::text || '|' || m.thread_key)
       and not exists (
         select 1 from crm.mail_thread_relevance r
         where r.user_id = $1 and r.source_id = m.source_id and r.thread_key = m.thread_key and r.message_id = m.id
           and r.category is not null and r.category <> 'business'
       )
       and not exists (select 1 from crm.mail_task_judgements j where j.user_id = $1 and j.message_id = m.id and not j.worth)
     order by m.source_id, m.thread_key, coalesce(m.sent_at, m.received_at, m.created_at) desc
     ) newest
     order by newest.at desc
     limit 20`,
    routedParams(actor, workspaceIds, filter.params),
  );
  const homes = await addressHomesInDb(db, actor);
  const where = await captureWorkspaces(db, actor, homes, workspaceIds, result.rows.map((row) => row.id));
  return result.rows.map((row) => ({ row, workspaceId: where.get(row.id) ?? null }));
}

async function suggestForOwnDomainsAndColleagues(
  actor: UserActor,
  workspaceIds: string[],
  byWorkspace: Map<string, UserActor>,
  filter: { sql: string; params: unknown[] },
  options: { fetchImpl?: typeof fetch; deadline?: number; titleTimeoutMs?: number },
) {
  const created = new Map<string, string[]>();
  const found = await withActor(actor, (db) => ownDomainAndColleagueThreads(db, actor, workspaceIds, filter));
  for (const { row, workspaceId } of found) {
    const target = workspaceId ? byWorkspace.get(workspaceId) : null;
    if (!target || !hasScope(target.scopes, "tasks:write") || !isRecent(new Date(row.at).toISOString())) continue;
    try {
      const gate = { fetchImpl: options.fetchImpl, deadline: options.deadline, timeoutMs: options.titleTimeoutMs, colleague: row.colleague };
      if (!(await mailWorthATask(target, row.id, gate))) continue;
      const title = await followUpTitle(
        { who: row.from_name?.trim() || row.address, subject: row.subject, text: bodyOf({ body_text: row.body_text, snippet: row.snippet }) },
        { fetchImpl: options.fetchImpl, deadline: options.deadline, timeoutMs: options.titleTimeoutMs },
      );
      const due = await scheduleTaskDue(target, { days: 2 });
      const key = `${row.source_id}|${row.thread_key}`;
      const taskId = await withActor(target, async (db) => {
        await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`own-domain-task:${key}`]);
        const existing = await db.query("select 1 from crm.tasks where mail_thread_key = $1 limit 1", [key]);
        if (existing.rowCount) return null;
        const task = await createTaskInDb(
          db,
          target,
          {
            title: title.slice(0, 200),
            description: withDueNote(MAIL_SUGGESTION_NOTE, due),
            mailThreadKey: key,
            dueDate: due?.dueDate ?? null,
            companyId: null,
            contactId: null,
            opportunityId: null,
            priority: "normal",
          },
          { operation: "suggest_follow_up", source: "microsoft" },
          { ownThread: true },
        );
        return task.id;
      });
      if (taskId) created.set(target.workspaceId, [...(created.get(target.workspaceId) ?? []), taskId]);
    } catch (error) {
      console.error("Suggesting a task for mail from your own domain failed", error);
    }
  }
  return created;
}

export async function fileMailOnTimeline(
  actor: UserActor,
  options: { days?: number; limit?: number; now?: number; filter?: MailFilter; actors?: UserActor[]; fetchImpl?: typeof fetch; deadline?: number; titleTimeoutMs?: number } = {},
) {
  const now = options.now ?? Date.now();
  const actors = options.actors ?? (await workspaceActors(actor));
  const workspaceIds = actors.map((item) => item.workspaceId);
  const filter = mailFilter(options.filter ?? {}, now, options.days ?? WINDOW_DAYS);
  const byWorkspace = new Map(actors.map((item) => [item.workspaceId, item]));

  const ruled = await withActor(actor, (db) => ruledSenders(db, actor, workspaceIds, filter));
  for (const sender of ruled) {
    const target = byWorkspace.get(sender.workspace_id);
    if (!target || !hasScope(target.scopes, "contacts:write")) continue;
    try {
      await withActor(target, async (db) => {
        const copy = await contactElsewhere(db, sender.address, workspaceIds, target.workspaceId);
        await ensureContactInDb(db, target, { email: sender.address, name: sender.from_name }, copy, { operation: "mail_domain_rule", source: "mail" });
      });
    } catch (error) {
      console.error("Adding a contact from a domain rule failed", error instanceof Error ? error.message : error);
    }
  }

  const rows = await withActor(actor, (db) => candidates(db, actor, workspaceIds, filter, options.limit ?? BATCH));
  let filed = 0;
  const followUps = new Map<string, string[]>();
  for (const row of rows.sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime())) {
    const target = byWorkspace.get(row.workspace_id);
    if (!target) continue;
    const at = new Date(row.at);
    try {
      const followUp = await needsFollowUp(target, row, at);
      const outcome = await withActor(target, async (db) => {
        const provenance = { operation: "file_mail", source: "microsoft", catchUp: now - at.getTime() > FRESH_MS };
        await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `email-activity|${target.workspaceId}|${row.internet_message_id || row.message_id}`,
        ]);
        const { people, routed } = await emailPeopleInDb(db, target, row.message_id, row.direction);
        let main: string | null;
        let companyId = row.company_id;
        let sentTo = row.address;
        if (row.direction === "outbound") {
          const first = people[0];
          main = first?.id ?? row.contact_id;
          if (first && first.id !== row.contact_id) {
            companyId = first.companyId ?? row.company_id;
            sentTo = first.email;
          }
        } else {
          main = row.contact_id ?? people.find((person) => !person.companyId || person.companyId === row.company_id)?.id ?? null;
        }
        const contactIds = [...new Set([...(main ? [main] : []), ...people.map((person) => person.id)])];
        const skip = (activityId: string, ids: string[]) => dismissActivityContactsInDb(db, target.workspaceId, activityId, ids, target.userId);
        const settle = (activityId: string) =>
          skip(activityId, [...routed, ...(row.contact_id ? [row.contact_id] : [])].filter((id) => !contactIds.includes(id)));
        const found = await existingActivity(db, target.workspaceId, row, contactIds);
        if (found?.archived_at) {
          await skip(found.id, [...routed, ...contactIds]);
          return { created: false, who: null };
        }
        if (found) {
          const replacement = found.archived_contact_email
            ? (
                await db.query<{ id: string }>(
                  "select id from crm.contacts where workspace_id = $1 and archived_at is null and normalized_email = $2 limit 1",
                  [target.workspaceId, found.archived_contact_email],
                )
              ).rows[0]?.id ?? null
            : null;
          const removed = await removedActivityContactIds(db, found.id);
          const candidate = found.contact_id === null ? main : replacement;
          const newMain = candidate && !removed.has(candidate) ? candidate : null;
          if (newMain) await relinkActivity(db, target, found, newMain, row);
          await linkEmailPeopleInDb(db, target, found.id, contactIds, provenance);
          await settle(found.id);
          return { created: false, who: null };
        }
        const saved = await createEmailActivityOnce(
          db,
          target,
          {
            type: "email",
            title: (row.subject?.trim() || "(no subject)").slice(0, 200),
            body: bodyOf(row),
            occurredAt: at.toISOString(),
            companyId,
            contactId: main,
            metadata: {
              source: "microsoft",
              direction: row.direction,
              ...(row.direction === "inbound" ? { from: row.address } : { from: row.account, to: sentTo }),
              account: row.account,
              mailMessageId: row.message_id,
              ...(row.internet_message_id ? { internetMessageId: row.internet_message_id } : {}),
              ...(row.attachments ? { hasAttachments: true } : {}),
            },
          },
          { mailMessageId: row.message_id, internetMessageId: row.internet_message_id },
          provenance,
          { contactIds },
        );
        await settle(saved.id);
        return { created: saved.created, who: saved.created && followUp ? await followUpWho(db, row) : null };
      });
      if (!outcome.created) continue;
      filed += 1;
      if (outcome.who === null) continue;
      if (!(await mailWorthATask(target, row.message_id, { fetchImpl: options.fetchImpl, deadline: options.deadline, timeoutMs: options.titleTimeoutMs }))) continue;
      const title = await followUpTitle(
        { who: outcome.who, subject: row.subject, text: bodyOf(row) },
        { fetchImpl: options.fetchImpl, deadline: options.deadline, timeoutMs: options.titleTimeoutMs },
      );
      const taskId = await suggestFollowUp(target, row, title);
      if (taskId) followUps.set(target.workspaceId, [...(followUps.get(target.workspaceId) ?? []), taskId]);
    } catch (error) {
      console.error("Filing an email on the timeline failed", error);
    }
  }
  const own = await suggestForOwnDomainsAndColleagues(actor, workspaceIds, byWorkspace, filter, options);
  for (const [workspaceId, ids] of own) followUps.set(workspaceId, [...(followUps.get(workspaceId) ?? []), ...ids]);
  for (const [workspaceId, taskIds] of followUps) {
    const target = byWorkspace.get(workspaceId);
    if (target) await sendFollowUpsToClickUp(target, taskIds);
  }
  return { filed };
}

export async function filedWorkspaces(actor: UserActor, actors: UserActor[], filter: MailFilter) {
  const workspaceIds = actors.map((item) => item.workspaceId);
  const built = mailFilter(filter, Date.now(), WINDOW_DAYS);
  return withActor(actor, async (db) => {
    const result = await db.query<{ message_id: string; workspace_id: string; direction: string }>(
      `${routedSql(built.sql)}
       select distinct x.id as message_id, x.workspace_id, x.direction from matched x`,
      routedParams(actor, workspaceIds, built.params),
    );
    return result.rows;
  });
}
