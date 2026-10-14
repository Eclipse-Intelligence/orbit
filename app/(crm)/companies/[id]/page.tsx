import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import CompanyRecord from "@/components/companies/company-record";
import { getUserActor } from "@/lib/auth/user";
import { getClickUpPicker } from "@/lib/crm/clickup";
import { listMembers } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { getMailbox } from "@/lib/crm/inbox";
import { getCompanyContext } from "@/lib/crm/relationships";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  const [members, mailbox, clickup] = await Promise.all([
    listMembers(user),
    getMailbox(user),
    getClickUpPicker(user),
  ]);

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
    />
  );
}
