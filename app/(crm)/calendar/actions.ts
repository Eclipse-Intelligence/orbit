"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import { syncCalendar } from "@/lib/crm/calendar";
import { disconnectCalendarAccount } from "@/lib/crm/calendar-accounts";
import { createContactFromEvent, setCalendarForCrm, setCalendarVisible } from "@/lib/crm/calendars";
import type { UserActor } from "@/lib/crm/types";
import { revalidateRecordPages } from "@/lib/revalidate";

export type CalendarActionState = { error?: string; ok?: boolean; message?: string };

function refreshCalendar() {
  revalidatePath("/calendar");
  revalidatePath("/settings");
}

function refreshRecords() {
  refreshCalendar();
  revalidatePath("/inbox");
  revalidatePath("/");
  revalidatePath("/contacts");
  revalidateRecordPages();
}

function syncLater(user: UserActor) {
  after(async () => {
    try {
      const result = await syncCalendar(user, { force: true });
      if (result.error) console.error("Calendar sync failed", result.error);
    } catch (error) {
      console.error("Calendar sync failed", error);
    }
  });
}

export async function setCalendarVisibleAction(
  calendarId: string,
  visible: boolean,
): Promise<CalendarActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to change your calendars." };
  try {
    const result = await setCalendarVisible(user, calendarId, visible);
    if (result.needsSync) syncLater(user);
  } catch (error) {
    return actionError(error);
  }
  refreshCalendar();
  return { ok: true };
}

export async function setCalendarForCrmAction(
  calendarId: string,
  useForCrm: boolean,
): Promise<CalendarActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to change your calendars." };
  try {
    const result = await setCalendarForCrm(user, calendarId, useForCrm);
    if (result.needsSync) syncLater(user);
  } catch (error) {
    return actionError(error);
  }
  refreshRecords();
  return { ok: true };
}

export async function disconnectCalendarAccountAction(accountId: string): Promise<CalendarActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to change your calendars." };
  try {
    await disconnectCalendarAccount(user, accountId);
  } catch (error) {
    return actionError(error);
  }
  refreshRecords();
  return { ok: true };
}

export async function syncCalendarsAction(): Promise<CalendarActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to sync your calendars." };
  const result = await syncCalendar(user, { force: true });
  refreshRecords();
  if (result.error) return { error: result.error };
  return { ok: true, message: result.complete ? "Calendars synced." : "Synced some calendars. The rest follow shortly." };
}

export async function createContactFromEventAction(
  eventId: string,
  email: string,
): Promise<CalendarActionState & { contactId?: string; contactName?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to add contacts." };
  try {
    const created = await createContactFromEvent(user, eventId, email);
    refreshRecords();
    return { ok: true, contactId: created.contactId, contactName: created.contactName };
  } catch (error) {
    return actionError(error);
  }
}
