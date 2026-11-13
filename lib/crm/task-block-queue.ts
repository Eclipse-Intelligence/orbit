import { after } from "next/server";
import { commitBatch } from "@/lib/crm/after-commit";
import type { Db } from "@/lib/db/pool";

const RUN_MS = 25_000;

async function run(taskIds: string[]) {
  if (taskIds.length === 0) return;
  try {
    const { syncTaskBlocks } = await import("@/lib/crm/task-outlook");
    await syncTaskBlocks({ taskIds, deadline: Date.now() + RUN_MS });
  } catch (error) {
    console.error("Outlook task blocks failed", error);
  }
}

export function queueTaskBlock(db: Db, taskId: string) {
  const batch = commitBatch<Set<string> | null>(db, "task-blocks", () => {
    const ids = new Set<string>();
    try {
      after(() => run([...ids]));
    } catch {
      return null;
    }
    return ids;
  });
  batch?.add(taskId);
}
