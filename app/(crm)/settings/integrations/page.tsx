import { redirect } from "next/navigation";
import AiAccountsSettings from "@/components/crm/ai-accounts-settings";
import ClickUpSettings from "@/components/crm/clickup-settings";
import IntegrationsSettings from "@/components/crm/integrations-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { listAiAccounts } from "@/lib/ai-accounts/store";
import { getUserActor } from "@/lib/auth/user";
import { listCompanions } from "@/lib/companion/pairing";
import { getCallSync } from "@/lib/crm/calls";
import { getClickUpSettings } from "@/lib/crm/clickup";
import { getGranolaStatus } from "@/lib/crm/granola";
import { getMailbox } from "@/lib/crm/inbox";
import { microsoftConfigured } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";

export default async function IntegrationSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [mailbox, granola, clickup, aiAccounts, companions] = await Promise.all([
    getMailbox(user),
    getGranolaStatus(user),
    getClickUpSettings(user),
    listAiAccounts(user),
    listCompanions(user),
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
      />
      <ClickUpSettings view={clickup} canAdmin={canAdmin} />
      <AiAccountsSettings accounts={aiAccounts} companions={companions} />
    </SettingsPage>
  );
}
