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
import { syncMail } from "@/lib/mail/sync";
import { ensureTranscriptSubscription, syncTeamsTranscripts } from "@/lib/crm/teams-transcripts";
import type { UserActor } from "@/lib/crm/types";
import { granolaApiKey, granolaClient } from "@/lib/granola";
import { query } from "@/lib/db/pool";
import { runWebSignals, webChecksConfigured } from "@/lib/enrichment/web-checks";
import { microsoftConfigured } from "@/lib/microsoft/oauth";
import { syncReaderToKnowledge } from "@/lib/readwise/sync";

const CRON_BUDGET_MS = 50_000;
const STEP_MIN_MS = 3_000;

type CronAuth = "ok" | "unauthorized" | "unconfigured";

export type SyncTarget = BackgroundTarget & {
  granola: UserActor | null;
  clickup?: UserActor | null;
  personalGranola?: boolean;
  readwise?: boolean;
};

type StepContext = { deadline: number; fetchImpl?: typeof fetch };

type SyncStep = {
  name: string;
  minMs?: number;
  oncePerWorkspace?: boolean;
  applies: (target: SyncTarget) => boolean;
  run: (target: SyncTarget, context: StepContext) => Promise<object>;
};

type StepReport = { ok: boolean; skipped?: string; error?: string } & Record<string, unknown>;

type CronReport = {
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

function calendarStep(target: SyncTarget) {
  return ((target.mailbox || Boolean(target.calendarAccounts)) && microsoftConfigured()) || Boolean(target.calendarFeeds);
}

export const DEFAULT_STEPS: SyncStep[] = [
  {
    name: "mail",
    minMs: 15_000,
    applies: microsoftStep,
    run: (target, context) => syncMailbox(target.actor, context.fetchImpl ?? fetch),
  },
  {
    name: "mail_store",
    minMs: 10_000,
    applies: (target) => (target.mailbox || Boolean(target.calendarAccounts)) && microsoftConfigured(),
    run: (target, context) =>
      syncMail(target.actor, { deadline: Math.min(context.deadline, Date.now() + 15_000), fetchImpl: context.fetchImpl, backfill: false }),
  },
  {
    name: "calls",
    applies: microsoftStep,
    run: (target, context) =>
      syncCalls(target.actor, { fetchImpl: context.fetchImpl, deadline: context.deadline }),
  },
  {
    name: "calendar",
    applies: calendarStep,
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
    applies: (target) => Boolean(target.granola) || Boolean(target.personalGranola),
    run: (target, context) =>
      syncGranola({
        actor: target.personalGranola ? target.actor : (target.granola ?? target.actor),
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
    name: "readwise",
    minMs: 8_000,
    applies: (target) => Boolean(target.readwise),
    run: (target, context) =>
      syncReaderToKnowledge(target.actor, { fetchImpl: context.fetchImpl, deadline: Math.min(context.deadline, Date.now() + 12_000) }),
  },
  {
    name: "summaries",
    applies: (target) => target.mailbox || Boolean(target.granola) || Boolean(target.personalGranola),
    run: async (target, context) => ({
      summarised: await summarisePendingImports(target.actor, {
        fetchImpl: context.fetchImpl,
        deadline: context.deadline,
      }),
    }),
  },
  {
    name: "web_signals",
    minMs: 10_000,
    oncePerWorkspace: true,
    applies: () => webChecksConfigured(),
    run: (target, context) => runWebSignals(target.actor, { deadline: Math.min(context.deadline, Date.now() + 8_000), fetchImpl: context.fetchImpl }),
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
  const keyedRows = (
    await query<{ workspace_id: string; user_id: string }>("select * from private.granola_key_members()").catch(() => ({ rows: [] }))
  ).rows;
  const readerRows = (
    await query<{ workspace_id: string; user_id: string }>("select * from private.readwise_key_members()").catch(() => ({ rows: [] }))
  ).rows;
  const memberKey = (actor: UserActor) => `${actor.workspaceId}:${actor.userId}`;
  const keyed = new Set(keyedRows.map((row) => `${row.workspace_id}:${row.user_id}`));
  const reader = new Set(readerRows.map((row) => `${row.workspace_id}:${row.user_id}`));
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
    const entry: SyncTarget = {
      ...target,
      granola: mine ? granola : null,
      clickup,
      personalGranola: keyed.has(memberKey(target.actor)),
      readwise: reader.has(memberKey(target.actor)),
    };
    if (entry.mailbox || entry.calendarAccounts || entry.calendarFeeds || entry.granola || entry.clickup || entry.personalGranola || entry.readwise) {
      list.push(entry);
    }
  }
  for (const row of [...keyedRows, ...readerRows]) {
    const key = `${row.workspace_id}:${row.user_id}`;
    if (list.some((entry) => memberKey(entry.actor) === key)) continue;
    const members = targets.find((target) => target.actor.workspaceId === row.workspace_id)?.members ?? [];
    const actor = members.find((member) => member.userId === row.user_id);
    if (actor) list.push({ actor, mailbox: false, members, granola: null, clickup: null, personalGranola: keyed.has(key), readwise: reader.has(key) });
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
  const ranOnce = new Set<string>();
  for (const target of targets) {
    const entry = {
      workspaceId: target.actor.workspaceId,
      userId: target.actor.userId,
      steps: {} as Record<string, StepReport>,
    };
    report.workspaces.push(entry);
    for (const step of steps) {
      if (!step.applies(target)) continue;
      const onceKey = `${step.name}:${target.actor.workspaceId}`;
      if (step.oncePerWorkspace && ranOnce.has(onceKey)) continue;
      if (deadline - Date.now() < (step.minMs ?? STEP_MIN_MS)) {
        entry.steps[step.name] = { ok: false, skipped: "Out of time for this run." };
        continue;
      }
      if (step.oncePerWorkspace) ranOnce.add(onceKey);
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
  const report = await run();
  try {
    const { deliverDueWebhooks } = await import("@/lib/crm/webhooks");
    await deliverDueWebhooks();
  } catch (error) {
    console.error("Webhook retry failed", error);
  }
  try {
    const { sweepEmailAttachments } = await import("@/lib/crm/email-attachments");
    await sweepEmailAttachments();
  } catch (error) {
    console.error("Attachment sweep failed", error);
  }
  try {
    const { sweepChatFiles } = await import("@/lib/assistant/files");
    await sweepChatFiles();
  } catch (error) {
    console.error("Chat file sweep failed", error);
  }
  try {
    const { backfillCallHealth } = await import("@/lib/crm/call-health");
    await backfillCallHealth({ budgetMs: 12_000 });
  } catch (error) {
    console.error("Call health backfill failed", error);
  }
  try {
    const { runWorkflowTick } = await import("@/lib/workflows/engine");
    await runWorkflowTick({ budgetMs: 8_000 });
  } catch (error) {
    console.error("Workflow tick failed", error);
  }
  return Response.json(report);
}
