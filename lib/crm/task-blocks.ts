import { listMembers } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { listPlannerTasks, listTaskParticipants, readTaskInDb } from "@/lib/crm/tasks";
import type { Task, UserActor } from "@/lib/crm/types";
import { listOwnSeries } from "@/lib/crm/upcoming";
import { workspaceActors } from "@/lib/crm/workspaces";
import { dateKey } from "@/lib/calendar-view";
import { blocksInRange, taskBlocks, upcomingBlocks, type ClashCandidate, type PlannerWorkspace, type UpcomingSeries } from "@/lib/task-blocks";

export type PlannerTeam = {
  id: string;
  name: string;
  members: { id: string; name: string }[];
};

export type Planner = {
  tasks: Task[];
  workspaces: PlannerWorkspace[];
  teams: PlannerTeam[];
  tagged: Record<string, string[]>;
  series: UpcomingSeries[];
  seriesTasks: Task[];
};

export async function readPlannerTasks(actor: UserActor, now = Date.now(), options: { links?: boolean } = {}) {
  const actors = await workspaceActors(actor).catch(() => [actor]);
  const read = await Promise.all(
    actors.map(async (target) => ({ target, tasks: await listPlannerTasks(target, now, options) })),
  );
  return {
    actors,
    workspaces: actors.map((target) => ({ id: target.workspaceId, name: target.workspaceName })),
    read,
  };
}

export async function readPlanner(actor: UserActor, now = Date.now()): Promise<Planner> {
  const { workspaces, read } = await readPlannerTasks(actor, now, { links: true });
  const series = await listOwnSeries(actor, workspaces.map((workspace) => workspace.id));
  const listed = new Set(read.flatMap((entry) => entry.tasks.map((task) => task.id)));
  const seriesTasks = (
    await Promise.all(
      read.map(({ target }) => {
        const ids = series.filter((item) => item.workspaceId === target.workspaceId && item.anchorTaskId && !listed.has(item.anchorTaskId)).map((item) => item.anchorTaskId!);
        if (ids.length === 0) return [];
        return withActor(target, async (db) => {
          const found: Task[] = [];
          for (const id of ids) {
            const task = await readTaskInDb(db, target, id);
            if (task && !task.archivedAt) found.push(task);
          }
          return found;
        });
      }),
    )
  ).flat();
  const teams = await Promise.all(
    read.map(async ({ target, tasks }) => {
      const members = tasks.length > 0 ? await listMembers(target) : [];
      const team = members.length > 1;
      const tagged = team ? await listTaskParticipants(target, tasks.map((task) => task.id)) : {};
      return {
        team: {
          id: target.workspaceId,
          name: target.workspaceName,
          members: team ? members.map((member) => ({ id: member.id, name: member.name })) : [],
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
    series,
    seriesTasks,
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

export async function listUpcomingBlocks(actor: UserActor, range: { start: Date; end: Date }, meetings: ClashCandidate[] = [], now = Date.now()) {
  const actors = await workspaceActors(actor).catch(() => [actor]);
  const workspaces = actors.map((target) => ({ id: target.workspaceId, name: target.workspaceName }));
  const series = await listOwnSeries(actor, workspaces.map((workspace) => workspace.id));
  const blocks = upcomingBlocks(series, {
    viewerId: actor.userId,
    from: dateKey(range.start),
    to: dateKey(range.end.getTime() - 1),
    today: dateKey(now),
    meetings,
    workspaces,
  });
  return blocks.filter((block) => !block.task.dueHasTime || (Date.parse(block.startsAt) < range.end.getTime() && Date.parse(block.endsAt) > range.start.getTime()));
}
