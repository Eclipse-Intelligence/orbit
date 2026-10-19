import { redirect } from "next/navigation";
import WorkflowsScreen from "@/components/workflows/workflows-screen";
import { getUserActor } from "@/lib/auth/user";
import { listApprovals, listWorkflows } from "@/lib/workflows/store";
import { STARTER_TEMPLATES } from "@/lib/workflows/templates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata = { title: "Workflows" };

export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const params = await searchParams;
  const [workflows, approvals] = await Promise.all([listWorkflows(user), listApprovals(user)]);
  return (
    <WorkflowsScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      mine={workflows.mine}
      shared={workflows.templates.filter((item) => !item.mine)}
      starters={STARTER_TEMPLATES.map((item) => ({ key: item.key, name: item.name, description: item.description }))}
      approvals={approvals}
      focus={typeof params.approve === "string" ? params.approve : null}
    />
  );
}
