import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { GrokCard, LearningStatusCard, MarketNotesCard, MemoriesCard, WatchlistCard } from "@/components/crm/learning-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor } from "@/lib/auth/user";
import { grokRoutine, marketAgentStatus } from "@/lib/learning/grok";
import { listMarketNotes, listWatchlist } from "@/lib/learning/market";
import { listMemories } from "@/lib/learning/memories";
import { learningStatus } from "@/lib/learning/nightly";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function LearningSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const canAdmin = user.role === "owner" || user.role === "admin";
  const [personal, business, market, watchlist, notes, statuses, grok, headerStore] = await Promise.all([
    listMemories(user, { scope: "personal", limit: 200 }),
    listMemories(user, { scope: "business", limit: 200 }),
    listMemories(user, { scope: "market", limit: 200 }),
    listWatchlist(user),
    listMarketNotes(user, { limit: 30 }),
    learningStatus(user),
    marketAgentStatus(user).catch(() => null),
    headers(),
  ]);
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:4173";
  const mcpUrl = `${headerStore.get("x-forwarded-proto") ?? "http"}://${host}/api/mcp`;
  return (
    <SettingsPage
      title="Learning"
      description="What Orbit's assistant has learned about you, the business and the market, the watchlist Grok Bot researches, and the market notes it sends."
    >
      <LearningStatusCard statuses={statuses} canRunShared={canAdmin} />
      <MemoriesCard memories={{ personal, business, market }} />
      <WatchlistCard items={watchlist} />
      <MarketNotesCard notes={notes} />
      <GrokCard status={grok} mcpUrl={mcpUrl} routine={grokRoutine(mcpUrl)} canConnect={canAdmin} />
    </SettingsPage>
  );
}
