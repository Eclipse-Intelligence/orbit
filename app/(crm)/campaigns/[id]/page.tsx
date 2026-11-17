import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import CampaignScreen from "@/components/campaigns/campaign-screen";
import MailboxHealth from "@/components/campaigns/mailbox-health";
import { getUserActor } from "@/lib/auth/user";
import { connectionStates } from "@/lib/campaigns/connections";
import { campaignSyncLine } from "@/lib/campaigns/format";
import { PROSPECT_FILTERS, type ProspectFilter } from "@/lib/campaigns/types";
import { campaignMailboxes, getCampaign, listCampaignProspects } from "@/lib/crm/campaigns";
import { CrmError } from "@/lib/crm/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata = { title: "Campaign" };

function param(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

async function Mailboxes({ load }: { load: () => ReturnType<typeof campaignMailboxes> }) {
  const health = await load().catch((error) => {
    console.error("Couldn't read campaign mailboxes", error);
    return { mailboxes: [], error: "Couldn't read the mailboxes. Try again." };
  });
  return <MailboxHealth health={health} />;
}

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const { id } = await params;
  const query = await searchParams;
  const filter = (PROSPECT_FILTERS as readonly string[]).includes(param(query.show)) ? (param(query.show) as ProspectFilter) : "all";
  const search = param(query.q);
  const page = Math.max(1, Math.min(Number(param(query.page)) || 1, 1000));
  const loaded = await Promise.all([getCampaign(user, id), listCampaignProspects(user, id, { filter, search, page }), connectionStates(user)]).catch((error) => {
    if (error instanceof CrmError && error.status === 404) return null;
    throw error;
  });
  if (!loaded) notFound();
  const [campaign, prospects, states] = loaded;
  const status = campaignSyncLine(campaign, states.find((item) => item.provider === campaign.provider));
  return (
    <CampaignScreen
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName, workspaceId: user.workspaceId }}
      campaign={campaign}
      prospects={prospects}
      syncLine={status}
      filter={filter}
      search={search}
      canImport={user.scopes.includes("contacts:write") && user.scopes.includes("campaigns:write")}
      mailboxes={
        campaign.channel === "email" ? (
          <Suspense fallback={<p className="ui-style text-subtle">Checking…</p>}>
            <Mailboxes load={() => campaignMailboxes(user, campaign.id)} />
          </Suspense>
        ) : null
      }
    />
  );
}
