import { after } from "next/server";
import { commitBatch } from "@/lib/crm/after-commit";
import type { Db } from "@/lib/db/pool";

const RUN_MS = 25_000;

async function run(reminderIds: string[]) {
  if (reminderIds.length === 0) return;
  try {
    const { syncReminderBlocks } = await import("@/lib/crm/reminder-outlook");
    await syncReminderBlocks({ reminderIds, deadline: Date.now() + RUN_MS });
  } catch (error) {
    console.error("Outlook reminder blocks failed", error);
  }
}

export function queueReminderBlock(db: Db, reminderId: string) {
  const batch = commitBatch<Set<string> | null>(db, "reminder-blocks", () => {
    const ids = new Set<string>();
    try {
      after(() => run([...ids]));
    } catch {
      return null;
    }
    return ids;
  });
  batch?.add(reminderId);
}
