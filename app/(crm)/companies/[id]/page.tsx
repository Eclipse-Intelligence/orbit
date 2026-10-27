import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import CompanyRecord from "@/components/companies/company-record";
import { getUserActor } from "@/lib/auth/user";
import { enrichmentAvailability } from "@/lib/enrichment/settings";
import { getMeetings } from "@/lib/crm/calendar";
import { getClickUpPicker } from "@/lib/crm/clickup";
import { listMembers } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { getMailbox } from "@/lib/crm/inbox";
import { getCompanyContext } from "@/lib/crm/relationships";
import { listTags } from "@/lib/crm/tags";
import { manualWorkflows } from "@/lib/workflows/store";
import { listDocuments } from "@/lib/proposals/documents";
import { resumeStale, scheduleIndexing } from "@/lib/knowledge/background";
import { backfillCalls } from "@/lib/knowledge/calls";
import { listKnowledge } from "@/lib/knowledge/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const loadCompany = cache(async (id: string) => {
  const user = await getUserActor();
  if (!user) return { user: null, context: null };
  const context = await getCompanyContext(user, id).catch((error: unknown) => {
    if (error instanceof CrmError && error.code === "not_found") return null;
    throw error;
  });
  return { user, context };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { context } = await loadCompany(id);
  return { title: context?.company.name ?? "Company not found" };
}

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, context } = await loadCompany(id);
  if (!user) redirect("/login");
  if (!context) notFound();

  const backfilled = await backfillCalls(user, context.company.id).catch((error: unknown) => {
    console.error("Call backfill failed", error);
    return [];
  });
  scheduleIndexing(user, backfilled);
  const [members, mailbox, clickup, meetings, tags, workflows, proposals, knowledge] = await Promise.all([
    listMembers(user),
    getMailbox(user),
    getClickUpPicker(user),
    getMeetings(user, { companyId: context.company.id }),
    listTags(user),
    manualWorkflows(user, "company"),
    listDocuments(user, { companyId: context.company.id, limit: 20 }),
    listKnowledge(user, { companyId: context.company.id }).catch((error: unknown) => {
      console.error("Knowledge failed to load", error);
      return [];
    }),
  ]);
  resumeStale(user, knowledge);

  return (
    <CompanyRecord
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      context={context}
      members={members}
      mailboxConnected={mailbox?.status === "connected"}
      clickup={clickup}
      meetings={meetings}
      workflows={workflows}
      proposals={proposals}
      knowledge={knowledge}
      tags={tags}
      enrichment={enrichmentAvailability()}
    />
  );
}
