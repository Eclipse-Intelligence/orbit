import { headers } from "next/headers";
import { redirect } from "next/navigation";
import ApiSettings from "@/components/crm/api-settings";
import PersonalTokenSettings from "@/components/crm/personal-token-settings";
import { listPersonalTokens } from "@/lib/auth/personal";
import { SettingsPage } from "@/components/crm/settings-ui";
import WebhooksSettings from "@/components/crm/webhooks-settings";
import { getUserActor } from "@/lib/auth/user";
import { SCOPES } from "@/lib/crm/scopes";
import { listWebhookDeliveries, listWebhooks } from "@/lib/crm/webhooks";

export const dynamic = "force-dynamic";

export default async function ApiSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [endpoints, deliveries, headerStore, tokens] = await Promise.all([
    listWebhooks(user),
    listWebhookDeliveries(user, 20),
    headers(),
    listPersonalTokens(user).catch(() => []),
  ]);
  const host =
    headerStore.get("x-forwarded-host") ??
    headerStore.get("host") ??
    "localhost:4173";
  const origin = `${headerStore.get("x-forwarded-proto") ?? "http"}://${host}`;
  const canAdmin = user.role === "owner" || user.role === "admin";
  return (
    <SettingsPage
      title="API and webhooks"
      description="Connect agents and scripts to Orbit, and send CRM events to your own services."
    >
      <PersonalTokenSettings origin={origin} initial={tokens} />
      <ApiSettings origin={origin} scopes={[...SCOPES]} />
      <WebhooksSettings
        endpoints={endpoints}
        deliveries={deliveries}
        canAdmin={canAdmin}
      />
    </SettingsPage>
  );
}
