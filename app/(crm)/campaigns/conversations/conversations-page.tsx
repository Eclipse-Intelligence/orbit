import { notFound, redirect } from "next/navigation";
import ConversationsScreen from "@/components/campaigns/conversations-screen";
import { getUserActor } from "@/lib/auth/user";
import { conversationFilters, readConversationView } from "@/lib/campaigns/conversation-view";
import { listConversations } from "@/lib/campaigns/conversations";
import { getProspectThread } from "@/lib/campaigns/threads";
import { listCampaigns } from "@/lib/crm/campaigns";
import { CrmError } from "@/lib/crm/errors";

export default async function ConversationsPage({ prospectId, params }: { prospectId: string | null; params: Record<string, string | string[] | undefined> }) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const view = readConversationView(params);
  const [list, campaigns, thread] = await Promise.all([
    listConversations(user, conversationFilters(view)),
    listCampaigns(user),
    prospectId
      ? getProspectThread(user, prospectId).catch((error: unknown) => {
          if (error instanceof CrmError && error.status === 404) return null;
          throw error;
        })
      : Promise.resolve(null),
  ]);
  if (prospectId && !thread) notFound();
  return (
    <ConversationsScreen
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName, workspaceId: user.workspaceId }}
      list={list}
      view={view}
      campaigns={campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name }))}
      thread={thread}
      canAct={user.scopes.includes("campaigns:write")}
    />
  );
}
