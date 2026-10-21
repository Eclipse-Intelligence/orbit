import { notFound, redirect } from "next/navigation";
import TemplateEditor from "@/components/proposals/template-editor";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { getTemplate } from "@/lib/proposals/catalogue";

export const dynamic = "force-dynamic";

export const metadata = { title: "Proposal template" };

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const { id } = await params;
  const template = await getTemplate(user, id).catch((error) => {
    if (error instanceof CrmError && error.status === 404) return null;
    throw error;
  });
  if (!template) notFound();
  return (
    <TemplateEditor
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName }}
      template={template}
    />
  );
}
