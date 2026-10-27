import { after } from "next/server";
import type { UserActor } from "@/lib/crm/types";
import { indexKnowledgeItem, type IndexOptions } from "@/lib/knowledge/indexing";
import { isStale, type KnowledgeItem } from "@/lib/knowledge/store";

const BUDGET_MS = 280_000;

export function scheduleIndexing(actor: UserActor, ids: string[], options: Omit<IndexOptions, "deadline"> = {}) {
  if (ids.length === 0) return;
  const run = async () => {
    const deadline = Date.now() + BUDGET_MS;
    for (const id of ids) {
      if (Date.now() > deadline - 30_000) break;
      await indexKnowledgeItem(actor, id, { ...options, deadline }).catch((error) => console.error("Knowledge indexing failed", error));
    }
  };
  try {
    after(run);
  } catch {}
}

export function resumeStale(actor: UserActor, items: KnowledgeItem[]) {
  scheduleIndexing(
    actor,
    items.filter((item) => isStale(item)).slice(0, 3).map((item) => item.id),
  );
}
