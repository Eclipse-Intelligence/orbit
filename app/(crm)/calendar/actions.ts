"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import { syncCalendar } from "@/lib/crm/calendar";
import { disconnectCalendarAccount } from "@/lib/crm/calendar-accounts";
import { addCalendarFeed } from "@/lib/crm/calendar-feeds";
import { createContactFromEvent, setCalendarForCrm, setCalendarVisible } from "@/lib/crm/calendars";
import { cancelInvite, createInvite, rescheduleInvite, type InviteInput } from "@/lib/crm/invites";
import type { UserActor } from "@/lib/crm/types";
import { revalidateRecordPages } from "@/lib/revalidate";
import { SETTINGS_ROOT } from "@/lib/settings-nav";

type CalendarActionState = { error?: string; ok?: boolean; message?: string };

function refreshCalendar() {
  revalidatePath("/calendar");
  revalidatePath(SETTINGS_ROOT, "layout");
}

function refreshRecords() {
  refreshCalendar();
  revalidatePath("/capture");
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

export async function addCalendarFeedAction(url: string, name: string): Promise<CalendarActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to add a calendar." };
  try {
    const added = await addCalendarFeed(user, {
      url: typeof url === "string" ? url : "",
      name: typeof name === "string" ? name : null,
    });
    refreshRecords();
    return { ok: true, message: `Added ${added.name}.` };
  } catch (error) {
    return actionError(error);
  }
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

type InviteActionState = CalendarActionState & {
  field?: string;
  warning?: string | null;
  guests?: { email: string; name: string | null }[];
};

function refreshInvites() {
  refreshCalendar();
  revalidatePath("/");
  revalidatePath("/activities");
  revalidateRecordPages();
}

export async function sendInviteAction(input: InviteInput): Promise<InviteActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to send invites." };
  try {
    const sent = await createInvite(user, input && typeof input === "object" ? input : {});
    refreshInvites();
    return { ok: true, warning: sent.warning, guests: sent.guests };
  } catch (error) {
    return actionError(error);
  }
}

export async function cancelInviteAction(eventId: string, comment: string): Promise<InviteActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to cancel meetings." };
  try {
    const cancelled = await cancelInvite(user, typeof eventId === "string" ? eventId : "", comment);
    refreshInvites();
    return { ok: true, warning: cancelled.warning };
  } catch (error) {
    return actionError(error);
  }
}

export async function moveInviteAction(
  eventId: string,
  input: { startLocal: string; message: string },
): Promise<InviteActionState & { startsAt?: string; endsAt?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to move meetings." };
  try {
    const moved = await rescheduleInvite(user, {
      eventId: typeof eventId === "string" ? eventId : "",
      startLocal: input?.startLocal,
      message: input?.message,
    });
    refreshInvites();
    return { ok: true, warning: moved.warning, startsAt: moved.startsAt, endsAt: moved.endsAt };
  } catch (error) {
    return actionError(error);
  }
}
