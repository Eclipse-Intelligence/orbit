import { after } from "next/server";
import type { UserActor } from "@/lib/crm/types";
import { backfillCalls } from "@/lib/knowledge/calls";
import { indexKnowledgeItem, type IndexOptions } from "@/lib/knowledge/indexing";
import { isStale, type KnowledgeItem } from "@/lib/knowledge/store";

const BUDGET_MS = 280_000;

export function scheduleIndexing(actor: UserActor, ids: string[], options: Omit<IndexOptions, "deadline"> = {}) {
  if (ids.length === 0) return;
  try {
    after(() => indexAll(actor, ids, options));
  } catch {}
}

async function indexAll(actor: UserActor, ids: string[], options: Omit<IndexOptions, "deadline">) {
  const deadline = Date.now() + BUDGET_MS;
  for (const id of ids) {
    if (Date.now() > deadline - 30_000) break;
    await indexKnowledgeItem(actor, id, { ...options, deadline }).catch((error) => console.error("Knowledge indexing failed", error));
  }
}

export function scheduleCallBackfill(actor: UserActor, companyId: string) {
  try {
    after(async () => {
      try {
        await indexAll(actor, await backfillCalls(actor, companyId), {});
      } catch (error) {
        console.error("Call backfill failed", error);
      }
    });
  } catch {}
}

const RUNNERS = 2;
const RESUME_BATCH = 25;

export function resumeStale(actor: UserActor, items: KnowledgeItem[]) {
  const stale = items.filter((item) => isStale(item));
  const running = items.filter((item) => item.status === "indexing" && !isStale(item)).length;
  const waiting = running < RUNNERS ? items.filter((item) => item.status === "pending" && item.kind !== "file" && !isStale(item)).reverse() : [];
  scheduleIndexing(actor, [...stale, ...waiting].slice(0, RESUME_BATCH).map((item) => item.id));
}
