import { after } from "next/server";
import { memberActor } from "@/lib/crm/conversations";
import { query } from "@/lib/db/pool";
import { prepareMail } from "@/lib/mail/prepare";
import { syncMail } from "@/lib/mail/sync";
import { runWorkflowTick } from "@/lib/workflows/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Notice = { subscriptionId?: unknown; clientState?: unknown };

const RETRIES = 3;
const RETRY_MS = 4_000;

async function syncOwner(subscriptionId: string, clientState: string) {
  const owners = await query<Parameters<typeof memberActor>[0]>("select * from private.mail_subscription_owner($1, $2)", [subscriptionId, clientState]);
  const owner = owners.rows[0];
  if (!owner) return;
  const actor = memberActor(owner);
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const report = await syncMail(actor, { budgetMs: 15_000, backfill: false });
    if (report.sources > 0) {
      if (report.workflowEvents > 0) await runWorkflowTick({ budgetMs: 15_000 }).catch((error) => console.error("Workflow tick failed", error));
      if (report.stored > 0) await prepareMail(actor, { deadline: Date.now() + 30_000 }).catch((error) => console.error("Preparing mail failed", error));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
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
    after(async () => {
      for (const [subscriptionId, clientState] of [...pairs].slice(0, 10)) {
        try {
          await syncOwner(subscriptionId, clientState);
        } catch (error) {
          console.error("Mail webhook sync failed", error);
        }
      }
    });
  }
  return new Response(null, { status: 202 });
}
