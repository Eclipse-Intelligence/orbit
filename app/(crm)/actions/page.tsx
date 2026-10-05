import { redirect } from "next/navigation";
import ActionsScreen from "@/components/crm/actions-screen";
import { getUserActor } from "@/lib/auth/user";
import { listCompanies } from "@/lib/crm/companies";
import { getDueActions } from "@/lib/crm/relationships";
import { TASK_VIEWS, type TaskView } from "@/lib/crm/types";

export const dynamic = "force-dynamic";

export default async function ActionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const requested = typeof resolved.view === "string" ? resolved.view : "today";
  const view = (TASK_VIEWS as readonly string[]).includes(requested)
    ? (requested as TaskView)
    : "today";
  const [due, companies] = await Promise.all([
    getDueActions(user, view),
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
  ]);

  return (
    <ActionsScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      view={view}
      tasks={due.tasks}
      companies={due.companies}
      companyChoices={companies.data}
    />
  );
}
