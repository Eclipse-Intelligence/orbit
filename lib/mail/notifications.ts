import { after } from "next/server";
import { memberActor, safeEqual } from "@/lib/crm/conversations";
import { withActor } from "@/lib/crm/context";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { classifyCapture } from "@/lib/mail/capture-filter";
import { prepareMail } from "@/lib/mail/prepare";
import { syncNotifiedMailboxes } from "@/lib/mail/sync";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { graphNotices, graphValidation, type GraphNotice } from "@/lib/microsoft/notifications";

const BUDGET_MS = 55_000;
const SHORTEST_SYNC_MS = 3_000;

type SourceOwnerRow = {
  subscription_id: string;
  source_id: string;
  client_state: string | null;
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

export type MailTarget = { actor: UserActor; sourceIds: string[]; removed: string[]; renew: string[] };

type Schedule = (task: () => Promise<unknown>) => void;

type Options = {
  fetchImpl?: typeof fetch;
  deadline?: number;
  schedule?: Schedule;
  pollMs?: number;
  afterSync?: (target: MailTarget, outcome: Awaited<ReturnType<typeof syncNotifiedMailboxes>>, deadline: number) => Promise<void>;
};

function left(deadline: number) {
  return deadline - Date.now();
}

export async function mailTargets(notices: GraphNotice[]) {
  const ids = [...new Set(notices.map((notice) => notice.subscriptionId))];
  if (ids.length === 0) return [];
  const owners = await query<SourceOwnerRow>("select * from private.mail_subscription_sources($1::text[])", [ids]);
  const bySubscription = new Map(owners.rows.map((row) => [row.subscription_id, row]));
  const targets = new Map<string, MailTarget>();
  for (const notice of notices) {
    const owner = bySubscription.get(notice.subscriptionId);
    if (!owner?.client_state || !safeEqual(notice.clientState, owner.client_state)) continue;
    const key = owner.user_id;
    const target = targets.get(key) ?? { actor: memberActor(owner), sourceIds: [], removed: [], renew: [] };
    if (!target.sourceIds.includes(owner.source_id)) target.sourceIds.push(owner.source_id);
    if (notice.lifecycleEvent === "subscriptionRemoved") target.removed.push(owner.source_id);
    if (notice.lifecycleEvent === "reauthorizationRequired") target.renew.push(owner.source_id);
    targets.set(key, target);
  }
  return [...targets.values()];
}

async function prepareForRenewal(target: MailTarget) {
  if (target.removed.length === 0 && target.renew.length === 0) return;
  await withActor(target.actor, async (db) => {
    if (target.removed.length > 0) {
      await db.query(
        "update crm.mail_sources set graph_subscription_id = null, graph_subscription_expires_at = null where user_id = $1 and id = any($2::uuid[])",
        [target.actor.userId, target.removed],
      );
    }
    if (target.renew.length > 0) {
      await db.query("update crm.mail_sources set graph_subscription_expires_at = now() where user_id = $1 and id = any($2::uuid[])", [
        target.actor.userId,
        target.renew,
      ]);
    }
  });
}

async function followUp(target: MailTarget, outcome: Awaited<ReturnType<typeof syncNotifiedMailboxes>>, deadline: number) {
  if (outcome.unreached.length > 0) console.error("Mail webhook couldn't reach every mailbox", outcome.unreached.length);
  if (outcome.workflowEvents > 0 && left(deadline) > SHORTEST_SYNC_MS) {
    await runWorkflowTick({ budgetMs: Math.min(15_000, left(deadline)) }).catch((error) => console.error("Workflow tick failed", error));
  }
  if (outcome.stored > 0 && left(deadline) > SHORTEST_SYNC_MS) {
    await prepareMail(target.actor, { deadline: Math.min(deadline, Date.now() + 30_000) }).catch((error) => console.error("Preparing mail failed", error));
  }
  if (outcome.stored > 0 && left(deadline) > SHORTEST_SYNC_MS) {
    await classifyCapture(target.actor, { deadline: Math.min(deadline, Date.now() + 10_000) }).catch((error) =>
      console.error("Sorting Capture email failed", error instanceof Error ? error.message : error),
    );
  }
}

export async function processMailTargets(targets: MailTarget[], deadline: number, options: Options = {}) {
  for (const target of targets) {
    if (left(deadline) < SHORTEST_SYNC_MS) break;
    try {
      await prepareForRenewal(target);
      const outcome = await syncNotifiedMailboxes(target.actor, target.sourceIds, { deadline, fetchImpl: options.fetchImpl, pollMs: options.pollMs });
      await (options.afterSync ?? followUp)(target, outcome, deadline);
    } catch (error) {
      console.error("Mail webhook sync failed", error);
    }
  }
}

function background(task: () => Promise<unknown>) {
  after(async () => {
    try {
      await task();
    } catch (error) {
      console.error("Mail webhook sync failed", error);
    }
  });
}

export async function handleMailNotifications(request: Request, options: Options = {}) {
  const validation = graphValidation(request);
  if (validation) return validation;
  const notices = await graphNotices(request);
  if (notices === null) return new Response(null, { status: 400 });
  if (notices.length > 0) {
    const deadline = options.deadline ?? Date.now() + BUDGET_MS;
    (options.schedule ?? background)(async () => processMailTargets(await mailTargets(notices), deadline, options));
  }
  return new Response(null, { status: 202 });
}
