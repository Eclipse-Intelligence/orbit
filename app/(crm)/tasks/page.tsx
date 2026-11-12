import { redirect } from "next/navigation";
import ActionsScreen from "@/components/crm/actions-screen";
import { getUserActor } from "@/lib/auth/user";
import { TASK_PARAM } from "@/lib/chat/discussions";
import { discussionCounts } from "@/lib/crm/chat";
import { getClickUpPicker } from "@/lib/crm/clickup";
import { listMembers } from "@/lib/crm/companies";
import { countTaskViews, getDueActions } from "@/lib/crm/relationships";
import { DEFAULT_TASK_VIEW, TASKS_PATH, taskViewFromParam } from "@/lib/crm/task-views";
import { isUuid } from "@/lib/crm/mutate";
import { getTask, listTaskParticipants } from "@/lib/crm/tasks";

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
  const asked =
    taskViewFromParam(typeof resolved.view === "string" ? resolved.view : null) ?? DEFAULT_TASK_VIEW;
  const members = await listMembers(user);
  const team = members.length > 1;
  const shared = team && (user.role === "owner" || user.role === "admin");
  const who = shared && resolved.who === "everyone" ? "everyone" : team && resolved.who === "tagged" ? "tagged" : "mine";
  const scope = { mine: who === "mine", tagged: who === "tagged" };
  const view = scope.tagged && asked === "none" ? DEFAULT_TASK_VIEW : asked;
  const askedPages = typeof resolved.pages === "string" ? Number.parseInt(resolved.pages, 10) : 1;
  const pages = Number.isFinite(askedPages) && askedPages > 1 ? Math.min(askedPages, 100) : 1;
  const [due, counts, clickup] = await Promise.all([
    getDueActions(user, view, { ...scope, pages }),
    countTaskViews(user, scope),
    getClickUpPicker(user),
  ]);
  const askedTask = resolved[TASK_PARAM];
  const wanted = typeof askedTask === "string" && isUuid(askedTask) ? askedTask.toLowerCase() : null;
  const openTask = wanted && !due.tasks.some((task) => task.id === wanted) ? await getTask(user, wanted).catch(() => null) : null;
  const elsewhere = openTask && openTask.workspaceId !== user.workspaceId ? openTask : null;
  const original = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) original.append(key, item);
  }
  const switchTo = elsewhere ? `/open?workspace=${elsewhere.workspaceId}&to=${encodeURIComponent(`${TASKS_PATH}?${original.toString()}`)}` : null;
  const ids = [...due.tasks.map((task) => task.id), ...(openTask ? [openTask.id] : [])];
  const [tagged, taggedCount, discussions] = await Promise.all([
    team ? listTaskParticipants(user, ids) : Promise.resolve({}),
    !team ? Promise.resolve(0) : scope.tagged ? Promise.resolve(counts.all) : countTaskViews(user, { tagged: true }).then((views) => views.all),
    discussionCounts(user, "task", ids),
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
      members={team ? members.map((member) => ({ id: member.id, name: member.name })) : []}
      tagged={tagged}
      taggedCount={taggedCount}
      discussions={discussions}
      openTask={elsewhere ? null : openTask}
      switchTo={switchTo}
      total={due.total}
      pages={pages}
      admins={members.filter((member) => member.role === "owner" || member.role === "admin").map((member) => member.id)}
    />
  );
}
