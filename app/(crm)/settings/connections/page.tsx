import { redirect } from "next/navigation";
import AiAccountsSettings from "@/components/crm/ai-accounts-settings";
import { GranolaSettings, ReadwiseSettings, RecallSettings, SettingsNotices, TeamsCallsSettings } from "@/components/crm/connection-cards";
import { SettingsPage } from "@/components/crm/settings-ui";
import LinkedinCaptureSettings from "@/components/extension/linkedin-capture-settings";
import { listAiAccounts } from "@/lib/ai-accounts/store";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { listCompanions } from "@/lib/companion/pairing";
import { getCallSync } from "@/lib/crm/calls";
import { getGranolaStatus } from "@/lib/crm/granola";
import { getMailbox } from "@/lib/crm/inbox";
import { getTeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";
import { listBrowsers } from "@/lib/extension/pairing";
import { browserRows, extensionDownloadUrl } from "@/lib/extension/settings";
import { microsoftConfigured } from "@/lib/microsoft/oauth";
import { readwiseStatus } from "@/lib/readwise/keys";
import { recallStatus } from "@/lib/recall/keys";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function ConnectionsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const notice = typeof resolved.error === "string" ? resolved.error : null;
  const info = typeof resolved.info === "string" ? resolved.info : null;
  const [mailbox, granola, readwise, recall, aiAccounts, companions, browsers, workspaces] = await Promise.all([
    getMailbox(user),
    getGranolaStatus(user),
    readwiseStatus(user),
    recallStatus(user),
    listAiAccounts(user),
    listCompanions(user),
    listBrowsers(user),
    getWorkspaceChoices(),
  ]);
  const live = mailbox?.status === "connected";
  const [calls, transcripts] = await Promise.all([
    mailbox ? getCallSync(user) : Promise.resolve(null),
    live ? getTeamsTranscriptStatus(user) : Promise.resolve(null),
  ]);
  const canAdmin = user.role === "owner" || user.role === "admin";
  return (
    <SettingsPage title="Connections">
      <SettingsNotices notice={notice} info={info} />
      <TeamsCallsSettings configured={microsoftConfigured()} mailbox={mailbox} calls={calls} transcripts={transcripts} />
      <GranolaSettings granola={granola} canAdmin={canAdmin} />
      <ReadwiseSettings readwise={readwise} workspaces={workspaces.map((item) => ({ id: item.id, name: item.name }))} />
      <RecallSettings recall={recall} />
      <LinkedinCaptureSettings
        browsers={browserRows(browsers)}
        workspaces={workspaces.map((item) => ({ id: item.id, name: item.name }))}
        extensionUrl={extensionDownloadUrl()}
      />
      <AiAccountsSettings accounts={aiAccounts} companions={companions} />
    </SettingsPage>
  );
}
