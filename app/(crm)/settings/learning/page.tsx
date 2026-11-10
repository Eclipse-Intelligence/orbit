import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { GrokCard, LearningStatusCard, MarketNotesCard, MemoriesCard, WatchlistCard } from "@/components/crm/learning-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor } from "@/lib/auth/user";
import { grokRoutine, marketAgentStatus } from "@/lib/learning/grok";
import { listMarketNotes, listWatchlist } from "@/lib/learning/market";
import { listMemories } from "@/lib/learning/memories";
import { learningStatus } from "@/lib/learning/nightly";
import { workspaceActors } from "@/lib/crm/workspaces";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function LearningSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const canAdmin = user.role === "owner" || user.role === "admin";
  const [personal, business, market, watchlist, notes, statuses, grok, headerStore, workspaces] = await Promise.all([
    listMemories(user, { scope: "personal", limit: 200, allWorkspaces: true }),
    listMemories(user, { scope: "business", limit: 200 }),
    listMemories(user, { scope: "market", limit: 200 }),
    listWatchlist(user),
    listMarketNotes(user, { limit: 30 }),
    learningStatus(user),
    marketAgentStatus(user).catch(() => null),
    headers(),
    workspaceActors(user).catch(() => [user]),
  ]);
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:4173";
  const manyWorkspaces = workspaces.length > 1;
  const mcpUrl = `${headerStore.get("x-forwarded-proto") ?? "http"}://${host}/api/mcp`;
  return (
    <SettingsPage title="Learning">
      <LearningStatusCard statuses={statuses} canRunShared={canAdmin} />
      <MemoriesCard
        id="notes"
        heading="Notes"
        scopes={manyWorkspaces ? ["business", "market"] : ["personal", "business", "market"]}
        memories={{ personal, business, market }}
        workspaceName={user.workspaceName}
        manyWorkspaces={manyWorkspaces}
      />
      <WatchlistCard items={watchlist} />
      <MarketNotesCard notes={notes} />
      <GrokCard status={grok} mcpUrl={mcpUrl} routine={grokRoutine(mcpUrl, user.workspaceName)} canConnect={canAdmin} />
    </SettingsPage>
  );
}
