import { redirect } from "next/navigation";
import ActionsScreen from "@/components/crm/actions-screen";
import { getUserActor } from "@/lib/auth/user";
import { getClickUpPicker } from "@/lib/crm/clickup";
import { listCompanies } from "@/lib/crm/companies";
import { countTaskViews, getDueActions } from "@/lib/crm/relationships";
import { DEFAULT_TASK_VIEW, taskViewFromParam } from "@/lib/crm/task-views";

export const dynamic = "force-dynamic";

function requestTime() {
  return Date.now();
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const view =
    taskViewFromParam(typeof resolved.view === "string" ? resolved.view : null) ?? DEFAULT_TASK_VIEW;
  const [due, counts, companies, clickup] = await Promise.all([
    getDueActions(user, view),
    countTaskViews(user),
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
    getClickUpPicker(user),
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
      counts={counts}
      tasks={due.tasks}
      companies={due.companies}
      companyChoices={companies.data}
      clickup={clickup}
      now={requestTime()}
    />
  );
}
