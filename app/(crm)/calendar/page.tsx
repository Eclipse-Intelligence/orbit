import { redirect } from "next/navigation";
import CalendarScreen from "@/components/crm/calendar-screen";
import { getUserActor } from "@/lib/auth/user";
import { calendarRange, dateKey, parseDateKey, parseMode } from "@/lib/calendar-view";
import { listCalendarGroups, listCalendarItems } from "@/lib/crm/calendars";

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
  const [groups, items] = await Promise.all([
    listCalendarGroups(user),
    listCalendarItems(user, {
      start: new Date(range.start.getTime() - DAY_MS),
      end: new Date(range.end.getTime() + DAY_MS),
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
      }}
      today={today}
      date={date}
      mode={mode}
      groups={groups}
      items={items}
      now={now}
    />
  );
}
