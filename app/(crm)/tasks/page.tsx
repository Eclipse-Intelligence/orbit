import { redirect } from "next/navigation";
import ActionsScreen from "@/components/crm/actions-screen";
import { getUserActor } from "@/lib/auth/user";
import { getClickUpPicker } from "@/lib/crm/clickup";
import { listMembers } from "@/lib/crm/companies";
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
  const members = await listMembers(user);
  const shared = members.length > 1 && (user.role === "owner" || user.role === "admin");
  const who = shared && resolved.who === "everyone" ? "everyone" : "mine";
  const mine = who === "mine";
  const [due, counts, clickup] = await Promise.all([
    getDueActions(user, view, { mine }),
    countTaskViews(user, { mine }),
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
      clickup={clickup}
      now={requestTime()}
      who={who}
      shared={shared}
    />
  );
}
