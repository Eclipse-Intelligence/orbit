import { createEmailActivityOnce } from "@/lib/crm/activities";
import { companyHasOpenTask, isRecent } from "@/lib/crm/communications";
import { withActor } from "@/lib/crm/context";
import { recordAudit } from "@/lib/crm/mutate";
import { hasScope } from "@/lib/crm/scopes";
import { scheduleTaskDue, withDueNote } from "@/lib/crm/task-due";
import { mailThreadLine, withMailThread } from "@/lib/crm/task-description";
import { createTaskInDb } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { workspaceActors } from "@/lib/crm/workspaces";
import type { Db } from "@/lib/db/pool";
import { stripQuoted } from "@/lib/mail/format";
import { contactElsewhere, ensureContactInDb, NOT_AUTOMATED, routedParams, routedSql } from "@/lib/mail/routing";

const WINDOW_DAYS = 60;
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
  relink_id: string | null;
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
           and (ms.status <> 'subscribed' or ms.cold_pitch_at is not null or ms.list_unsubscribe is not null)
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
     select distinct on (x.id, x.workspace_id, coalesce(x.contact_id, x.company_id))
       x.id as message_id, x.internet_message_id, x.subject, x.snippet, x.body_text, x.at, x.account, x.folder_role,
       x.workspace_id, x.contact_id, x.company_id, x.address, x.direction, x.has_attachments as attachments,
       case when x.contact_id is not null then (
         select a.id from crm.activities a
         left join crm.contacts ac on ac.id = a.contact_id
         where a.workspace_id = x.workspace_id and a.type = 'email' and ${SAME_MESSAGE}
           and (a.contact_id is null or (ac.archived_at is not null and ac.normalized_email = x.contact_email))
         order by a.created_at
         limit 1
       ) end as relink_id
     from matched x
     where not exists (
       select 1 from crm.activities a
       where a.contact_id = x.contact_id and a.workspace_id = x.workspace_id and a.type = 'email'
         and (${SAME_MESSAGE} or (${LOGGED_AT_SEND}))
     )
     and not (x.contact_id is null and exists (
       select 1 from company_logged l where l.mail_id = x.id::text and l.workspace_id = x.workspace_id
     ))
     and not (x.contact_id is null and x.internet_message_id is not null and exists (
       select 1 from company_logged l where l.internet_id = x.internet_message_id and l.workspace_id = x.workspace_id
     ))
     and not (x.contact_id is null and exists (
       select 1 from crm.activities a
       where a.company_id = x.company_id and a.contact_id is null and a.workspace_id = x.workspace_id and a.type = 'email' and ${LOGGED_AT_SEND}
     ))
     order by x.id, x.workspace_id, coalesce(x.contact_id, x.company_id), x.at desc
     limit ${limitParam}`,
    routedParams(actor, workspaceIds, [...filter.params, limit]),
  );
  return result.rows;
}

async function relinkActivity(db: Db, actor: UserActor, activityId: string, row: Candidate) {
  const before = await db.query<{ contact_id: string | null; company_id: string | null }>(
    "select contact_id, company_id from crm.activities where id = $1 and workspace_id = $2 for update",
    [activityId, actor.workspaceId],
  );
  const current = before.rows[0];
  if (!current) return false;
  const companyId = current.company_id ?? row.company_id;
  const updated = await db.query("update crm.activities set contact_id = $3, company_id = $4 where id = $1 and workspace_id = $2", [
    activityId,
    actor.workspaceId,
    row.contact_id,
    companyId,
  ]);
  if (!updated.rowCount) return false;
  const fields = ["contactId", ...(companyId !== current.company_id ? ["companyId"] : [])];
  await recordAudit(db, actor, "activity.updated", "activity", activityId, { operation: "relink_mail", source: "microsoft" }, {
    fields,
    before: { contactId: current.contact_id, ...(fields.includes("companyId") ? { companyId: current.company_id } : {}) },
    after: { contactId: row.contact_id, ...(fields.includes("companyId") ? { companyId } : {}) },
  });
  return true;
}

async function needsFollowUp(actor: UserActor, row: Candidate, at: Date) {
  if (!row.company_id || row.direction !== "inbound" || row.folder_role !== "inbox") return false;
  if (!isRecent(at.toISOString()) || !hasScope(actor.scopes, "tasks:write")) return false;
  return !(await companyHasOpenTask(actor.workspaceId, row.company_id));
}

async function suggestFollowUp(db: Db, actor: UserActor, row: Candidate) {
  if (!row.company_id) return null;
  const names = await db.query<{ contact: string | null; company: string | null }>(
    `select (select coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email) from crm.contacts c where c.id = $1) as contact,
       (select co.name from crm.companies co where co.id = $2) as company`,
    [row.contact_id, row.company_id],
  );
  const who = names.rows[0]?.contact || names.rows[0]?.company || "them";
  const thread = await db.query<{ source_id: string; thread_key: string | null; subject: string | null }>(
    "select source_id, thread_key, subject from crm.mail_messages where id = $1",
    [row.message_id],
  );
  const mail = thread.rows[0];
  const due = await scheduleTaskDue(actor, { days: 2 });
  const task = await createTaskInDb(
    db,
    actor,
    {
      title: `Follow up with ${who}`.slice(0, 200),
      description: withMailThread(
        withDueNote("Suggested after an email arrived.", due),
        mail?.thread_key ? mailThreadLine(mail.source_id, mail.thread_key, mail.subject) : null,
      ),
      dueDate: due?.dueDate ?? null,
      companyId: row.company_id,
      contactId: row.contact_id,
      priority: "normal",
    },
    { operation: "suggest_follow_up", source: "microsoft" },
  );
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

export async function fileMailOnTimeline(
  actor: UserActor,
  options: { days?: number; limit?: number; now?: number; filter?: MailFilter; actors?: UserActor[] } = {},
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
  const relinked = new Set<string>();
  for (const row of rows.sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime())) {
    const target = byWorkspace.get(row.workspace_id);
    if (!target) continue;
    const at = new Date(row.at);
    if (row.relink_id && !relinked.has(row.relink_id)) {
      relinked.add(row.relink_id);
      try {
        await withActor(target, (db) => relinkActivity(db, target, row.relink_id!, row));
      } catch (error) {
        console.error("Moving an email onto its contact failed", error);
      }
      continue;
    }
    try {
      const followUp = await needsFollowUp(target, row, at);
      const outcome = await withActor(target, async (db) => {
        const saved = await createEmailActivityOnce(
          db,
          target,
          {
            type: "email",
            title: (row.subject?.trim() || "(no subject)").slice(0, 200),
            body: bodyOf(row),
            occurredAt: at.toISOString(),
            companyId: row.company_id,
            contactId: row.contact_id,
            metadata: {
              source: "microsoft",
              direction: row.direction,
              ...(row.direction === "inbound" ? { from: row.address } : { from: row.account, to: row.address }),
              account: row.account,
              mailMessageId: row.message_id,
              ...(row.internet_message_id ? { internetMessageId: row.internet_message_id } : {}),
              ...(row.attachments ? { hasAttachments: true } : {}),
            },
          },
          { mailMessageId: row.message_id, internetMessageId: row.internet_message_id },
          { operation: "file_mail", source: "microsoft", catchUp: now - at.getTime() > FRESH_MS },
        );
        return { created: saved.created, taskId: saved.created && followUp ? await suggestFollowUp(db, target, row) : null };
      });
      if (!outcome.created) continue;
      filed += 1;
      if (outcome.taskId) followUps.set(target.workspaceId, [...(followUps.get(target.workspaceId) ?? []), outcome.taskId]);
    } catch (error) {
      console.error("Filing an email on the timeline failed", error);
    }
  }
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
