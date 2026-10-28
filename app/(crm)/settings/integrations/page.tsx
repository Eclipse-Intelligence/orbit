import { redirect } from "next/navigation";
import AiAccountsSettings from "@/components/crm/ai-accounts-settings";
import ClickUpSettings from "@/components/crm/clickup-settings";
import EnrichmentSettingsCard from "@/components/crm/enrichment-settings";
import WebChecksSettings from "@/components/crm/web-checks-settings";
import IntegrationsSettings from "@/components/crm/integrations-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { listAiAccounts } from "@/lib/ai-accounts/store";
import { getUserActor } from "@/lib/auth/user";
import { listCompanions } from "@/lib/companion/pairing";
import { unenrichedCompanyCount } from "@/lib/enrichment/companies";
import { enrichmentAvailability, getEnrichmentSettings, providerStatuses } from "@/lib/enrichment/settings";
import { learnedIcp, listWebChecks, uncheckedCompanyCount, webChecksConfigured } from "@/lib/enrichment/web-checks";
import { getCallSync } from "@/lib/crm/calls";
import { getClickUpSettings } from "@/lib/crm/clickup";
import { getGranolaStatus } from "@/lib/crm/granola";
import { getMailbox } from "@/lib/crm/inbox";
import { linearStatus } from "@/lib/linear";
import { microsoftConfigured } from "@/lib/microsoft/oauth";
import { readwiseStatus } from "@/lib/readwise/keys";
import { recallStatus } from "@/lib/recall/keys";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function IntegrationSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [mailbox, granola, readwise, recall, clickup, aiAccounts, companions, linear] = await Promise.all([
    getMailbox(user),
    getGranolaStatus(user),
    readwiseStatus(user),
    recallStatus(user),
    getClickUpSettings(user),
    listAiAccounts(user),
    listCompanions(user),
    linearStatus(),
  ]);
  const [enrichment, unenriched, webChecks, unchecked, learned] = await Promise.all([
    getEnrichmentSettings(user),
    unenrichedCompanyCount(user),
    listWebChecks(user),
    uncheckedCompanyCount(user),
    learnedIcp(user),
  ]);
  const calls = mailbox ? await getCallSync(user) : null;
  const canAdmin = user.role === "owner" || user.role === "admin";
  return (
    <SettingsPage
      title="Integrations"
      description="The services Orbit reads from and writes to, and where to manage each one."
    >
      <IntegrationsSettings
        configured={microsoftConfigured()}
        mailbox={mailbox}
        calls={calls}
        granola={granola}
        readwise={readwise}
        recall={recall}
        linear={linear}
      />
      <ClickUpSettings view={clickup} canAdmin={canAdmin} />
      <AiAccountsSettings accounts={aiAccounts} companions={companions} />
      <EnrichmentSettingsCard
        settings={enrichment}
        providers={providerStatuses()}
        canAdmin={canAdmin}
        unenriched={unenriched}
        logoLinkReady={Boolean(enrichmentAvailability().logoClientId)}
      />
      <WebChecksSettings settings={enrichment} checks={webChecks} configured={webChecksConfigured()} canAdmin={canAdmin} unchecked={unchecked} learnedIcp={learned} />
    </SettingsPage>
  );
}
