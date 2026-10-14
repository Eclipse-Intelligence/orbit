import { redirect } from "next/navigation";
import SettingsScreen from "@/components/crm/settings-screen";
import { getUserActor } from "@/lib/auth/user";
import { getClickUpSettings } from "@/lib/crm/clickup";
import { listPipeline } from "@/lib/crm/opportunities";
import { getMyEmails } from "@/lib/crm/profile";
import { listTags } from "@/lib/crm/tags";
import { listWebhookDeliveries, listWebhooks } from "@/lib/crm/webhooks";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [pipeline, endpoints, deliveries, clickup, myEmails, tags] = await Promise.all([
    listPipeline(user),
    listWebhooks(user),
    listWebhookDeliveries(user, 20),
    getClickUpSettings(user),
    getMyEmails(user),
    listTags(user),
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
    />
  );
}
