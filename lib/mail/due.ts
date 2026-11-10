import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { memberActor } from "@/lib/crm/conversations";
import { applyMailAction } from "@/lib/mail/actions";
import { claimDueDrafts, dueDraftInput, failDueDraft, sendMailDraft } from "@/lib/mail/compose";
import { mailOrigin } from "@/lib/mail/origin";
import { threadKey } from "@/lib/mail/threads";
import { sendAlert } from "@/lib/alerts";
import { mailNotifyLevel } from "@/lib/mail/notify";
import type { PushSender } from "@/lib/push";
import { prepareNudge, storeNudge, writeNudge } from "@/lib/mail/prepare";
import { firstReply, FOLLOW_UP_ROW_COLUMNS, hasStuckFollowUps, recoverStuckFollowUps, sendDueFollowUp, type SendFollowUpRow } from "@/lib/mail/follow-up";

type DueReport = { sent: number; failed: number; returned: number; followUps: number; followUpsSent: number; stuck: number; reminderErrors: number };

type ReminderRow = SendFollowUpRow & { kind: "snooze" | "follow_up"; action: "remind" | "send"; automatic: boolean; deferral: boolean };

const DRAFTS_PER_RUN = 5;
const REMINDERS_PER_RUN = 20;
const DRAFT_STEP_MS = 8_000;
const REMINDER_STEP_MS = 12_000;
const DEFAULT_BUDGET_MS = 20_000;

async function anythingDue(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ due: boolean }>(
      `select exists (select 1 from crm.mail_drafts where user_id = $1 and send_at <= now())
           or exists (select 1 from crm.mail_reminders where user_id = $1 and state = 'waiting' and due_at <= now()) as due`,
      [actor.userId],
    );
    return Boolean(result.rows[0]?.due) || (await hasStuckFollowUps(db, actor));
  });
}

async function claimReminders(actor: UserActor, limit: number) {
  return withActor(actor, async (db) => {
    const result = await db.query<ReminderRow>(
      `with picked as materialized (
         select id from crm.mail_reminders
         where user_id = $1 and state = 'waiting' and due_at <= now()
         order by due_at, id limit $2 for update skip locked
       )
       update crm.mail_reminders r set state = 'due', surfaced_at = now()
       from picked where r.id = picked.id
       returning ${FOLLOW_UP_ROW_COLUMNS.split(", ").map((column) => `r.${column}`).join(", ")}, r.kind, r.action, r.automatic, r.deferral`,
      [actor.userId, limit],
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

async function checkInNudge(actor: UserActor, reminder: ReminderRow, deadline: number) {
  const written = await writeNudge(actor, reminder.source_id, reminder.thread_key, { deadline, limited: true });
  if (!written) return null;
  await storeNudge(actor, { sourceId: reminder.source_id, key: reminder.thread_key, messageId: written.messageId, body: written.body });
  return written.body;
}

async function checkFollowUp(actor: UserActor, reminder: ReminderRow, options: { send?: PushSender; deadline: number }) {
  const replied = await withActor(actor, async (db) => Boolean(await firstReply(db, actor, reminder.id)));
  if (replied) {
    await withActor(actor, (db) => db.query("update crm.mail_reminders set state = 'done' where id = $1", [reminder.id]));
    return false;
  }
  const deferred = reminder.deferral;
  const deadline = Math.min(options.deadline, Date.now() + 15_000);
  const nudge = await (deferred ? checkInNudge(actor, reminder, deadline) : prepareNudge(actor, reminder.source_id, reminder.thread_key, { deadline })).catch((error) => {
    console.error("Preparing a follow-up failed", error instanceof Error ? error.message : error);
    return null;
  });
  const subject = reminder.subject?.trim() || "(no subject)";
  const title = deferred ? `Time to check in: ${subject}` : `No reply yet: ${subject}`;
  const href = mailHref(reminder.source_id, reminder.thread_key);
  const quiet = (await mailNotifyLevel(actor)) === "none";
  const body = deferred
    ? nudge
      ? "They asked to pick this up now. Orbit has a check-in ready for you to send."
      : "They asked to pick this up now. It's back at the top of your inbox."
    : nudge
      ? "Nobody has replied. Orbit has a follow-up ready for you to send."
      : "Nobody has replied. It's back at the top of your inbox.";
  await sendAlert(
    actor,
    {
      key: `follow-up:${reminder.id}`,
      title,
      body,
      url: href,
      tag: `${reminder.source_id}|${reminder.thread_key}`,
      bell: { title, body: "Orbit has put the conversation back at the top of your inbox.", href, category: "capture" },
    },
    { send: quiet ? async () => undefined : options.send },
  );
  return true;
}

export async function processDueMail(
  actor: UserActor,
  options: { fetchImpl?: typeof fetch; origin?: string | null; send?: PushSender; deadline?: number } = {},
): Promise<DueReport> {
  const report: DueReport = { sent: 0, failed: 0, returned: 0, followUps: 0, followUpsSent: 0, stuck: 0, reminderErrors: 0 };
  if (!(await anythingDue(actor))) return report;
  const deadline = options.deadline ?? Date.now() + DEFAULT_BUDGET_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.origin === undefined ? mailOrigin() : options.origin;
  report.stuck = await recoverStuckFollowUps(actor, { send: options.send }).catch((error) => {
    console.error("Recovering stuck follow-ups failed", error instanceof Error ? error.message : error);
    return 0;
  });
  for (let count = 0; count < DRAFTS_PER_RUN && deadline - Date.now() >= DRAFT_STEP_MS; count += 1) {
    const [draft] = await claimDueDrafts(actor, 1);
    if (!draft) break;
    try {
      await sendMailDraft(actor, dueDraftInput(draft), { origin, fetchImpl, storedFiles: "keep", claimed: true });
      report.sent += 1;
    } catch (error) {
      report.failed += 1;
      const message = error instanceof Error ? error.message : "The scheduled email didn't send.";
      await failDueDraft(actor, draft.id, message);
      const title = `Scheduled email didn't send: ${draft.subject?.trim() || "(no subject)"}`;
      await sendAlert(
        actor,
        { key: `send-failed:${draft.id}:${Date.now()}`, title, body: message, url: "/mail?view=scheduled", bell: { title, body: message, href: "/mail?view=scheduled" } },
        { send: options.send },
      ).catch(() => undefined);
    }
  }
  for (let count = 0; count < REMINDERS_PER_RUN && deadline - Date.now() >= REMINDER_STEP_MS; count += 1) {
    const [reminder] = await claimReminders(actor, 1);
    if (!reminder) break;
    try {
      if (reminder.kind === "snooze") {
        await returnSnooze(actor, reminder, fetchImpl);
        report.returned += 1;
        if ((await mailNotifyLevel(actor)) !== "none") {
          await sendAlert(
            actor,
            {
              key: `snooze:${reminder.id}`,
              title: "Back in your inbox",
              body: reminder.subject?.trim() || "(no subject)",
              url: mailHref(reminder.source_id, reminder.thread_key),
              tag: `${reminder.source_id}|${reminder.thread_key}`,
            },
            { send: options.send },
          ).catch(() => undefined);
        }
      } else if (reminder.action === "send" && !reminder.automatic) {
        const outcome = await sendDueFollowUp(actor, reminder, { origin, fetchImpl, send: options.send, deadline });
        if (outcome === "sent") report.followUpsSent += 1;
        if (outcome === "reminded") report.followUps += 1;
      } else if (await checkFollowUp(actor, reminder, { send: options.send, deadline })) {
        report.followUps += 1;
      }
    } catch (error) {
      console.error("mail reminder failed", error);
      report.reminderErrors += 1;
      const message = (error instanceof Error ? error.message : "The reminder didn't run.").slice(0, 500);
      const outcome = await failReminder(actor, reminder.id, message).catch(() => null);
      if (outcome === "flagged") await flagReminder(actor, reminder, message, options.send).catch(() => undefined);
    }
  }
  return report;
}

export const REMINDER_ATTEMPTS = 5;

export async function failReminder(actor: UserActor, id: string, message: string): Promise<"retry" | "flagged" | null> {
  return withActor(actor, async (db) => {
    const result = await db.query<{ attempts: number }>(
      `update crm.mail_reminders
       set attempts = attempts + 1, last_error = $2,
         state = case when attempts + 1 >= $3 then 'due' else 'waiting' end,
         surfaced_at = case when attempts + 1 >= $3 then now() else surfaced_at end,
         due_at = case when attempts + 1 >= $3 then due_at else now() + make_interval(mins => 5 * (attempts + 1)) end
       where id = $1 and state not in ('sending', 'sent', 'done', 'cancelled', 'replied')
       returning attempts`,
      [id, message, REMINDER_ATTEMPTS],
    );
    const row = result.rows[0];
    if (!row) return null;
    return row.attempts >= REMINDER_ATTEMPTS ? "flagged" : "retry";
  });
}

async function flagReminder(actor: UserActor, reminder: ReminderRow, message: string, send?: PushSender) {
  const subject = reminder.subject?.trim() || "(no subject)";
  const href = mailHref(reminder.source_id, reminder.thread_key);
  const title = reminder.kind === "snooze" ? `Orbit couldn't bring back: ${subject}` : `Orbit couldn't check this follow-up: ${subject}`;
  const body =
    reminder.kind === "snooze"
      ? `It's still in Snoozed. Orbit tried ${REMINDER_ATTEMPTS} times and stopped. ${message}`
      : `Orbit tried ${REMINDER_ATTEMPTS} times and stopped. Check the conversation yourself. ${message}`;
  await sendAlert(actor, { key: `reminder-failed:${reminder.id}`, title, body, url: href, tag: `${reminder.source_id}|${reminder.thread_key}`, bell: { title, body, href } }, { send });
}

export async function processAllDueMail(deadline: number) {
  const members = await query<Parameters<typeof memberActor>[0]>("select * from private.mail_due_members()");
  const users: { userId: string; report: DueReport | { error: string } }[] = [];
  for (const row of members.rows) {
    if (Date.now() > deadline) break;
    const actor = memberActor(row);
    try {
      users.push({ userId: actor.userId, report: await processDueMail(actor, { deadline }) });
    } catch (error) {
      users.push({ userId: actor.userId, report: { error: error instanceof Error ? error.message : "Due mail failed." } });
    }
  }
  return users;
}
