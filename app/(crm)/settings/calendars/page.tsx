import { redirect } from "next/navigation";
import CalendarsSettings from "@/components/crm/calendars-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor } from "@/lib/auth/user";
import { listCalendarGroups } from "@/lib/crm/calendars";
import { microsoftConfigured } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";

export default async function CalendarSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [resolved, groups] = await Promise.all([
    searchParams,
    listCalendarGroups(user),
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
    </SettingsPage>
  );
}
