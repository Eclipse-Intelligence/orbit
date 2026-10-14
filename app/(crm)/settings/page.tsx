import { redirect } from "next/navigation";
import SettingsScreen from "@/components/crm/settings-screen";
import { getUserActor } from "@/lib/auth/user";
import { listCalendarGroups } from "@/lib/crm/calendars";
import { getClickUpSettings } from "@/lib/crm/clickup";
import { listPipeline } from "@/lib/crm/opportunities";
import { getMyEmails } from "@/lib/crm/profile";
import { listTags } from "@/lib/crm/tags";
import { listWebhookDeliveries, listWebhooks } from "@/lib/crm/webhooks";
import { microsoftConfigured } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const [pipeline, endpoints, deliveries, clickup, myEmails, tags, calendars] = await Promise.all([
    listPipeline(user),
    listWebhooks(user),
    listWebhookDeliveries(user, 20),
    getClickUpSettings(user),
    getMyEmails(user),
    listTags(user),
    listCalendarGroups(user),
  ]);

  return (
    <SettingsScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      canAdmin={user.role === "owner" || user.role === "admin"}
      stages={pipeline.stages}
      endpoints={endpoints}
      deliveries={deliveries}
      clickup={clickup}
      myEmails={myEmails}
      tags={tags}
      calendars={{
        groups: calendars,
        configured: microsoftConfigured(),
        connectedEmail: typeof resolved.calendar_connected === "string" ? resolved.calendar_connected : null,
        connectError: typeof resolved.calendar_error === "string" ? resolved.calendar_error : null,
      }}
    />
  );
}
