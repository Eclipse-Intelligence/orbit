import { after } from "next/server";
import { memberActor, safeEqual } from "@/lib/crm/conversations";
import { withActor } from "@/lib/crm/context";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { classifyCapture } from "@/lib/mail/capture-filter";
import { prepareMail } from "@/lib/mail/prepare";
import { ECHO_WINDOW_MS, noteMailChanges, syncNotifiedMailboxes, type MailChange } from "@/lib/mail/sync";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { graphNotices, graphValidation, type GraphChangeType, type GraphNotice } from "@/lib/microsoft/notifications";

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

type SourceNotices = {
  full: boolean;
  removed: boolean;
  renew: boolean;
  messages: { id: string; changeType: GraphChangeType | null }[];
};

export type MailTarget = { actor: UserActor; sources: Map<string, SourceNotices> };

type Outcome = Awaited<ReturnType<typeof syncNotifiedMailboxes>>;

type Schedule = (task: () => Promise<unknown>) => void;

type Options = {
  fetchImpl?: typeof fetch;
  deadline?: number;
  schedule?: Schedule;
  pollMs?: number;
  afterSync?: (target: MailTarget, outcome: Outcome, deadline: number) => Promise<void>;
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
    const target = targets.get(owner.user_id) ?? { actor: memberActor(owner), sources: new Map<string, SourceNotices>() };
    const source = target.sources.get(owner.source_id) ?? { full: false, removed: false, renew: false, messages: [] };
    if (notice.lifecycleEvent === "subscriptionRemoved") {
      source.removed = true;
      source.full = true;
    } else if (notice.lifecycleEvent === "reauthorizationRequired") source.renew = true;
    else if (notice.lifecycleEvent === "missed" || !notice.messageId) source.full = true;
    else source.messages.push({ id: notice.messageId, changeType: notice.changeType });
    target.sources.set(owner.source_id, source);
    targets.set(owner.user_id, target);
  }
  return [...targets.values()];
}

async function planChanges(target: MailTarget): Promise<MailChange[]> {
  return withActor(target.actor, async (db) => {
    const changes: MailChange[] = [];
    for (const [sourceId, notices] of target.sources) {
      if (notices.removed) {
        await db.query("update crm.mail_sources set graph_subscription_id = null, graph_subscription_expires_at = null where user_id = $1 and id = $2", [
          target.actor.userId,
          sourceId,
        ]);
      }
      if (notices.renew) {
        await db.query("update crm.mail_sources set graph_subscription_expires_at = now() where user_id = $1 and id = $2", [target.actor.userId, sourceId]);
      }
      const ids = notices.full ? [] : [...new Set(notices.messages.map((message) => message.id))];
      const echoes = ids.length
        ? await db.query<{ provider_message_id: string }>(
            `select provider_message_id from crm.mail_echoes
             where user_id = $1 and source_id = $2 and provider_message_id = any($3::text[])
               and changed_at > now() - make_interval(secs => $4)`,
            [target.actor.userId, sourceId, ids, ECHO_WINDOW_MS / 1000],
          )
        : { rows: [] };
      const known = ids.length
        ? await db.query<{ provider_message_id: string; folder_id: string }>(
            "select provider_message_id, folder_id from crm.mail_messages where user_id = $1 and source_id = $2 and provider_message_id = any($3::text[])",
            [target.actor.userId, sourceId, ids],
          )
        : { rows: [] };
      const echoed = new Set(echoes.rows.map((row) => row.provider_message_id));
      const folderOf = new Map(known.rows.map((row) => [row.provider_message_id, row.folder_id]));
      const folderIds = new Set<string>();
      const lookups = new Set<string>();
      for (const message of notices.messages) {
        if (notices.full || echoed.has(message.id)) continue;
        const folder = folderOf.get(message.id);
        if (folder) folderIds.add(folder);
        else if (message.changeType !== "deleted") lookups.add(message.id);
      }
      const change: MailChange = { sourceId, full: notices.full, folderIds: [...folderIds], lookups: [...lookups] };
      if (change.full || change.folderIds.length > 0 || change.lookups.length > 0 || notices.renew) changes.push(change);
    }
    return changes;
  });
}

async function followUp(target: MailTarget, outcome: Outcome, deadline: number) {
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
      const changes = await planChanges(target);
      if (changes.length === 0) continue;
      await noteMailChanges(target.actor, changes);
      const outcome = await syncNotifiedMailboxes(
        target.actor,
        changes.map((change) => change.sourceId),
        { deadline, fetchImpl: options.fetchImpl, pollMs: options.pollMs, noted: true },
      );
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
