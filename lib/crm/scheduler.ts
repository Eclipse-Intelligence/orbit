import { syncCalendar } from "@/lib/crm/calendar";
import { syncCalls } from "@/lib/crm/calls";
import { clickupActorFor, syncClickUp } from "@/lib/crm/clickup";
import {
  backgroundTargets,
  errorText,
  safeEqual,
  summarisePendingImports,
  type BackgroundTarget,
} from "@/lib/crm/conversations";
import { resolveGranolaActor, syncGranola } from "@/lib/crm/granola";
import { syncMailbox } from "@/lib/crm/inbox";
import { ensureTranscriptSubscription, syncTeamsTranscripts } from "@/lib/crm/teams-transcripts";
import type { UserActor } from "@/lib/crm/types";
import { granolaApiKey, granolaClient } from "@/lib/granola";
import { microsoftConfigured } from "@/lib/microsoft/oauth";

export const CRON_BUDGET_MS = 50_000;
const STEP_MIN_MS = 3_000;

export type CronAuth = "ok" | "unauthorized" | "unconfigured";

export type SyncTarget = BackgroundTarget & {
  granola: UserActor | null;
  clickup?: UserActor | null;
};

export type StepContext = { deadline: number; fetchImpl?: typeof fetch };

export type SyncStep = {
  name: string;
  minMs?: number;
  applies: (target: SyncTarget) => boolean;
  run: (target: SyncTarget, context: StepContext) => Promise<object>;
};

export type StepReport = { ok: boolean; skipped?: string; error?: string } & Record<string, unknown>;

export type CronReport = {
  startedAt: string;
  durationMs: number;
  errors: number;
  granolaError?: string;
  workspaces: { workspaceId: string; userId: string; steps: Record<string, StepReport> }[];
};

export function cronAuthorization(
  header: string | null,
  secret = process.env.CRON_SECRET?.trim(),
): CronAuth {
  if (!secret) return "unconfigured";
  if (!header) return "unauthorized";
  return safeEqual(header.trim(), `Bearer ${secret}`) ? "ok" : "unauthorized";
}

function microsoftStep(target: SyncTarget) {
  return target.mailbox && microsoftConfigured();
}

export const DEFAULT_STEPS: SyncStep[] = [
  {
    name: "mail",
    minMs: 15_000,
    applies: microsoftStep,
    run: (target, context) => syncMailbox(target.actor, context.fetchImpl ?? fetch),
  },
  {
    name: "calls",
    applies: microsoftStep,
    run: (target, context) =>
      syncCalls(target.actor, { fetchImpl: context.fetchImpl, deadline: context.deadline }),
  },
  {
    name: "calendar",
    applies: microsoftStep,
    run: (target, context) =>
      syncCalendar(target.actor, { fetchImpl: context.fetchImpl, deadline: context.deadline }),
  },
  {
    name: "teams_transcripts",
    applies: microsoftStep,
    run: (target, context) =>
      syncTeamsTranscripts(target.actor, {
        fetchImpl: context.fetchImpl,
        deadline: context.deadline,
      }),
  },
  {
    name: "teams_subscription",
    applies: microsoftStep,
    run: (target, context) =>
      ensureTranscriptSubscription(target.actor, {
        fetchImpl: context.fetchImpl,
        deadline: context.deadline,
      }),
  },
  {
    name: "granola",
    applies: (target) => Boolean(target.granola),
    run: (target, context) =>
      syncGranola({
        actor: target.granola ?? target.actor,
        fetchImpl: context.fetchImpl,
        deadline: context.deadline,
      }),
  },
  {
    name: "clickup",
    applies: (target) => Boolean(target.clickup),
    run: (target, context) =>
      syncClickUp({
        actor: target.clickup ?? target.actor,
        fetchImpl: context.fetchImpl,
        deadline: context.deadline,
      }),
  },
  {
    name: "summaries",
    applies: (target) => target.mailbox || Boolean(target.granola),
    run: async (target, context) => ({
      summarised: await summarisePendingImports(target.actor, {
        fetchImpl: context.fetchImpl,
        deadline: context.deadline,
      }),
    }),
  },
];

export async function syncTargets(options: { fetchImpl?: typeof fetch } = {}) {
  const targets = await backgroundTargets();
  let granola: UserActor | null = null;
  let granolaError: string | undefined;
  const apiKey = granolaApiKey();
  if (apiKey && targets.length > 0) {
    try {
      granola = await resolveGranolaActor(
        granolaClient({ apiKey, fetchImpl: options.fetchImpl }),
        apiKey,
        targets,
      );
    } catch (error) {
      granolaError = errorText(error, "Could not reach Granola.");
    }
  }
  let assigned = false;
  const clickupDone = new Set<string>();
  const list: SyncTarget[] = [];
  for (const target of targets) {
    const mine = !assigned && granola && granola.workspaceId === target.actor.workspaceId;
    if (mine) assigned = true;
    let clickup: UserActor | null = null;
    if (!clickupDone.has(target.actor.workspaceId)) {
      clickupDone.add(target.actor.workspaceId);
      try {
        clickup = await clickupActorFor(target.members);
      } catch (error) {
        console.error("ClickUp target lookup failed", error);
      }
    }
    const entry = { ...target, granola: mine ? granola : null, clickup };
    if (entry.mailbox || entry.granola || entry.clickup) list.push(entry);
  }
  return { targets: list, granolaError };
}

export async function runScheduledSync(
  options: {
    steps?: SyncStep[];
    targets?: SyncTarget[];
    budgetMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<CronReport> {
  const started = Date.now();
  const deadline = started + (options.budgetMs ?? CRON_BUDGET_MS);
  const steps = options.steps ?? DEFAULT_STEPS;
  let granolaError: string | undefined;
  let targets = options.targets;
  if (!targets) {
    const resolved = await syncTargets({ fetchImpl: options.fetchImpl });
    targets = resolved.targets;
    granolaError = resolved.granolaError;
  }
  const report: CronReport = {
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    errors: granolaError ? 1 : 0,
    ...(granolaError ? { granolaError } : {}),
    workspaces: [],
  };
  for (const target of targets) {
    const entry = {
      workspaceId: target.actor.workspaceId,
      userId: target.actor.userId,
      steps: {} as Record<string, StepReport>,
    };
    report.workspaces.push(entry);
    for (const step of steps) {
      if (!step.applies(target)) continue;
      if (deadline - Date.now() < (step.minMs ?? STEP_MIN_MS)) {
        entry.steps[step.name] = { ok: false, skipped: "Out of time for this run." };
        continue;
      }
      try {
        const outcome = (await step.run(target, {
          deadline,
          fetchImpl: options.fetchImpl,
        })) as Record<string, unknown>;
        const error = typeof outcome.error === "string" ? outcome.error : undefined;
        entry.steps[step.name] = { ...outcome, ok: !error };
        if (error) report.errors += 1;
      } catch (error) {
        console.error(`Scheduled ${step.name} sync failed`, error);
        entry.steps[step.name] = { ok: false, error: errorText(error, "The step failed.") };
        report.errors += 1;
      }
    }
  }
  report.durationMs = Date.now() - started;
  return report;
}

export async function handleCronRequest(
  request: Request,
  run: () => Promise<CronReport> = () => runScheduledSync(),
) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") {
    return Response.json({ error: "Set CRON_SECRET to turn on scheduled sync." }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  return Response.json(await run());
}
