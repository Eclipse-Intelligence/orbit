import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AgentMailboxSettings from "@/components/crm/agent-mailbox-settings";
import ApiSettings from "@/components/crm/api-settings";
import ClickUpSettings from "@/components/crm/clickup-settings";
import { LinearSettings } from "@/components/crm/connection-cards";
import EnrichmentSettingsCard from "@/components/crm/enrichment-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import WebhooksSettings from "@/components/crm/webhooks-settings";
import { agentMailboxView } from "@/lib/agent-mail/mailbox";
import { getUserActor } from "@/lib/auth/user";
import { getClickUpSettings } from "@/lib/crm/clickup";
import { SCOPES } from "@/lib/crm/scopes";
import { listWebhookDeliveries, listWebhooks } from "@/lib/crm/webhooks";
import { unenrichedCompanyCount } from "@/lib/enrichment/companies";
import { enrichmentAvailability, getEnrichmentSettings, providerStatuses } from "@/lib/enrichment/settings";
import { linearStatus } from "@/lib/linear";
import { linearConnection } from "@/lib/crm/linear-connection";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function ToolsSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const linearHere = await linearConnection(user);
  const [clickup, enrichment, unenriched, agentMailbox, linear, endpoints, deliveries, headerStore] = await Promise.all([
    getClickUpSettings(user),
    getEnrichmentSettings(user),
    unenrichedCompanyCount(user),
    agentMailboxView(user),
    linearHere.here ? linearStatus() : Promise.resolve({ configured: false, team: null, error: null }),
    listWebhooks(user),
    listWebhookDeliveries(user, 20),
    headers(),
  ]);
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:4173";
  const origin = `${headerStore.get("x-forwarded-proto") ?? "http"}://${host}`;
  const canAdmin = user.role === "owner" || user.role === "admin";
  return (
    <SettingsPage title="Tools" description="Services your team shares, and how agents and your own services reach Orbit.">
      <ClickUpSettings view={clickup} canAdmin={canAdmin} />
      <EnrichmentSettingsCard
        settings={enrichment}
        providers={providerStatuses()}
        canAdmin={canAdmin}
        unenriched={unenriched}
        logoLinkReady={Boolean(enrichmentAvailability().logoClientId)}
      />
      <AgentMailboxSettings view={agentMailbox} />
      <LinearSettings linear={linear} connection={linearHere} workspaceName={user.workspaceName} canAdmin={canAdmin} />
      <ApiSettings origin={origin} scopes={[...SCOPES]} />
      <WebhooksSettings endpoints={endpoints} deliveries={deliveries} canAdmin={canAdmin} />
    </SettingsPage>
  );
}
