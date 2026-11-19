import { redirect } from "next/navigation";
import CalendarScreen from "@/components/crm/calendar-screen";
import { getUserActor } from "@/lib/auth/user";
import { calendarRange, dateKey, parseDateKey, parseMode } from "@/lib/calendar-view";
import { listCalendarGroups, listCalendarItems } from "@/lib/crm/calendars";
import { getInviteSetup } from "@/lib/crm/invites";
import { listCalendarReminders } from "@/lib/crm/reminders";
import { readPlanner } from "@/lib/crm/task-blocks";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

function requestTime() {
  return Date.now();
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const now = requestTime();
  const today = dateKey(now);
  const date = parseDateKey(typeof resolved.date === "string" ? resolved.date : null) ?? today;
  const mode = parseMode(typeof resolved.view === "string" ? resolved.view : null);
  const range = calendarRange(date, mode ?? "week");
  const [groups, items, invite, planner, reminders] = await Promise.all([
    listCalendarGroups(user),
    listCalendarItems(
      user,
      {
        start: new Date(range.start.getTime() - DAY_MS),
        end: new Date(range.end.getTime() + DAY_MS),
      },
      now,
    ),
    getInviteSetup(user),
    readPlanner(user, now),
    listCalendarReminders(user, { from: range.days[0], to: range.days[range.days.length - 1] }, { now })
      .then((result) => result.reminders)
      .catch((error) => {
        console.error("Calendar reminders failed", error);
        return null;
      }),
  ]);

  return (
    <CalendarScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
        workspaceId: user.workspaceId,
      }}
      today={today}
      date={date}
      mode={mode}
      groups={groups}
      items={items}
      now={now}
      invite={invite}
      planner={planner}
      reminders={reminders ?? []}
      remindersFailed={reminders === null}
    />
  );
}
