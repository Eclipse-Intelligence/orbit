import { actingActor } from "@/lib/crm/task-outlook";
import { clockLabel } from "@/lib/crm/task-time";
import { query } from "@/lib/db/pool";
import { pushToUser, type PushSender } from "@/lib/push";
import { appTimeZone } from "@/lib/time";

export const REMINDERS_LINK = "/?reminders=open";

type ClaimedPush = { reminder_id: string; user_id: string; title: string; due_at: Date | string };
type ClaimedMorning = { user_id: string; day: string; titles: string[]; total: number };

const CLAIM_BATCH = 10;

export function timedReminderPush(reminder: { id: string; title: string; dueAt: string }) {
  return { title: reminder.title, body: clockLabel(reminder.dueAt), url: REMINDERS_LINK, tag: `reminder:${reminder.id}:${reminder.dueAt}` };
}

export function morningReminderPush(day: string, titles: string[], total: number) {
  return { title: `${total} ${total === 1 ? "reminder" : "reminders"} today`, body: titles.join(", "), url: REMINDERS_LINK, tag: `reminders:${day}` };
}

function retryable(result: { sent: number; failures: { status: number | null; network?: true }[] }) {
  return result.sent === 0 && result.failures.some((failure) => (failure.status === null ? failure.network === true : failure.status !== 404 && failure.status !== 410));
}

async function quietly(sql: string, values: unknown[]) {
  await query(sql, values).catch((error) => console.error("Reminder push release failed", error instanceof Error ? error.name : "unknown"));
}

async function deliver(userId: string, message: { title: string; body: string; url: string; tag: string }, send: PushSender | undefined, release: () => Promise<void>) {
  try {
    const actor = await actingActor(userId, "", true);
    if (!actor) return 0;
    const result = await pushToUser(actor, message, { send, keepLink: true });
    if (retryable(result)) {
      await release();
      return 0;
    }
    return result.sent;
  } catch (error) {
    console.error("Reminder push failed", error instanceof Error ? error.name : "unknown");
    await release();
    return 0;
  }
}

async function timedPushes(now: number, deadline: number, send: PushSender | undefined) {
  const tried = new Set<string>();
  let claimed = 0;
  let pushed = 0;
  while (Date.now() < deadline) {
    const batch = await query<ClaimedPush>("select * from private.claim_reminder_pushes($1, $2, $3)", [new Date(now).toISOString(), CLAIM_BATCH, [...tried]]);
    claimed += batch.rows.length;
    const results = await Promise.all(
      batch.rows.map(async (row) => {
        tried.add(row.reminder_id);
        const dueAt = new Date(row.due_at).toISOString();
        const release = () => quietly("select private.release_reminder_push($1, $2)", [row.reminder_id, dueAt]);
        if (Date.now() > deadline) {
          await release();
          return 0;
        }
        return deliver(row.user_id, timedReminderPush({ id: row.reminder_id, title: row.title, dueAt }), send, release);
      }),
    );
    pushed += results.filter((sent) => sent > 0).length;
    if (batch.rows.length < CLAIM_BATCH) break;
  }
  return { claimed, pushed };
}

async function morningPushes(now: number, deadline: number, send: PushSender | undefined) {
  let claimed = 0;
  let pushed = 0;
  const failed: ClaimedMorning[] = [];
  try {
    while (Date.now() < deadline) {
      const batch = await query<ClaimedMorning>("select user_id, day::text as day, titles, total from private.claim_morning_reminders($1, $2, $3)", [
        new Date(now).toISOString(),
        CLAIM_BATCH,
        appTimeZone(),
      ]);
      claimed += batch.rows.length;
      const results = await Promise.all(
        batch.rows.map(async (row) => {
          const later = async () => {
            failed.push(row);
          };
          if (Date.now() > deadline) {
            await later();
            return 0;
          }
          return deliver(row.user_id, morningReminderPush(row.day, row.titles, row.total), send, later);
        }),
      );
      pushed += results.filter((sent) => sent > 0).length;
      if (batch.rows.length < CLAIM_BATCH) break;
    }
  } finally {
    for (const row of failed) await quietly("select private.release_morning_reminders($1, $2::date)", [row.user_id, row.day]);
  }
  return { claimed, pushed };
}

export async function processReminderPushes(options: { deadline: number; now?: number; send?: PushSender }) {
  const now = options.now ?? Date.now();
  const timed = await timedPushes(now, options.deadline, options.send);
  const morning = await morningPushes(now, options.deadline, options.send);
  return { timed, morning };
}
