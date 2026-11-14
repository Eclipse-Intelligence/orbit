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
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

const CLAIM_LIMIT = 50;

export function taskReminderPush(reminder: { taskId: string; title: string; dueAt: string; remindMinutes: number; about: string | null }, now: number) {
  return {
    title: reminderHeadline(reminder.dueAt, now),
    body: reminder.about ? `${reminder.title} · ${reminder.about}` : reminder.title,
    url: taskPanelHref(reminder.taskId),
    tag: reminderKey(reminder.taskId, reminder.dueAt, reminder.remindMinutes),
  };
}

async function release(row: ClaimedReminder) {
  await query("select private.release_task_reminder($1, $2)", [row.task_id, row.claimed_at]).catch((error) =>
    console.error("Task reminder release failed", error instanceof Error ? error.name : "unknown"),
  );
}

export async function processTaskReminders(options: { deadline: number; now?: number; send?: PushSender }) {
  const now = options.now ?? Date.now();
  const claimed = await query<ClaimedReminder>("select * from private.claim_task_reminders($1, $2)", [new Date(now).toISOString(), CLAIM_LIMIT]);
  let sent = 0;
  let pushed = 0;
  for (const row of claimed.rows) {
    if (Date.now() > options.deadline) {
      await release(row);
      continue;
    }
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
      const result = await pushToUser(memberActor(row), message, { send: options.send });
      sent += result.sent;
      if (result.sent > 0) pushed += 1;
    } catch (error) {
      console.error("Task reminder push failed", error instanceof Error ? error.name : "unknown");
      await release(row);
    }
  }
  return { claimed: claimed.rows.length, pushed, sent };
}
