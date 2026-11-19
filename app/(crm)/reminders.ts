"use server";

import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import {
  completeReminder,
  createReminder,
  deleteReminder,
  listReminders,
  reopenReminder,
  setReminderMorning,
  updateReminder,
  type Reminder,
  type ReminderInput,
  type ReminderQuery,
} from "@/lib/crm/reminders";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";

const SESSION_ENDED = "Your session ended. Sign in again.";

type Failure = { error: string; field?: string; missing?: boolean };

async function run<T>(work: (user: UserActor) => Promise<T>): Promise<T | Failure> {
  const user = await getUserActor();
  if (!user) return { error: SESSION_ENDED };
  try {
    return await work(user);
  } catch (error) {
    const failure: Failure = actionError(error);
    const missing = error instanceof CrmError && error.status === 404;
    return { error: failure.error, ...(failure.field ? { field: failure.field } : {}), ...(missing ? { missing } : {}) };
  }
}

export async function listRemindersAction(query: ReminderQuery = {}): Promise<{ reminders: Reminder[] } | Failure> {
  return run((user) => listReminders(user, query));
}

export async function addReminderAction(input: ReminderInput, key: string | null = null): Promise<{ reminder: Reminder } | Failure> {
  return run((user) => createReminder(user, input, typeof key === "string" && isUuid(key) ? { idempotencyKey: key } : {}));
}

export async function updateReminderAction(id: string, input: ReminderInput): Promise<{ reminder: Reminder } | Failure> {
  return run((user) => updateReminder(user, id, input));
}

export async function tickReminderAction(id: string, dueOn: string | null): Promise<{ reminder: Reminder; doneId: string | null; changed: boolean } | Failure> {
  return run((user) => completeReminder(user, id, { dueOn }));
}

export async function undoReminderAction(id: string): Promise<{ reminder: Reminder; changed: boolean } | Failure> {
  return run((user) => reopenReminder(user, id));
}

export async function deleteReminderAction(id: string): Promise<{ id: string; deleted: boolean } | Failure> {
  return run((user) => deleteReminder(user, id));
}

export async function setReminderMorningAction(morningAt: string): Promise<{ morningAt: string } | Failure> {
  return run((user) => setReminderMorning(user, morningAt));
}
