import { listMembers } from "@/lib/crm/companies";
import { listPlannerTasks, listTaskParticipants } from "@/lib/crm/tasks";
import type { Task, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { workspaceActors } from "@/lib/crm/workspaces";
import { blocksInRange, taskBlocks, type ClashCandidate, type PlannerWorkspace } from "@/lib/task-blocks";

export type PlannerTeam = {
  id: string;
  name: string;
  role: WorkspaceRole;
  members: { id: string; name: string }[];
  admins: string[];
};

export type Planner = {
  tasks: Task[];
  workspaces: PlannerWorkspace[];
  teams: PlannerTeam[];
  tagged: Record<string, string[]>;
};

export async function readPlannerTasks(actor: UserActor, now = Date.now()) {
  const actors = await workspaceActors(actor).catch(() => [actor]);
  const read = await Promise.all(
    actors.map(async (target) => ({ target, tasks: await listPlannerTasks(target, now) })),
  );
  return {
    actors,
    workspaces: actors.map((target) => ({ id: target.workspaceId, name: target.workspaceName })),
    read,
  };
}

export async function readPlanner(actor: UserActor, now = Date.now()): Promise<Planner> {
  const { workspaces, read } = await readPlannerTasks(actor, now);
  const teams = await Promise.all(
    read.map(async ({ target, tasks }) => {
      const members = tasks.length > 0 ? await listMembers(target) : [];
      const team = members.length > 1;
      const tagged = team ? await listTaskParticipants(target, tasks.map((task) => task.id)) : {};
      return {
        team: {
          id: target.workspaceId,
          name: target.workspaceName,
          role: target.role,
          members: team ? members.map((member) => ({ id: member.id, name: member.name })) : [],
          admins: members.filter((member) => member.role === "owner" || member.role === "admin").map((member) => member.id),
        },
        tagged,
      };
    }),
  );
  return {
    tasks: read.flatMap((entry) => entry.tasks),
    workspaces,
    teams: teams.map((entry) => entry.team),
    tagged: Object.assign({}, ...teams.map((entry) => entry.tagged)),
  };
}

export async function listTaskBlocks(actor: UserActor, range: { start: Date; end: Date }, meetings: ClashCandidate[] = [], now = Date.now()) {
  const { workspaces, read } = await readPlannerTasks(actor, now);
  const blocks = taskBlocks(
    read.flatMap((entry) => entry.tasks),
    { viewerId: actor.userId, now, meetings, workspaces },
  );
  return blocksInRange(blocks, range);
}
