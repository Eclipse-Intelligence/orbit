import { redirect } from "next/navigation";
import CalendarsSettings from "@/components/crm/calendars-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor } from "@/lib/auth/user";
import WorkingHoursSettings from "@/components/crm/working-hours-settings";
import { listCalendarGroups } from "@/lib/crm/calendars";
import { getWorkingHours } from "@/lib/crm/working-hours";
import { microsoftConfigured } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";

export default async function CalendarSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [resolved, groups, hours] = await Promise.all([
    searchParams,
    listCalendarGroups(user),
    getWorkingHours(user),
  ]);
  return (
    <SettingsPage title="Calendars">
      <CalendarsSettings
        groups={groups}
        configured={microsoftConfigured()}
        connectedEmail={
          typeof resolved.calendar_connected === "string"
            ? resolved.calendar_connected
            : null
        }
        connectError={
          typeof resolved.calendar_error === "string"
            ? resolved.calendar_error
            : null
        }
      />
      <WorkingHoursSettings hours={hours} />
    </SettingsPage>
  );
}
