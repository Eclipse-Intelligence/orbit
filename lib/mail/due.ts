import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { memberActor } from "@/lib/crm/conversations";
import { applyMailAction } from "@/lib/mail/actions";
import { claimDueDrafts, dueDraftInput, failDueDraft, sendMailDraft } from "@/lib/mail/compose";
import { mailOrigin } from "@/lib/mail/origin";
import { threadKey } from "@/lib/mail/threads";
import { notify } from "@/lib/workflows/engine";

export type DueReport = { sent: number; failed: number; returned: number; followUps: number };

type ReminderRow = { id: string; source_id: string; thread_key: string; subject: string | null; kind: "snooze" | "follow_up" };

async function anythingDue(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ due: boolean }>(
      `select exists (select 1 from crm.mail_drafts where user_id = $1 and send_at <= now())
           or exists (select 1 from crm.mail_reminders where user_id = $1 and state = 'waiting' and due_at <= now()) as due`,
      [actor.userId],
    );
    return Boolean(result.rows[0]?.due);
  });
}

async function claimReminders(actor: UserActor, limit: number) {
  return withActor(actor, async (db) => {
    const result = await db.query<ReminderRow>(
      `update crm.mail_reminders set state = 'due', surfaced_at = now()
       where id in (
         select id from crm.mail_reminders
         where user_id = $1 and workspace_id = $2 and state = 'waiting' and due_at <= now()
         order by due_at limit $3 for update skip locked
       )
       returning id, source_id, thread_key, subject, kind`,
      [actor.userId, actor.workspaceId, limit],
    );
    return result.rows;
  });
}

function mailHref(sourceId: string, key: string) {
  return `/mail?thread=${encodeURIComponent(threadKey(sourceId, key))}`;
}

async function returnSnooze(actor: UserActor, reminder: ReminderRow, fetchImpl: typeof fetch) {
  const thread = threadKey(reminder.source_id, reminder.thread_key);
  await applyMailAction(actor, { thread, action: "inbox", view: { role: "snoozed" } }, fetchImpl);
  await applyMailAction(actor, { thread, action: "unread", view: { role: "inbox" } }, fetchImpl).catch(() => undefined);
  await withActor(actor, (db) =>
    db.query("update crm.mail_reminders set state = 'due', surfaced_at = now() where id = $1", [reminder.id]),
  );
}

async function checkFollowUp(actor: UserActor, reminder: ReminderRow) {
  const replied = await withActor(actor, async (db) => {
    const result = await db.query<{ replied: boolean }>(
      `select exists (
         select 1 from crm.mail_messages m
         join crm.mail_reminders r on r.id = $1
         where m.user_id = $2 and m.source_id = r.source_id
           and coalesce(m.thread_key, 'm:' || m.id::text) = r.thread_key
           and coalesce(m.received_at, m.sent_at, m.created_at) > r.created_at
           and lower(coalesce(m.from_email, '')) <> all (
             select lower(s.email) from crm.mail_sources s where s.user_id = $2
             union select lower($3::text)
           )
       ) as replied`,
      [reminder.id, actor.userId, actor.email],
    );
    return Boolean(result.rows[0]?.replied);
  });
  if (replied) {
    await withActor(actor, (db) => db.query("update crm.mail_reminders set state = 'done' where id = $1", [reminder.id]));
    return false;
  }
  await notify(actor, actor.userId, {
    title: `No reply yet: ${reminder.subject?.trim() || "(no subject)"}`,
    body: "Orbit has put the conversation back at the top of your inbox.",
    href: mailHref(reminder.source_id, reminder.thread_key),
    source: "mail",
  });
  return true;
}

export async function processDueMail(actor: UserActor, options: { fetchImpl?: typeof fetch; origin?: string | null } = {}): Promise<DueReport> {
  const report: DueReport = { sent: 0, failed: 0, returned: 0, followUps: 0 };
  if (!(await anythingDue(actor))) return report;
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.origin === undefined ? mailOrigin() : options.origin;
  for (const draft of await claimDueDrafts(actor)) {
    try {
      await sendMailDraft(actor, dueDraftInput(draft), { origin, fetchImpl });
      report.sent += 1;
    } catch (error) {
      report.failed += 1;
      const message = error instanceof Error ? error.message : "The scheduled email didn't send.";
      await failDueDraft(actor, draft.id, message);
      await notify(actor, actor.userId, {
        title: `Scheduled email didn't send: ${draft.subject?.trim() || "(no subject)"}`,
        body: message,
        href: "/mail?view=scheduled",
        source: "mail",
      }).catch(() => undefined);
    }
  }
  for (const reminder of await claimReminders(actor, 20)) {
    try {
      if (reminder.kind === "snooze") {
        await returnSnooze(actor, reminder, fetchImpl);
        report.returned += 1;
      } else if (await checkFollowUp(actor, reminder)) {
        report.followUps += 1;
      }
    } catch (error) {
      console.error("mail reminder failed", error);
      await withActor(actor, (db) =>
        db.query("update crm.mail_reminders set state = 'waiting', due_at = now() + interval '5 minutes' where id = $1", [reminder.id]),
      );
    }
  }
  return report;
}

export async function processAllDueMail(deadline: number) {
  const members = await query<Parameters<typeof memberActor>[0]>("select * from private.mail_due_members()");
  const users: { userId: string; report: DueReport | { error: string } }[] = [];
  for (const row of members.rows) {
    if (Date.now() > deadline) break;
    const actor = memberActor(row);
    try {
      users.push({ userId: actor.userId, report: await processDueMail(actor) });
    } catch (error) {
      users.push({ userId: actor.userId, report: { error: error instanceof Error ? error.message : "Due mail failed." } });
    }
  }
  return users;
}
