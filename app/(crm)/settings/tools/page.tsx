import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AgentMailboxSettings from "@/components/crm/agent-mailbox-settings";
import ApiSettings from "@/components/crm/api-settings";
import ClickUpSettings from "@/components/crm/clickup-settings";
import { LinearSettings } from "@/components/crm/connection-cards";
import MetaLeadsSettings from "@/components/crm/meta-leads-settings";
import EnrichmentSettingsCard from "@/components/crm/enrichment-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import WebhooksSettings from "@/components/crm/webhooks-settings";
import { agentMailboxView } from "@/lib/agent-mail/mailbox";
import { getUserActor } from "@/lib/auth/user";
import { getClickUpSettings } from "@/lib/crm/clickup";
import { getMetaLeadSettings } from "@/lib/crm/meta-leads";
import { SCOPES } from "@/lib/crm/scopes";
import { listWebhookDeliveries, listWebhooks } from "@/lib/crm/webhooks";
import { unenrichedCompanyCount } from "@/lib/enrichment/companies";
import { enrichmentAvailability, getEnrichmentSettings, providerStatuses } from "@/lib/enrichment/settings";
import { linearStatus } from "@/lib/linear";
import { linearConnection } from "@/lib/crm/linear-connection";
import { siteOrigin } from "@/lib/site-url";

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
  const metaLeads = await getMetaLeadSettings(user, siteOrigin() ?? origin);
  return (
    <SettingsPage title="Tools">
      <ClickUpSettings view={clickup} canAdmin={canAdmin} isOwner={user.role === "owner"} />
      <EnrichmentSettingsCard
        settings={enrichment}
        providers={providerStatuses()}
        canAdmin={canAdmin}
        isOwner={user.role === "owner"}
        unenriched={unenriched}
        logoLinkReady={Boolean(enrichmentAvailability().logoClientId)}
      />
      <AgentMailboxSettings view={agentMailbox} isOwner={user.role === "owner"} />
      <MetaLeadsSettings view={metaLeads} canAdmin={canAdmin} />
      <LinearSettings linear={linear} connection={linearHere} workspaceName={user.workspaceName} canAdmin={canAdmin} isOwner={user.role === "owner"} />
      <ApiSettings origin={origin} scopes={[...SCOPES]} />
      <WebhooksSettings endpoints={endpoints} deliveries={deliveries} canAdmin={canAdmin} />
    </SettingsPage>
  );
}
