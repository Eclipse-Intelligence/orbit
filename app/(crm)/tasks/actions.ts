"use server";

import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import { discussionCounts } from "@/lib/crm/chat";
import { listMembers } from "@/lib/crm/companies";
import { getDueActions, MAX_OFFSET } from "@/lib/crm/relationships";
import { listTaskParticipants } from "@/lib/crm/tasks";
import type { Company, Task, TaskView } from "@/lib/crm/types";
import { TASK_VIEWS } from "@/lib/crm/types";

export type MoreTasks = {
  tasks: Task[];
  companies: Company[];
  total: number;
  tagged: Record<string, string[]>;
  discussions: Record<string, number>;
};

export async function moreTasksAction(input: { view: TaskView; who: "mine" | "tagged" | "everyone"; offset: number }): Promise<MoreTasks | { error: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  if (!(TASK_VIEWS as readonly string[]).includes(input?.view) || !Number.isInteger(input?.offset) || input.offset < 0 || input.offset > MAX_OFFSET) {
    return { error: "Couldn't load more. Try again." };
  }
  try {
    const members = await listMembers(user);
    const team = members.length > 1;
    const shared = team && (user.role === "owner" || user.role === "admin");
    const who = shared && input.who === "everyone" ? "everyone" : team && input.who === "tagged" ? "tagged" : "mine";
    const view = who === "tagged" && input.view === "none" ? "all" : input.view;
    const due = await getDueActions(user, view, { mine: who === "mine", tagged: who === "tagged", offset: input.offset });
    const ids = due.tasks.map((task) => task.id);
    const [tagged, discussions] = await Promise.all([team ? listTaskParticipants(user, ids) : Promise.resolve({}), discussionCounts(user, "task", ids)]);
    return { tasks: due.tasks, companies: due.companies, total: due.total, tagged, discussions };
  } catch (error) {
    return { error: actionError(error).error ?? "Couldn't load more. Try again." };
  }
}
