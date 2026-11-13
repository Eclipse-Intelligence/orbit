"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getHomeActor, getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import { syncCalendar } from "@/lib/crm/calendar";
import { CrmError } from "@/lib/crm/errors";
import { disconnectCalendarAccount } from "@/lib/crm/calendar-accounts";
import { addCalendarFeed } from "@/lib/crm/calendar-feeds";
import { createContactFromEvent, setCalendarForCrm, setCalendarVisible } from "@/lib/crm/calendars";
import { cancelInvite, createInvite, rescheduleInvite, respondToInvite, type InviteInput } from "@/lib/crm/invites";
import type { UserActor } from "@/lib/crm/types";
import { resetLearnedTimes } from "@/lib/crm/schedule-preferences";
import { saveWorkingHours } from "@/lib/crm/working-hours";
import { revalidateRecordPages } from "@/lib/revalidate";
import { SETTINGS_PATHS, SETTINGS_ROOT } from "@/lib/settings-nav";

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
  const home = getHomeActor();
  after(async () => {
    try {
      const result = await syncCalendar((await home) ?? user, { force: true });
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
  if (!user) return { error: "Sign in again." };
  try {
    const result = await setCalendarVisible(user, calendarId, visible);
    if (result.needsSync) syncLater(user);
  } catch (error) {
    return actionError(error);
  }
  refreshCalendar();
  return { ok: true };
}

export async function saveWorkingHoursAction(hours: unknown): Promise<CalendarActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await saveWorkingHours(user, hours);
  } catch (error) {
    return error instanceof CrmError ? actionError(error) : { error: "Couldn't save your working hours. Try again." };
  }
  revalidatePath(SETTINGS_PATHS.calendars);
  revalidatePath("/calendar");
  return { ok: true };
}

export async function resetLearnedTimesAction(): Promise<CalendarActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await resetLearnedTimes(user);
  } catch (error) {
    return error instanceof CrmError ? actionError(error) : { error: "Couldn't reset your learned times. Try again." };
  }
  revalidatePath(SETTINGS_PATHS.calendars);
  return { ok: true };
}

export async function setCalendarForCrmAction(
  calendarId: string,
  useForCrm: boolean,
): Promise<CalendarActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const result = await setCalendarForCrm(user, calendarId, useForCrm);
    if (result.needsSync) syncLater(user);
  } catch (error) {
    return actionError(error);
  }
  refreshRecords();
  return { ok: true };
}

export async function disconnectCalendarAccountAction(accountId: string, confirmedEmail?: string | null): Promise<CalendarActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await disconnectCalendarAccount(user, accountId, { email: typeof confirmedEmail === "string" ? confirmedEmail : null });
  } catch (error) {
    return actionError(error);
  }
  refreshRecords();
  revalidatePath("/mail");
  return { ok: true };
}

export async function addCalendarFeedAction(url: string, name: string): Promise<CalendarActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
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
  if (!user) return { error: "Sign in again." };
  const result = await syncCalendar((await getHomeActor()) ?? user, { force: true });
  refreshRecords();
  if (result.error) return { error: result.error };
  return { ok: true, message: result.complete ? "Calendars synced." : "Still syncing some calendars." };
}

export async function createContactFromEventAction(
  eventId: string,
  email: string,
): Promise<CalendarActionState & { contactId?: string; contactName?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
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
  revalidatePath(SETTINGS_PATHS.activity);
  revalidateRecordPages();
}

export async function sendInviteAction(input: InviteInput): Promise<InviteActionState> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
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
  if (!user) return { error: "Sign in again." };
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
): Promise<InviteActionState & { startsAt?: string; endsAt?: string; gone?: boolean }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const moved = await rescheduleInvite(user, {
      eventId: typeof eventId === "string" ? eventId : "",
      startLocal: input?.startLocal,
      message: input?.message,
    });
    refreshInvites();
    return { ok: true, warning: moved.warning, startsAt: moved.startsAt, endsAt: moved.endsAt };
  } catch (error) {
    if (error instanceof CrmError && error.code === "gone") {
      refreshInvites();
      return { error: error.message, gone: true };
    }
    return actionError(error);
  }
}

export async function respondToInviteAction(
  eventId: string,
  input: { response: string; note: string; sendResponse: boolean },
): Promise<InviteActionState & { responseStatus?: string; gone?: boolean }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const answered = await respondToInvite(user, {
      eventId: typeof eventId === "string" ? eventId : "",
      response: input?.response,
      note: input?.note,
      sendResponse: input?.sendResponse,
    });
    refreshInvites();
    return { ok: true, warning: answered.warning, responseStatus: answered.responseStatus };
  } catch (error) {
    if (error instanceof CrmError && error.code === "gone") {
      refreshInvites();
      return { error: error.message, gone: true };
    }
    return actionError(error);
  }
}
