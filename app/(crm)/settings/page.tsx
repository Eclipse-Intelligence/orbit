import { redirect } from "next/navigation";
import SettingsScreen from "@/components/crm/settings-screen";
import { getUserActor } from "@/lib/auth/user";
import { listPipeline } from "@/lib/crm/opportunities";
import { listWebhookDeliveries, listWebhooks } from "@/lib/crm/webhooks";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [pipeline, endpoints, deliveries] = await Promise.all([
    listPipeline(user),
    listWebhooks(user),
    listWebhookDeliveries(user, 20),
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
    />
  );
}
