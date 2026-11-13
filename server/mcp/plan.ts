import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import { buildPlan, pushScheduled, scheduleTasks } from "@/lib/crm/plan-schedule";
import { prepareAllowed, prepareTask } from "@/lib/crm/task-prepare";
import { actorForTask } from "@/lib/crm/workspaces";
import type { UserActor } from "@/lib/crm/types";
import { agentSource } from "@/lib/crm/validation";

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolFailure(error: unknown) {
  const message = error instanceof CrmError ? `${error.code}: ${error.message}` : "The CRM request failed.";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function run(work: () => Promise<unknown>) {
  try {
    return toolResult(await work());
  } catch (error) {
    return toolFailure(error);
  }
}

export function registerPlanTools(server: McpServer, actor: UserActor) {
  server.registerTool(
    "plan_tasks",
    {
      description:
        "Read Plan's proposal for the person's own open tasks, today and the next 14 days, from every workspace they're in. Nothing changes. placed lists proposed blocks (taskId, at, durationMinutes, group call, email or other): calls and meeting tasks go back to back and emails together, first at the times the person usually does each kind (learned from what they did by hand in the app over the last 90 days; until there's enough, calls late morning and emails after lunch), up to 6 tasks or 90 minutes a run, inside their working hours, clear of meetings (all but free, working elsewhere, declined and all-day ones) with 5 minutes after each, never on weekends off, bank holidays or in the past. A date-only task keeps its day, an undated one takes the earliest learned time in the next 3 working days or else the earliest day with room, and timed tasks stay put. placed and the other lists carry workspaceId. overdue lists overdue tasks with a suggested slot (at); they stay on their own day until moved with schedule_tasks and moveDay; unplaced lists tasks that couldn't fit, with nextFree and outside (outside working hours) times. Send the blocks the person agrees to with schedule_tasks.",
      inputSchema: {
        replan: z.boolean().optional().describe("Also move blocks Plan placed earlier, to another time on the same day. Blocks the person placed never move."),
      },
    },
    async (args) => run(async () => ({ plan: await buildPlan(actor, { replan: args.replan === true, ai: false, store: false }) })),
  );

  server.registerTool(
    "schedule_tasks",
    {
      description:
        "Put several of the person's own tasks on their calendar in one go, as Plan does, all or nothing: if any block breaks a rule, nothing changes. Each block is written with scheduledBy planner and gets its own task.updated event (operation schedule_tasks), and ClickUp is updated. Rules: a dated task keeps its day; an overdue one moves only when moveDay names the new day; a block the person placed (scheduledBy person) never moves unless it is overdue and moveDay names the new day; each slot must be inside their working hours, on a working day, not in the past, and clear of their other blocks and of meetings (all but free, working elsewhere, declined and all-day ones). Only send blocks the person asked for.",
      inputSchema: {
        schedule: z
          .array(
            z.object({
              taskId: z.uuid(),
              at: z.string().describe("Start, such as 2026-11-16T10:30 (London time) or an ISO instant."),
              durationMinutes: z.number().int().min(5).max(480).optional().describe("Length in minutes. Keeps the task's own when left out."),
              moveDay: z.string().optional().describe("Only for an overdue task: the new day as YYYY-MM-DD, matching at."),
            }),
          )
          .min(1)
          .max(100),
        provenanceSource: z.string().nullable().optional(),
        provenanceUrl: z.string().nullable().optional(),
      },
    },
    async (args) =>
      run(async () => {
        const scheduled = await scheduleTasks(actor, args.schedule, {
          mode: "agent",
          provenance: { operation: "schedule_tasks", source: agentSource(args.provenanceSource), sourceUrl: args.provenanceUrl },
        });
        await pushScheduled(scheduled);
        return { tasks: scheduled.map((item) => item.task) };
      }),
  );
}

export function registerPrepareTool(server: McpServer, actor: UserActor) {
  server.registerTool(
    "prepare_next_action",
    {
      description:
        "Prepare one of the person's call, meeting or email tasks, as Prepare does in the app: a call brief (who they are, last contact, opportunity stage, open points from the last call, talking points) or an email draft in their voice. It is built from the task, the shared records and the person's own email, stored for them alone, and replaces their earlier preparation of that task. Nothing is sent: a draft opens in compose in the app. get_next_action then returns it as preparation. Only prepare when the person asks.",
      inputSchema: { id: z.uuid() },
    },
    async (args) =>
      run(async () => {
        const home = await actorForTask(actor, args.id);
        if (!(await prepareAllowed(home))) throw new CrmError("rate_limited", "Too many requests. Try again in a few minutes.", 429);
        return { preparation: await prepareTask(home, args.id) };
      }),
  );
}
