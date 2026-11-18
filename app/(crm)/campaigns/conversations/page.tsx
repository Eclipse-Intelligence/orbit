import ConversationsPage from "./conversations-page";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata = { title: "Conversations" };

export default async function CampaignConversationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ConversationsPage prospectId={null} params={await searchParams} />;
}
