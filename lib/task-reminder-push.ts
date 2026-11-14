import { taskPanelHref } from "@/lib/chat/discussions";
import { memberActor } from "@/lib/crm/conversations";
import { reminderHeadline } from "@/lib/crm/reminder-options";
import type { WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { pushToUser, type PushSender } from "@/lib/push";
import { reminderKey } from "@/lib/reminder-alerts";

type ClaimedReminder = {
  task_id: string;
  claimed_at: Date | string;
  title: string;
  due_at: Date | string;
  remind_minutes: number;
  company_name: string | null;
  contact_name: string | null;
  workspace_id: string;
  workspace_name: string;
  user_id: string | null;
  role: WorkspaceRole | null;
  email: string | null;
  full_name: string | null;
};

const CLAIM_BATCH = 10;

export function taskReminderPush(reminder: { taskId: string; title: string; dueAt: string; remindMinutes: number; about: string | null }, now: number) {
  return {
    title: reminderHeadline(reminder.dueAt, now),
    body: reminder.about ? `${reminder.title} · ${reminder.about}` : reminder.title,
    url: taskPanelHref(reminder.taskId),
    tag: reminderKey(reminder.taskId, reminder.dueAt, reminder.remindMinutes),
  };
}

async function release(row: ClaimedReminder, tried = true) {
  const sql = tried ? "select private.release_task_reminder($1, $2)" : "select private.return_task_reminder($1, $2)";
  await query(sql, [row.task_id, row.claimed_at]).catch((error) =>
    console.error("Task reminder release failed", error instanceof Error ? error.name : "unknown"),
  );
}

function retryable(result: { sent: number; failures: { status: number | null; network?: true }[] }) {
  return result.sent === 0 && result.failures.some((failure) => (failure.status === null ? failure.network === true : failure.status !== 404 && failure.status !== 410));
}

type Recipient = ClaimedReminder & { user_id: string; role: WorkspaceRole };

function hasRecipient(row: ClaimedReminder): row is Recipient {
  return Boolean(row.user_id && row.role);
}

async function deliver(row: Recipient, now: number, send: PushSender | undefined) {
  const message = taskReminderPush(
    {
      taskId: row.task_id,
      title: row.title,
      dueAt: new Date(row.due_at).toISOString(),
      remindMinutes: row.remind_minutes,
      about: row.contact_name ?? row.company_name,
    },
    now,
  );
  try {
    const result = await pushToUser(memberActor(row), message, { send });
    if (retryable(result)) {
      await release(row);
      return 0;
    }
    return result.sent;
  } catch (error) {
    console.error("Task reminder push failed", error instanceof Error ? error.name : "unknown");
    await release(row);
    return 0;
  }
}

export async function processTaskReminders(options: { deadline: number; now?: number; send?: PushSender }) {
  const now = options.now ?? Date.now();
  const tried = new Set<string>();
  let claimed = 0;
  let pushed = 0;
  let sent = 0;
  while (Date.now() < options.deadline) {
    const batch = await query<ClaimedReminder>("select * from private.claim_task_reminders($1, $2, $3)", [new Date(now).toISOString(), CLAIM_BATCH, [...tried]]);
    claimed += batch.rows.length;
    const results = await Promise.all(
      batch.rows.map(async (row) => {
        tried.add(row.task_id);
        if (!hasRecipient(row)) return 0;
        if (Date.now() > options.deadline) {
          await release(row, false);
          return 0;
        }
        return deliver(row, now, options.send);
      }),
    );
    for (const delivered of results) {
      sent += delivered;
      if (delivered > 0) pushed += 1;
    }
    if (batch.rows.length < CLAIM_BATCH) break;
  }
  return { claimed, pushed, sent };
}
