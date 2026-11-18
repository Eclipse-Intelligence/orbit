import { after } from "next/server";
import { memberActor } from "@/lib/crm/conversations";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { classifyCapture } from "@/lib/mail/capture-filter";
import { prepareMail } from "@/lib/mail/prepare";
import { syncNotifiedMailboxes } from "@/lib/mail/sync";
import { runWorkflowTick } from "@/lib/workflows/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Notice = { subscriptionId?: unknown; clientState?: unknown };

type Target = { actor: UserActor; sourceIds: string[] };

const BUDGET_MS = 55_000;
const SHORTEST_SYNC_MS = 3_000;

function left(deadline: number) {
  return deadline - Date.now();
}

async function targetsFor(pairs: [string, string][]) {
  const targets = new Map<string, Target>();
  for (const [subscriptionId, clientState] of pairs) {
    const owners = await query<Parameters<typeof memberActor>[0]>("select * from private.mail_subscription_owner($1, $2)", [subscriptionId, clientState]);
    const owner = owners.rows[0];
    if (!owner) continue;
    const actor = memberActor(owner);
    const sources = await withActor(actor, (db) =>
      db.query<{ id: string }>("select id from crm.mail_sources where graph_subscription_id = $1 and user_id = $2", [subscriptionId, actor.userId]),
    );
    const key = `${actor.userId}:${actor.workspaceId}`;
    const target = targets.get(key) ?? { actor, sourceIds: [] };
    for (const row of sources.rows) if (!target.sourceIds.includes(row.id)) target.sourceIds.push(row.id);
    targets.set(key, target);
  }
  return [...targets.values()].filter((target) => target.sourceIds.length > 0);
}

async function syncTarget({ actor, sourceIds }: Target, deadline: number) {
  const { stored, workflowEvents, unreached } = await syncNotifiedMailboxes(actor, sourceIds, { deadline });
  if (unreached.length > 0) console.error("Mail webhook couldn't reach every mailbox", unreached.length);
  if (workflowEvents > 0 && left(deadline) > SHORTEST_SYNC_MS) {
    await runWorkflowTick({ budgetMs: Math.min(15_000, left(deadline)) }).catch((error) => console.error("Workflow tick failed", error));
  }
  if (stored > 0 && left(deadline) > SHORTEST_SYNC_MS) {
    await prepareMail(actor, { deadline: Math.min(deadline, Date.now() + 30_000) }).catch((error) => console.error("Preparing mail failed", error));
  }
  if (stored > 0 && left(deadline) > SHORTEST_SYNC_MS) {
    await classifyCapture(actor, { deadline: Math.min(deadline, Date.now() + 10_000) }).catch((error) =>
      console.error("Sorting Capture email failed", error instanceof Error ? error.message : error),
    );
  }
}

export async function POST(request: Request) {
  const validation = new URL(request.url).searchParams.get("validationToken");
  if (validation) return new Response(validation, { headers: { "content-type": "text/plain" } });
  const body = (await request.json().catch(() => ({}))) as { value?: Notice[] };
  const pairs = new Map<string, string>();
  for (const notice of body.value ?? []) {
    if (typeof notice.subscriptionId === "string" && typeof notice.clientState === "string" && notice.clientState.length <= 100) {
      pairs.set(notice.subscriptionId.slice(0, 200), notice.clientState);
    }
  }
  if (pairs.size > 0) {
    const deadline = Date.now() + BUDGET_MS;
    after(async () => {
      try {
        for (const target of await targetsFor([...pairs].slice(0, 10))) {
          if (left(deadline) < SHORTEST_SYNC_MS) break;
          try {
            await syncTarget(target, deadline);
          } catch (error) {
            console.error("Mail webhook sync failed", error);
          }
        }
      } catch (error) {
        console.error("Mail webhook sync failed", error);
      }
    });
  }
  return new Response(null, { status: 202 });
}
