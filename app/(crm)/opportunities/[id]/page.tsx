import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import OpportunityRecord from "@/components/crm/opportunity-record";
import { getUserActor } from "@/lib/auth/user";
import { listMembers } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { opportunityHref } from "@/lib/crm/hrefs";
import { getMailbox } from "@/lib/crm/inbox";
import { getOpportunity, listPipeline } from "@/lib/crm/opportunities";
import { stageHistory } from "@/lib/crm/pipeline-history";
import { getCompanyContext } from "@/lib/crm/relationships";

export const dynamic = "force-dynamic";

const loadOpportunity = cache(async (id: string) => {
  const user = await getUserActor();
  if (!user) return { user: null, opportunity: null };
  const opportunity = await getOpportunity(user, id).catch((error: unknown) => {
    if (error instanceof CrmError && error.code === "not_found") return null;
    throw error;
  });
  return { user, opportunity };
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { opportunity } = await loadOpportunity(id);
  return { title: opportunity?.name ?? "Opportunity not found" };
}

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, opportunity } = await loadOpportunity(id);
  if (!user) redirect("/login");
  if (!opportunity || opportunity.archivedAt) notFound();
  if (opportunity.pipelineKind === "board") redirect(opportunityHref(opportunity));

  const [pipeline, context, members, mailbox, history] = await Promise.all([
    listPipeline(user, opportunity.pipelineId),
    getCompanyContext(user, opportunity.companyId),
    listMembers(user),
    getMailbox(user),
    stageHistory(user, opportunity.id),
  ]);

  return (
    <OpportunityRecord
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName }}
      opportunity={opportunity}
      stages={pipeline.stages}
      stays={history.stays}
      context={context}
      members={members}
      mailboxConnected={mailbox?.status === "connected"}
    />
  );
}
