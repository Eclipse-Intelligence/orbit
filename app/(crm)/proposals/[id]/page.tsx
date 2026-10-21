import { notFound, redirect } from "next/navigation";
import ProposalDetail from "@/components/proposals/proposal-detail";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { getDocument } from "@/lib/proposals/documents";

export const dynamic = "force-dynamic";

export const metadata = { title: "Proposal" };

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const { id } = await params;
  const document = await getDocument(user, id).catch((error) => {
    if (error instanceof CrmError && error.status === 404) return null;
    throw error;
  });
  if (!document) notFound();
  return (
    <ProposalDetail
      key={`${document.id}-${document.status}-${document.version?.id ?? "draft"}`}
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName }}
      initial={document}
    />
  );
}
