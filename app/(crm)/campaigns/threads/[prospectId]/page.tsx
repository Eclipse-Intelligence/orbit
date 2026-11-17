import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import ThreadScreen from "@/components/campaigns/thread-screen";
import { getUserActor } from "@/lib/auth/user";
import { getProspectThread } from "@/lib/campaigns/threads";
import { CrmError } from "@/lib/crm/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const loadThread = cache(async (prospectId: string) => {
  const user = await getUserActor();
  if (!user) return { user: null, thread: null };
  const thread = await getProspectThread(user, prospectId).catch((error: unknown) => {
    if (error instanceof CrmError && error.status === 404) return null;
    throw error;
  });
  return { user, thread };
});

export async function generateMetadata({ params }: { params: Promise<{ prospectId: string }> }): Promise<Metadata> {
  const { prospectId } = await params;
  const { thread } = await loadThread(prospectId);
  return { title: thread?.person.name ?? "Thread" };
}

export default async function CampaignThreadPage({ params }: { params: Promise<{ prospectId: string }> }) {
  const { prospectId } = await params;
  const { user, thread } = await loadThread(prospectId);
  if (!user) redirect("/login");
  if (!thread) notFound();
  return (
    <ThreadScreen
      key={thread.prospectId}
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName, workspaceId: user.workspaceId }}
      thread={thread}
      canAct={user.scopes.includes("campaigns:write")}
    />
  );
}
