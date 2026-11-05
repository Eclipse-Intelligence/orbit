import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AgentMailboxSettings from "@/components/crm/agent-mailbox-settings";
import AiAccountsSettings from "@/components/crm/ai-accounts-settings";
import ClickUpSettings from "@/components/crm/clickup-settings";
import EnrichmentSettingsCard from "@/components/crm/enrichment-settings";
import WebChecksSettings from "@/components/crm/web-checks-settings";
import IntegrationsSettings from "@/components/crm/integrations-settings";
import MailRoutingSettings from "@/components/mail/mail-routing-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { agentMailboxView } from "@/lib/agent-mail/mailbox";
import { listAiAccounts } from "@/lib/ai-accounts/store";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { listAddressHomes, listDomainRules } from "@/lib/mail/routing";
import { listCompanions } from "@/lib/companion/pairing";
import { unenrichedCompanyCount } from "@/lib/enrichment/companies";
import { enrichmentAvailability, getEnrichmentSettings, providerStatuses } from "@/lib/enrichment/settings";
import { learnedIcp, listWebChecks, uncheckedCompanyCount, webChecksConfigured } from "@/lib/enrichment/web-checks";
import { getCalendarStatus } from "@/lib/crm/calendar";
import { getCallSync } from "@/lib/crm/calls";
import { getClickUpSettings } from "@/lib/crm/clickup";
import { getGranolaStatus } from "@/lib/crm/granola";
import { getMailbox } from "@/lib/crm/inbox";
import { getTeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";
import { linearStatus } from "@/lib/linear";
import { mailSyncStatus } from "@/lib/mail/store";
import { microsoftConfigured, microsoftRedirectUri } from "@/lib/microsoft/oauth";
import { readwiseStatus } from "@/lib/readwise/keys";
import { recallStatus } from "@/lib/recall/keys";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function IntegrationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const notice = typeof resolved.error === "string" ? resolved.error : null;
  const info = typeof resolved.info === "string" ? resolved.info : null;
  const connected = resolved.connected === "1";
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
  const [enrichment, unenriched, webChecks, unchecked, learned, agentMailbox] = await Promise.all([
    getEnrichmentSettings(user),
    unenrichedCompanyCount(user),
    listWebChecks(user),
    uncheckedCompanyCount(user),
    learnedIcp(user),
    agentMailboxView(user),
  ]);
  const live = mailbox?.status === "connected";
  const [calls, transcripts, calendar, mirror, workspaces, homes, rules] = await Promise.all([
    mailbox ? getCallSync(user) : Promise.resolve(null),
    live ? getTeamsTranscriptStatus(user) : Promise.resolve(null),
    live ? getCalendarStatus(user) : Promise.resolve(null),
    mailSyncStatus(user),
    getWorkspaceChoices(),
    listAddressHomes(user).catch(() => []),
    listDomainRules(user).catch(() => []),
  ]);
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:4173";
  const proto = headerStore.get("x-forwarded-proto") ?? "http";
  const canAdmin = user.role === "owner" || user.role === "admin";
  return (
    <SettingsPage
      title="Integrations"
      description="The services Orbit reads from and writes to, and where to manage each one."
    >
      <IntegrationsSettings
        configured={microsoftConfigured()}
        redirectUri={microsoftRedirectUri(`${proto}://${host}`)}
        mailbox={mailbox}
        calls={calls}
        transcripts={transcripts}
        calendar={calendar}
        mirror={mirror}
        canAdmin={canAdmin}
        notice={notice}
        info={info}
        connected={connected}
        granola={granola}
        readwise={readwise}
        recall={recall}
        linear={linear}
      />
      {workspaces.length > 1 && homes.length > 0 && (
        <MailRoutingSettings homes={homes} rules={rules} workspaces={workspaces.map((item) => ({ id: item.id, name: item.name }))} />
      )}
      <ClickUpSettings view={clickup} canAdmin={canAdmin} />
      <AiAccountsSettings accounts={aiAccounts} companions={companions} />
      <AgentMailboxSettings view={agentMailbox} />
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
