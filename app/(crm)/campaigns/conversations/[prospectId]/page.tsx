import ConversationsPage from "../conversations-page";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata = { title: "Conversations" };

export default async function CampaignConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ prospectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ prospectId }, query] = await Promise.all([params, searchParams]);
  return <ConversationsPage prospectId={prospectId} params={query} />;
}
